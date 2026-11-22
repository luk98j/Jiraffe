import { createHttpJiraClient, buildJql, fetchAllIssues, JiraError, type JiraClient, type JiraComment, type JiraIssue } from '@jiraffe/jira';
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
} from '@jiraffe/db';
import { write, type Ctx } from './context.ts';
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
  if (!email || !token) throw new Error('Jira credentials are not set (JIRA_EMAIL and JIRA_API_TOKEN)');
  return createHttpJiraClient({ baseUrl: getSetting(ctx, 'jira_base_url'), email, token });
}

/** Messages shown to the user never come from raw errors, so they cannot carry secrets. */
function safeMessage(err: unknown): string {
  if (err instanceof JiraError) return err.message;
  if (err instanceof Error && err.message.startsWith('Jira credentials are not set')) return err.message;
  return 'Sync failed unexpectedly';
}

/**
 * Runs `job` as the single in-flight sync (shared by task and comment sync).
 * A trigger while another sync runs is skipped, never queued.
 */
export async function exclusiveSync(ctx: Ctx, job: () => Promise<string>): Promise<SyncOutcome> {
  const s = ctx.sync;
  if (!getSetting(ctx, 'jira_base_url')) {
    s.state = { ...s.state, state: 'not_configured', lastError: null };
    return { outcome: 'not_configured' };
  }
  if (s.inFlight) {
    s.state = { ...s.state, lastSkippedAt: ctx.clock().toISOString() };
    return { outcome: 'skipped' };
  }
  s.inFlight = true;
  s.state = { ...s.state, state: 'running' };
  try {
    const result = await job();
    s.state = { ...s.state, state: 'idle', lastRunAt: ctx.clock().toISOString(), lastError: null, lastResult: result };
    ctx.bus.emitChanged();
    return { outcome: 'ok', result };
  } catch (err) {
    const message = safeMessage(err);
    ctx.logger.error('Jira sync failed', err);
    s.state = { ...s.state, state: 'error', lastError: message };
    ctx.bus.emitChanged();
    return { outcome: 'error', message };
  } finally {
    s.inFlight = false;
  }
}

const isClosed = (i: JiraIssue, ignored: string[]) => i.statusCategory === 'done' || ignored.includes(i.statusName);

export function runTaskSync(ctx: Ctx): Promise<SyncOutcome> {
  return exclusiveSync(ctx, async () => {
    const client = resolveClient(ctx);
    const ignoredStatuses = getSetting(ctx, 'jira_ignored_statuses');
    const jql = buildJql({ ignoredStatuses, projects: getSetting(ctx, 'jira_projects') });

    // Phase 1: fetch only, no database writes.
    const byKey = new Map<string, JiraIssue>();
    for (const i of await fetchAllIssues(client, jql)) if (!byKey.has(i.key)) byKey.set(i.key, i);
    const missing = listJiraTasks(ctx.db)
      .filter((t) => !t.deletedAt && !t.jiraClosed && !byKey.has(t.jiraKey))
      .map((t) => t.jiraKey);
    if (missing.length > 0) {
      for (const i of await client.getIssues(missing)) if (!byKey.has(i.key)) byKey.set(i.key, i);
    }

    // Phase 2: apply everything in one transaction.
    const repoMap = getSetting(ctx, 'repo_map');
    return write(ctx, (tx, outbox) => {
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
          insertJournal(tx, { at: now, taskKey: current.key, status: current.status, action: 'task_updated_from_jira', detail: fields.join(', ') });
          updated++;
        }
        if (isDone && !task.jiraClosed) {
          markClosedInJira(tx, task.id, now);
          insertJournal(tx, { at: now, taskKey: current.key, status: current.status, action: 'closed_in_jira' });
          closed++;
        }
      }
      // Empty syncs are silent: no sync_run row unless something changed.
      const detail = `${created} new, ${updated} updated${closed > 0 ? `, ${closed} closed` : ''}`;
      if (created + updated + closed > 0) {
        insertJournal(tx, { at: now, action: 'sync_run', detail });
        outbox.changed();
      }
      return detail;
    });
  });
}

export function runCommentSync(ctx: Ctx): Promise<SyncOutcome> {
  return exclusiveSync(ctx, async () => {
    const client = resolveClient(ctx);

    // Phase 1: fetch comments, no database writes.
    const fetched: { taskId: number; comments: JiraComment[] }[] = [];
    for (const t of listCommentSyncTasks(ctx.db)) {
      fetched.push({ taskId: t.id, comments: await client.getComments(t.jiraKey) });
    }

    // Phase 2: apply in one transaction.
    return write(ctx, (tx, outbox) => {
      const now = ctx.clock().toISOString();
      let added = 0;
      for (const { taskId, comments } of fetched) {
        const task = getTaskDto(tx, taskId);
        if (!task || task.deletedAt) continue; // deleted since the fetch
        const known = listJiraCommentIds(tx, taskId);
        const fresh = comments.filter((c) => !known.has(c.id));
        if (fresh.length === 0) continue;
        for (const c of fresh) {
          insertMessage(tx, { taskId, role: 'user', source: 'jira', content: c.body, jiraCommentId: c.id, createdAt: c.createdAt });
        }
        let status = task.status;
        if (status === 'waiting_user') {
          const r = applyTransition(ctx, tx, outbox, taskId, 'user_answered');
          if (r.changed) status = r.to;
        }
        for (let i = 0; i < fresh.length; i++) {
          insertJournal(tx, { at: now, taskKey: task.key, status, action: 'comment_added', detail: 'source: jira' });
        }
        added += fresh.length;
      }
      const detail = `comments: ${added} new`;
      if (added > 0) {
        insertJournal(tx, { at: now, action: 'sync_run', detail });
        outbox.changed();
      }
      return detail;
    });
  });
}
