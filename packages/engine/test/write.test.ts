import { afterEach, describe, expect, it } from 'vitest';
import { disposeAll, makeEngine } from './helpers.ts';
import { write } from '../src/context.ts';

afterEach(disposeAll);

describe('write() outbox', () => {
  it('flushes events after commit, when the data is already readable', () => {
    const h = makeEngine();
    const seen: string[] = [];
    h.engine.bus.onEvent((e) => {
      const row = h.raw.prepare("SELECT value_json FROM settings WHERE key = 'x'").get() as {
        value_json: string;
      };
      seen.push(`${e.type}:${row.value_json}`);
    });
    let changed = 0;
    h.engine.bus.onChanged(() => changed++);
    write(h.engine.ctx, (_tx, outbox) => {
      h.engine.ctx.db.$client
        .prepare("INSERT INTO settings (key, value_json) VALUES ('x', '1')")
        .run();
      outbox.emitEvent({ taskId: 1, type: 'enqueue' });
      outbox.changed();
      expect(seen).toEqual([]);
    });
    expect(seen).toEqual(['enqueue:1']);
    expect(changed).toBe(1);
  });

  it('drops the outbox and rolls back when the callback throws', () => {
    const h = makeEngine();
    const seen: unknown[] = [];
    h.engine.bus.onEvent((e) => seen.push(e));
    h.engine.bus.onChanged(() => seen.push('changed'));
    expect(() =>
      write(h.engine.ctx, (_tx, outbox) => {
        h.engine.ctx.db.$client
          .prepare("INSERT INTO settings (key, value_json) VALUES ('x', '1')")
          .run();
        outbox.emitEvent({ taskId: 1, type: 'enqueue' });
        outbox.changed();
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(seen).toEqual([]);
    expect(h.raw.prepare("SELECT 1 FROM settings WHERE key = 'x'").get()).toBeUndefined();
  });

  it('does not let a handler exception reach the caller or other handlers', () => {
    const logged: unknown[] = [];
    const h = makeEngine({ logger: { error: (...a) => logged.push(a) } });
    const seen: string[] = [];
    h.engine.bus.onEvent(() => {
      throw new Error('handler failed');
    });
    h.engine.bus.onEvent((e) => seen.push(e.type));
    const result = write(h.engine.ctx, (_tx, outbox) => {
      outbox.emitEvent({ taskId: 1, type: 'cancel' });
      return 42;
    });
    expect(result).toBe(42);
    expect(seen).toEqual(['cancel']);
    expect(logged).toHaveLength(1);
  });

  it('unsubscribes', () => {
    const h = makeEngine();
    let n = 0;
    const off = h.engine.bus.onChanged(() => n++);
    off();
    write(h.engine.ctx, (_tx, o) => o.changed());
    expect(n).toBe(0);
  });
});
