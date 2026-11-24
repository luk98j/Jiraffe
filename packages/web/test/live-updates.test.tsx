import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLiveUpdates } from '../src/useLiveUpdates.ts';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners = new Map<string, (e: unknown) => void>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: unknown) => void) {
    this.listeners.set(type, fn);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data = '{}') {
    this.listeners.get(type)?.({ data });
  }
}

function Probe() {
  useLiveUpdates();
  return null;
}

beforeEach(() => {
  FakeEventSource.instances = [];
  (globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
});
afterEach(() => {
  delete (globalThis as unknown as { EventSource?: unknown }).EventSource;
});

function mount() {
  const qc = new QueryClient();
  const spy = vi.spyOn(qc, 'invalidateQueries');
  const view = render(
    <QueryClientProvider client={qc}>
      <Probe />
    </QueryClientProvider>,
  );
  return { qc, spy, view, es: FakeEventSource.instances[0]! };
}

describe('live updates (AC-69 client)', () => {
  it('connects to the stream once', () => {
    const { es } = mount();
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(es.url).toBe('/api/stream');
  });

  it('invalidates all queries on a change event', () => {
    const { es, spy } = mount();
    es.emit('change');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('a change leaves the logs and diff queries alone, they have their own refresh', () => {
    const { es, spy } = mount();
    es.emit('change');
    const predicate = (spy.mock.calls[0]![0] as { predicate: (q: unknown) => boolean }).predicate;
    const q = (key: string) => ({ queryKey: [key, 1] });
    expect([predicate(q('tasks')), predicate(q('task')), predicate(q('queue'))]).toEqual([
      true,
      true,
      true,
    ]);
    expect([predicate(q('logs')), predicate(q('diff'))]).toEqual([false, false]);
  });

  it("a log event refreshes only that task's logs", () => {
    const { es, spy } = mount();
    es.emit('log', '{"taskId":4}');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ queryKey: ['logs', 4] });
    es.emit('log', 'not json');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('refetches after a dropped connection comes back, but not on the first open', () => {
    const { es, spy } = mount();
    es.onopen?.();
    expect(spy).not.toHaveBeenCalled();
    es.onerror?.();
    expect(spy).not.toHaveBeenCalled();
    es.onopen?.();
    expect(spy).toHaveBeenCalledTimes(1);
    es.onopen?.();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('closes the connection on unmount', () => {
    const { es, view } = mount();
    view.unmount();
    expect(es.closed).toBe(true);
  });

  it('does nothing when EventSource is unavailable', () => {
    delete (globalThis as unknown as { EventSource?: unknown }).EventSource;
    const qc = new QueryClient();
    expect(() =>
      render(
        <QueryClientProvider client={qc}>
          <Probe />
        </QueryClientProvider>,
      ),
    ).not.toThrow();
    expect(FakeEventSource.instances).toHaveLength(0);
  });
});
