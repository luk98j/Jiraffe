import type { Status } from './statuses.ts';

export interface TaskDto {
  id: number;
  source: 'jira' | 'local';
  key: string;
  jiraKey: string | null;
  localKey: string | null;
  title: string;
  body: string;
  repoPath: string | null;
  status: Status;
  statusBeforePause: Status | null;
  priority: number;
  pauseReason: string | null;
  resumeAt: string | null;
  jiraClosed: boolean;
  bodyChangedAfterAnalysis: boolean;
  hasNewComment: boolean;
  closedInJiraAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MessageDto {
  id: number;
  taskId: number;
  role: 'user' | 'agent';
  source: 'app' | 'jira';
  content: string;
  createdAt: string;
}

export interface JournalDto {
  id: number;
  at: string;
  taskKey: string | null;
  status: string | null;
  action: string;
  detail: string | null;
}

export interface SettingsDto {
  values: Record<string, unknown>;
  readOnly: string[];
  problems: { key: string; message: string }[];
}

export interface SyncStateDto {
  state: 'idle' | 'running' | 'not_configured' | 'error';
  lastRunAt: string | null;
  lastError: string | null;
  lastSkippedAt: string | null;
  lastResult: string | null;
}

export interface ApiError {
  error: { code: string; message: string; field?: string };
}
