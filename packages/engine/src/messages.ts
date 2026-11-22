import { TaskNotFoundError, ValidationError, type MessageDto } from '@jiraffe/core';
import {
  getTaskDto,
  insertEvent,
  insertJournal,
  insertMessage,
  listMessages as dbListMessages,
} from '@jiraffe/db';
import { write, type Ctx } from './context.ts';
import { applyTransition } from './transition.ts';

export function addUserMessage(ctx: Ctx, taskId: number, content: string): void {
  const text = content.trim();
  if (!text) throw new ValidationError('Message must not be empty', 'content');
  write(ctx, (tx, outbox) => {
    const task = getTaskDto(tx, taskId);
    if (!task || task.deletedAt) throw new TaskNotFoundError();
    const now = ctx.clock().toISOString();
    insertMessage(tx, { taskId, role: 'user', source: 'app', content: text, createdAt: now });
    insertEvent(tx, { taskId, type: 'user_comment', createdAt: now });
    outbox.emitEvent({ taskId, type: 'user_comment' });
    let status = task.status;
    if (status === 'waiting_user') {
      const r = applyTransition(ctx, tx, outbox, taskId, 'user_answered');
      if (r.changed) status = r.to;
    }
    // Journal detail names the source only, never the text.
    insertJournal(tx, {
      at: now,
      taskKey: task.key,
      status,
      action: 'comment_added',
      detail: 'source: app',
    });
    outbox.changed();
  });
}

export function listMessages(ctx: Ctx, taskId: number): MessageDto[] {
  return dbListMessages(ctx.db, taskId);
}
