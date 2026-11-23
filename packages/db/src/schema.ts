import { sql } from 'drizzle-orm';
import { check, index, integer, real, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';
import { STATUSES } from '@jiraffe/core';

const inList = (col: string, values: readonly string[]) =>
  sql.raw(`${col} IN (${values.map((v) => `'${v}'`).join(', ')})`);

export const tasks = sqliteTable(
  'tasks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    source: text('source', { enum: ['jira', 'local'] }).notNull(),
    jiraKey: text('jira_key').unique(),
    localKey: text('local_key').unique(),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    repoPath: text('repo_path'),
    status: text('status', { enum: STATUSES }).notNull(),
    statusBeforePause: text('status_before_pause', { enum: STATUSES }),
    priority: integer('priority').notNull().default(0),
    maxCredits: real('max_credits'),
    pauseReason: text('pause_reason'),
    resumeAt: text('resume_at'),
    jiraClosed: integer('jira_closed', { mode: 'boolean' }).notNull().default(false),
    bodyChangedAfterAnalysis: integer('body_changed_after_analysis', { mode: 'boolean' })
      .notNull()
      .default(false),
    lastSyncedAt: text('last_synced_at'),
    closedInJiraAt: text('closed_in_jira_at'),
    deletedAt: text('deleted_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    check('tasks_one_key', sql`(${t.jiraKey} IS NULL) <> (${t.localKey} IS NULL)`),
    check('tasks_source', inList('source', ['jira', 'local'])),
    check('tasks_status', inList('status', STATUSES)),
    index('tasks_status_idx').on(t.status),
    index('tasks_deleted_at_idx').on(t.deletedAt),
  ],
);

export const messages = sqliteTable(
  'messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    taskId: integer('task_id')
      .notNull()
      .references(() => tasks.id),
    role: text('role', { enum: ['user', 'agent'] }).notNull(),
    source: text('source', { enum: ['app', 'jira'] }).notNull(),
    content: text('content').notNull(),
    jiraCommentId: text('jira_comment_id'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [unique('messages_task_comment').on(t.taskId, t.jiraCommentId)],
);

export const runs = sqliteTable('runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  taskId: integer('task_id')
    .notNull()
    .references(() => tasks.id),
  kind: text('kind', { enum: ['analysis', 'execution'] }).notNull(),
  agent: text('agent'),
  sessionId: text('session_id'),
  status: text('status', { enum: ['running', 'finished'] }),
  pid: integer('pid'),
  maxCredits: real('max_credits'),
  creditsUsed: real('credits_used'),
  endReason: text('end_reason', {
    enum: ['completed', 'credit_limit', 'quota', 'crashed', 'cancelled'],
  }),
  startedAt: text('started_at'),
  finishedAt: text('finished_at'),
  /** Analysis: `{ role, verdict, answer }`. */
  resultJson: text('result_json'),
  worktreePath: text('worktree_path'),
  branch: text('branch'),
  baseCommit: text('base_commit'),
});

export const events = sqliteTable(
  'events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    taskId: integer('task_id')
      .notNull()
      .references(() => tasks.id),
    type: text('type').notNull(),
    payloadJson: text('payload_json'),
    processedAt: text('processed_at'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('events_task_idx').on(t.taskId), index('events_processed_idx').on(t.processedAt)],
);

// No foreign key: journal rows survive task purge.
export const journal = sqliteTable(
  'journal',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    at: text('at').notNull(),
    taskKey: text('task_key'),
    status: text('status'),
    action: text('action').notNull(),
    detail: text('detail'),
  },
  (t) => [index('journal_at_idx').on(t.at), index('journal_task_key_idx').on(t.taskKey)],
);

export const ignoredJiraKeys = sqliteTable('ignored_jira_keys', {
  jiraKey: text('jira_key').primaryKey(),
  deletedAt: text('deleted_at').notNull(),
});

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  valueJson: text('value_json').notNull(),
});
