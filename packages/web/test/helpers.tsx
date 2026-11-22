import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type { TaskDto } from '@jiraffe/core';
import { App } from '../src/App.tsx';

export interface Req {
  method: string;
  path: string;
  query: URLSearchParams;
  // biome-ignore lint/suspicious/noExplicitAny: The fetch fake records arbitrary JSON request payloads.
  body: any;
}
export type Reply = { status?: number; body?: unknown } | undefined;
export type Handler = (req: Req) => Reply;

/** Replaces fetch with a stub that records calls. Unhandled requests answer 404. */
export function installFetch(handler: Handler): { calls: Req[] } {
  const calls: Req[] = [];
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), 'http://localhost');
    const req: Req = {
      method: (init.method ?? 'GET').toUpperCase(),
      path: url.pathname,
      query: url.searchParams,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(req);
    const r = handler(req);
    if (!r)
      return new Response(JSON.stringify({ error: { code: 'not_found', message: 'Not found' } }), {
        status: 404,
      });
    const status = r.status ?? 200;
    return new Response(status === 204 ? null : JSON.stringify(r.body ?? {}), { status });
  }) as typeof fetch;
  return { calls };
}

export function renderApp(route: string, handler: Handler) {
  const fetchLog = installFetch(handler);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const user = userEvent.setup();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, user, queryClient, ...fetchLog };
}

let nextId = 1;
export function task(over: Partial<TaskDto> = {}): TaskDto {
  const id = over.id ?? nextId++;
  const key = over.key ?? `LOC-${String(id).padStart(4, '0')}`;
  return {
    id,
    source: 'local',
    key,
    jiraKey: null,
    localKey: key,
    title: `Task ${key}`,
    body: 'Body',
    repoPath: '/repos/a',
    status: 'new',
    statusBeforePause: null,
    priority: 0,
    pauseReason: null,
    resumeAt: null,
    jiraClosed: false,
    bodyChangedAfterAnalysis: false,
    hasNewComment: false,
    closedInJiraAt: null,
    deletedAt: null,
    createdAt: '2026-11-20T10:00:00.000Z',
    updatedAt: '2026-11-20T10:00:00.000Z',
    ...over,
  };
}

/** A handler serving a task list, with extra handlers layered on top. */
export function withTasks(tasks: () => TaskDto[], extra: Handler = () => undefined): Handler {
  return (req) => {
    const r = extra(req);
    if (r) return r;
    if (req.method === 'GET' && req.path === '/api/tasks') return { body: { tasks: tasks() } };
    return undefined;
  };
}
