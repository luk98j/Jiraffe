import type { Status, TaskDto } from '@jiraffe/core';

export interface Column {
  id: string;
  title: string;
  statuses: Status[];
}

/** Board columns in flow order; new and queued_analysis share one column. */
export const COLUMNS: Column[] = [
  { id: 'new_queued', title: 'New / Queued', statuses: ['new', 'queued_analysis'] },
  { id: 'analysing', title: 'Analysing', statuses: ['analysing'] },
  { id: 'waiting_user', title: 'Waiting for you', statuses: ['waiting_user'] },
  { id: 'ready_to_delegate', title: 'Ready to delegate', statuses: ['ready_to_delegate'] },
  { id: 'delegated', title: 'Queued for execution', statuses: ['delegated'] },
  { id: 'running', title: 'Running', statuses: ['running'] },
  { id: 'paused_quota', title: 'Paused (usage limit)', statuses: ['paused_quota'] },
  { id: 'review', title: 'Needs review', statuses: ['review'] },
  { id: 'failed', title: 'Failed', statuses: ['failed'] },
  { id: 'done', title: 'Done', statuses: ['done'] },
  { id: 'cancelled', title: 'Cancelled', statuses: ['cancelled'] },
];

export const NEEDS_USER: readonly Status[] = ['waiting_user', 'review', 'failed'];
export const FINISHED: readonly Status[] = ['done', 'cancelled'];

export function analyseDisabledReason(t: TaskDto): string | null {
  if (!t.repoPath?.trim()) return 'Choose a repository first';
  if (t.status === 'queued_analysis') return 'Already queued for analysis';
  return null;
}
