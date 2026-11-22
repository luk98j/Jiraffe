export const STATUSES = [
  'new',
  'queued_analysis',
  'analysing',
  'waiting_user',
  'ready_to_delegate',
  'delegated',
  'running',
  'paused_quota',
  'review',
  'done',
  'failed',
  'cancelled',
] as const;
export type Status = (typeof STATUSES)[number];

export const TERMINAL: readonly Status[] = ['done', 'cancelled'];
