import type { Status } from './statuses.ts';
import type { Verdict } from './verdict.ts';

/** Whether Delegate is allowed now, and why not. `permissions` is display only. */
export interface DelegateDto {
  ok: boolean;
  reason: string | null;
  permissions: string[];
}

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
  /** Filled by the engine for tasks that are ready to delegate. */
  delegate?: DelegateDto;
}

export interface MessageDto {
  id: number;
  taskId: number;
  role: 'user' | 'agent';
  source: 'app' | 'jira';
  content: string;
  createdAt: string;
  /** Arrived while a run was active, so that run's prompt did not include it. */
  waitsForNextRun: boolean;
}

/** One analysis run (business analyst or architect) and what it concluded. */
export interface AnalysisRunDto {
  runId: number;
  role: 'analyst' | 'architect';
  agent: string | null;
  endReason: string | null;
  finishedAt: string | null;
  /** Null while the run is open or when it produced no valid verdict. */
  verdict: Verdict | null;
  /** The agent's answer text, capped; null while open. */
  answer: string | null;
}

export interface AnalysisDto {
  runs: AnalysisRunDto[];
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

export interface TaskExtrasDto {
  delegate: DelegateDto;
  /** Message of the latest run_error event, for Show error. */
  lastError: { message: string; tail: string | null } | null;
  /** Execution will restart in an existing worktree. */
  restartsInWorktree: boolean;
  hasWorktree: boolean;
}

export interface LogLineDto {
  id: number;
  runId: number;
  stream: 'stdout' | 'stderr';
  text: string;
  at: string;
}

export interface LogsDto {
  lines: LogLineDto[];
  /** A `log_truncated` event exists in this page. */
  truncated: boolean;
  /** More lines follow after the last one of this page. */
  hasMore: boolean;
}

export interface DiffDto {
  diff: string;
  truncated: boolean;
  base: string;
}
