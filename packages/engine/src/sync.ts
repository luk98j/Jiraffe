import {
  createHttpJiraClient,
  buildJql,
  fetchAllIssues,
  JiraError,
  type JiraClient,
  type JiraComment,
  type JiraIssue,
} from '@jiraffe/jira';
import {
  getTaskDto,
  hasFinishedAnalysis,
  insertJournal,
  insertMessage,
  listCommentSyncTasks,
  listIgnoredJiraKeys,
  listJiraCommentIds,
  listJiraTasks,
  markClosedInJira,
  updateTaskFields,
  type Tx,
} from '@jiraffe/db';
import { write, type Ctx, type Outbox } from './context.ts';
import { createTask } from './createTask.ts';
import { getSetting } from './settings.ts';
import { applyTransition } from './transition.ts';

export type SyncOutcome =
  | { outcome: 'ok'; result: string }
  | { outcome: 'skipped' }
  | { outcome: 'not_configured' }
  | { outcome: 'error'; message: string };

/** Resolves the Jira client; throws a readable Error when credentials are missing. */
function resolveClient(ctx: Ctx): JiraClient {
  if (ctx.jiraClient) return ctx.jiraClient;
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_API_TOKEN;
  if (!email || !token)
    throw new Error('Jira credentials are not set (JIRA_EMAIL and JIRA_API_TOKEN)');
  return createHttpJiraClient({ baseUrl: getSetting(ctx, 'jira_base_url'), email, token });
}

const UNEXPECTED = 'Sync failed unexpectedly';

/** Messages shown to the user never come from raw errors, so they cannot carry secrets. */
function safeMessage(err: unknown): string {
  if (err instanceof JiraError) return err.message;
  if (err instanceof Error && err.message.startsWith('Jira credentials are not set'))
    return err.message;
  return UNEXPECTED;
}

type Kind = 'task' | 'comment';
const LABEL: Record<Kind, string> = { task: 'Jira task sync', comment: 'Jira comment sync' };
const outcomeKey = (action: string, detail: string) => `${action}: ${detail}`;

/** What a sync job reports: the result text, extra log-only text, and whether it wrote its sync_run row. */
interface JobResult {
  result: string;
  extra: string;
  journaled: boolean;
}

/**
 * Journals a successful sync inside the job's transaction. A row is written when something changed,
 * or when the outcome differs from the last journaled one of this kind. Returns whether it wrote.
 */
function recordSyncRun(
  ctx: Ctx,
  tx: Tx,
  outbox: Outbox,
  kind: Kind,
  detail: string,
  changed: boolean,
): boolean {
  if (!changed && outcomeKey('sync_run', detail) === ctx.sync.lastJournaled[kind]) return false;
  insertJournal(tx, { at: ctx.clock().toISOString(), action: 'sync_run', detail });
  outbox.changed();
  return true;
}

/**
 * Journals a failed or skipped sync, unless it repeats the last journaled outcome of this kind.
 * Never throws: a journal failure is logged and the sync outcome stays as it was.
 */
function journalOutcome(
  ctx: Ctx,
  kind: Kind,
  action: 'sync_failed' | 'sync_skipped',
  detail: string,
): void {
  const key = outcomeKey(action, detail);
  if (ctx.sync.lastJournaled[kind] === key) return;
  try {
    write(ctx, (tx, outbox) => {
      insertJournal(tx, { at: ctx.clock().toISOString(), action, detail });
      outbox.changed();
    });
    ctx.sync.lastJournaled[kind] = key;
  } catch (err) {
    try {
      ctx.logger.error('Could not write the sync outcome to the journal', err);
    } catch {
      // The logger itself failed; nothing more to do.
    }
  }
}

/**
 * Runs `job` as the single in-flight sync (shared by task and comment sync).
 * A trigger while another sync runs is skipped, never queued.
 * Every outcome is logged; failed and skipped outcomes are also journaled here.
 */
export async function exclusiveSync(
  ctx: Ctx,
  kind: Kind,
  job: () => Promise<JobResult>,
): Promise<SyncOutcome> {
  const s = ctx.sync;
  const label = LABEL[kind];
  if (!getSetting(ctx, 'jira_base_url')) {
    s.state = { ...s.state, state: 'not_configured', lastError: null };
    ctx.logger.info(`${label} did not run: jira_base_url is not set`);
    journalOutcome(ctx, kind, 'sync_skipped', 'Jira not configured: jira_base_url is empty');
    return { outcome: 'not_configured' };
  }
  if (s.inFlight) {
    s.state = { ...s.state, lastSkippedAt: ctx.clock().toISOString() };
    ctx.logger.info(`${label} skipped: another sync is running`);
    journalOutcome(ctx, kind, 'sync_skipped', 'another sync is running');
    return { outcome: 'skipped' };
  }
  s.inFlight = true;
  s.state = { ...s.state, state: 'running' };
  ctx.logger.info(`${label} started`);
  try {
    const { result, extra, journaled } = await job();
    if (journaled) s.lastJournaled[kind] = outcomeKey('sync_run', result);
    s.state = {
      ...s.state,
      state: 'idle',
      lastRunAt: ctx.clock().toISOString(),
      lastError: null,
      lastResult: result,
    };
    ctx.logger.info(`${label} finished: ${result}; ${extra}`);
    ctx.bus.emitChanged();
    return { outcome: 'ok', result };
  } catch (err) {
    const message = safeMessage(err);
    s.state = { ...s.state, state: 'error', lastError: message };
    // The raw error is never logged: it can carry credentials. Only the safe message and the class name.
    const cls = err instanceof Error ? err.constructor.name : typeof err;
    const unexpected = message === UNEXPECTED ? ` (${cls})` : '';
    ctx.logger.error(`${label} failed: ${message}${unexpected}`);
    journalOutcome(ctx, kind, 'sync_failed', message);
    ctx.bus.emitChanged();
    return { outcome: 'error', message };
  } finally {
    s.inFlight = false;
  }
}

