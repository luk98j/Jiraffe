import { ValidationError, type TaskDto } from '@jiraffe/core';
import { getTaskDto, insertJournal, readSettingValue, upsertSetting, type Tx } from '@jiraffe/db';
import { insertTask } from '@jiraffe/db/status-writer';
import type { Ctx, Outbox } from './context.ts';

export type NewTaskInput =
  | { source: 'jira'; jiraKey: string; title: string; body: string; repoPath: string | null }
  | { source: 'local'; title: string; body: string; repoPath: string };

/** The only way a task row is created. Runs inside the caller's transaction. */
export function createTask(ctx: Ctx, tx: Tx, outbox: Outbox, input: NewTaskInput): TaskDto {
  const now = ctx.clock().toISOString();
  let jiraKey: string | null = null;
  let localKey: string | null = null;
  let title = input.title;
  let repoPath = input.repoPath;

  if (input.source === 'local') {
    title = input.title.trim();
    repoPath = input.repoPath.trim();
    if (!title) throw new ValidationError('Title is required', 'title');
    if (!repoPath) throw new ValidationError('Repository is required', 'repoPath');
    const counter = Number(JSON.parse(readSettingValue(tx, 'local_task_counter') ?? '0')) + 1;
    upsertSetting(tx, 'local_task_counter', JSON.stringify(counter));
    localKey = `LOC-${String(counter).padStart(4, '0')}`;
  } else {
    jiraKey = input.jiraKey;
  }

  const id = insertTask(tx, {
    source: input.source,
    jiraKey,
    localKey,
    title,
    body: input.body,
    repoPath,
    now,
  });
  insertJournal(tx, {
    at: now,
    taskKey: jiraKey ?? localKey,
    status: 'new',
    action: input.source === 'jira' ? 'task_imported' : 'task_created',
    detail: input.source === 'jira' ? 'from Jira' : 'manual',
  });
  outbox.changed();
  return getTaskDto(tx, id) as TaskDto;
}
