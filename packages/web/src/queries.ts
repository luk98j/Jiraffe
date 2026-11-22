import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { JournalDto, MessageDto, SettingsDto, SyncStateDto, TaskDto } from '@jiraffe/core';
import { request } from './api.ts';

export const useTasks = () =>
  useQuery({
    queryKey: ['tasks'],
    queryFn: () => request<{ tasks: TaskDto[] }>('GET', '/api/tasks').then((r) => r.tasks),
  });

export const useTaskDetail = (id: number) =>
  useQuery({
    queryKey: ['task', id],
    queryFn: () => request<{ task: TaskDto; messages: MessageDto[] }>('GET', `/api/tasks/${id}`),
  });

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