const isClosed = (i: JiraIssue, ignored: string[]) =>
  i.statusCategory === 'done' || ignored.includes(i.statusName);

export function runTaskSync(ctx: Ctx): Promise<SyncOutcome> {
  return exclusiveSync(ctx, 'task', async () => {
    const client = resolveClient(ctx);
    const ignoredStatuses = getSetting(ctx, 'jira_ignored_statuses');
    const jql = buildJql({ ignoredStatuses, projects: getSetting(ctx, 'jira_projects') });

    // Phase 1: fetch only, no database writes.
    const byKey = new Map<string, JiraIssue>();
    const returned = await fetchAllIssues(client, jql);
    for (const i of returned) if (!byKey.has(i.key)) byKey.set(i.key, i);
    const missing = listJiraTasks(ctx.db)
      .filter((t) => !t.deletedAt && !t.jiraClosed && !byKey.has(t.jiraKey))
      .map((t) => t.jiraKey);
    if (missing.length > 0) {
      for (const i of await client.getIssues(missing)) if (!byKey.has(i.key)) byKey.set(i.key, i);
    }

    // Phase 2: apply everything in one transaction.
    const repoMap = getSetting(ctx, 'repo_map');
    const result = write(ctx, (tx, outbox) => {
      const now = ctx.clock().toISOString();
      const existing = new Map(listJiraTasks(tx).map((t) => [t.jiraKey, t]));
      const tombstones = listIgnoredJiraKeys(tx);
      let created = 0;
      let updated = 0;
      let closed = 0;
      for (const issue of byKey.values()) {
        const task = existing.get(issue.key);
        const isDone = isClosed(issue, ignoredStatuses);
        if (!task) {
          if (isDone || tombstones.has(issue.key)) continue;
          createTask(ctx, tx, outbox, {
            source: 'jira',
            jiraKey: issue.key,
            title: issue.title,
            body: issue.description ?? '',
            repoPath: repoMap[issue.projectKey] ?? null,
          });
          created++;
          continue;
        }
        if (task.deletedAt) continue;
        // biome-ignore lint/style/noNonNullAssertion: The task was read in this same transaction.
        const current = getTaskDto(tx, task.id)!;
        const body = issue.description ?? '';
        const fields: string[] = [];
        if (issue.title !== task.title) fields.push('title');
        if (body !== task.body) fields.push('body');
        if (fields.length > 0) {
          updateTaskFields(tx, task.id, {
            ...(fields.includes('title') ? { title: issue.title } : {}),
            ...(fields.includes('body') ? { body } : {}),
            flagBodyChanged: fields.includes('body') && hasFinishedAnalysis(tx, task.id),
            now,
          });
          insertJournal(tx, {
            at: now,
            taskKey: current.key,
            status: current.status,
            action: 'task_updated_from_jira',
            detail: fields.join(', '),
          });
          updated++;
        }
        if (isDone && !task.jiraClosed) {
          markClosedInJira(tx, task.id, now);
          insertJournal(tx, {
            at: now,
            taskKey: current.key,
            status: current.status,
            action: 'closed_in_jira',
          });
          closed++;
        }
      }
      const detail = `${created} new, ${updated} updated${closed > 0 ? `, ${closed} closed` : ''}; Jira returned ${returned.length} issues`;
      const journaled = recordSyncRun(
        ctx,
        tx,
        outbox,
        'task',
        detail,
        created + updated + closed > 0,
      );
      return { result: detail, journaled };
    });
    return { ...result, extra: `JQL: ${jql}` };
  });
}

export function runCommentSync(ctx: Ctx): Promise<SyncOutcome> {
  return exclusiveSync(ctx, 'comment', async () => {
    const client = resolveClient(ctx);

    // Phase 1: fetch comments, no database writes.
    const fetched: { taskId: number; comments: JiraComment[] }[] = [];
    for (const t of listCommentSyncTasks(ctx.db)) {
      fetched.push({ taskId: t.id, comments: await client.getComments(t.jiraKey) });
    }

    // Phase 2: apply in one transaction.
    const result = write(ctx, (tx, outbox) => {
      const now = ctx.clock().toISOString();
      let added = 0;
      for (const { taskId, comments } of fetched) {
        const task = getTaskDto(tx, taskId);
        if (!task || task.deletedAt) continue; // deleted since the fetch
        const known = listJiraCommentIds(tx, taskId);
        const fresh = comments.filter((c) => !known.has(c.id));
        if (fresh.length === 0) continue;
        for (const c of fresh) {
          insertMessage(tx, {
            taskId,
            role: 'user',
            source: 'jira',
            content: c.body,
            jiraCommentId: c.id,
            createdAt: c.createdAt,
          });
        }
        let status = task.status;
        if (status === 'waiting_user') {
          const r = applyTransition(ctx, tx, outbox, taskId, 'user_answered');
          if (r.changed) status = r.to;
        }
        for (let i = 0; i < fresh.length; i++) {
          insertJournal(tx, {
            at: now,
            taskKey: task.key,
            status,
            action: 'comment_added',
            detail: 'source: jira',
          });
        }
        added += fresh.length;
      }
      const detail = `comments: ${added} new`;
      return {
        result: detail,
        journaled: recordSyncRun(ctx, tx, outbox, 'comment', detail, added > 0),
      };
    });
    return { ...result, extra: `${fetched.length} tasks checked` };
  });
}
