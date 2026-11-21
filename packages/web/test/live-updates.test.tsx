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
  emit(type: string) {
    this.listeners.get(type)?.({ data: '{}' });
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
    expect(() => render(<QueryClientProvider client={qc}><Probe /></QueryClientProvider>)).not.toThrow();
    expect(FakeEventSource.instances).toHaveLength(0);
  });
});
