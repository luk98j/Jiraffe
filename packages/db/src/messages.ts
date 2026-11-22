import { asc, eq } from 'drizzle-orm';
import type { MessageDto } from '@jiraffe/core';
import type { Db, Tx } from './client.ts';
import { messages } from './schema.ts';

export function insertMessage(
  tx: Db | Tx,
  m: {
    taskId: number;
    role: 'user' | 'agent';
    source: 'app' | 'jira';
    content: string;
    jiraCommentId?: string | null;
    createdAt: string;
  },
): void {
  tx.insert(messages)
    .values({ ...m, jiraCommentId: m.jiraCommentId ?? null })
    .run();
}

export function listMessages(db: Db | Tx, taskId: number): MessageDto[] {
  return db
    .select({
      id: messages.id,
      taskId: messages.taskId,
      role: messages.role,
      source: messages.source,
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(eq(messages.taskId, taskId))
    .orderBy(asc(messages.createdAt), asc(messages.id))
    .all();
}
