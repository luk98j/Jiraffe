import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AnalysisDto,
  DiffDto,
  LogLineDto,
  LogsDto,
  TaskExtrasDto,
  JournalDto,
  MessageDto,
  SettingsDto,
  SyncStateDto,
  TaskDto,
} from '@jiraffe/core';
import { request } from './api.ts';

export const useTasks = () =>
  useQuery({
    queryKey: ['tasks'],
    queryFn: () => request<{ tasks: TaskDto[] }>('GET', '/api/tasks').then((r) => r.tasks),
  });

export const useTaskDetail = (id: number) =>
  useQuery({
    queryKey: ['task', id],
    queryFn: () =>
      request<{ task: TaskDto; messages: MessageDto[]; analysis: AnalysisDto } & TaskExtrasDto>(
        'GET',
        `/api/tasks/${id}`,
      ),
  });

export interface QueueState {
  started: boolean;
  autoAnalysis: boolean;
  active: { analysis: number; execution: number };
  max: { analysis: number; execution: number };
}

export const useQueue = () =>
  useQuery({ queryKey: ['queue'], queryFn: () => request<QueueState>('GET', '/api/queue') });

export const startQueue = () => request('POST', '/api/queue/start');

export const useDeleted = () =>
  useQuery({
    queryKey: ['deleted'],
    queryFn: () => request<{ tasks: TaskDto[] }>('GET', '/api/deleted').then((r) => r.tasks),
  });

export const useJournal = (taskKey: string, action: string) =>
  useQuery({
    queryKey: ['journal', taskKey, action],
    queryFn: () => {
      const q = new URLSearchParams();
      if (taskKey) q.set('taskKey', taskKey);
      if (action) q.set('action', action);
      const qs = q.toString();
      return request<{ entries: JournalDto[] }>('GET', `/api/journal${qs ? `?${qs}` : ''}`).then(
        (r) => r.entries,
      );
    },
  });

export const useSettings = () =>
  useQuery({ queryKey: ['settings'], queryFn: () => request<SettingsDto>('GET', '/api/settings') });

export const useSync = () =>
  useQuery({ queryKey: ['sync'], queryFn: () => request<SyncStateDto>('GET', '/api/sync') });

/** A mutation that refreshes every query when it settles. */
export function useApiMutation<V, R = unknown>(fn: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSettled: () => qc.invalidateQueries() });
}

export const sendEvent = (id: number, event: string) =>
  request('POST', `/api/tasks/${id}/events`, { event });
export const deleteTask = (id: number) => request('DELETE', `/api/tasks/${id}`);

export const delegateTask = (id: number) => request('POST', `/api/tasks/${id}/delegate`);

/** Deletes a task; the worktree and branch go only when `removeWorktree` is true. */
export const deleteTaskWith = (id: number, removeWorktree: boolean) =>
  request<{ removalError?: string } | undefined>(
    'DELETE',
    `/api/tasks/${id}${removeWorktree ? '?removeWorktree=1' : ''}`,
  );

/** Every stored output line of the task, fetched in pages by event id. */
export const useLogs = (id: number, enabled: boolean) =>
  useQuery({
    queryKey: ['logs', id],
    enabled,
    queryFn: async () => {
      const lines: LogLineDto[] = [];
      let truncated = false;
      for (;;) {
        const after = lines.at(-1)?.id ?? 0;
        const page = await request<LogsDto>(
          'GET',
          `/api/tasks/${id}/logs?after=${after}&limit=500`,
        );
        lines.push(...page.lines);
        truncated ||= page.truncated;
        if (page.lines.length < 500) return { lines, truncated };
      }
    },
  });

export const useDiff = (id: number, enabled: boolean) =>
  useQuery({
    queryKey: ['diff', id],
    enabled,
    queryFn: () => request<DiffDto>('GET', `/api/tasks/${id}/diff`),
  });
