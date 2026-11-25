import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEngine } from '../src/index.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

function open(clock?: () => Date) {
  const dir = mkdtempSync(join(tmpdir(), 'jiraffe-log-'));
  const engine = createEngine({
    dbPath: join(dir, 't.db'),
    version: 'test',
    ...(clock ? { clock } : {}),
  });
  return {
    engine,
    done() {
      engine.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('default console logger', () => {
  it('prefixes info and error lines with the injected clock time', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { engine, done } = open(() => new Date('2026-11-25T10:15:00.123Z'));
    try {
      engine.ctx.logger.info('hello');
      engine.ctx.logger.error('bad', new Error('detail'));
      expect(info).toHaveBeenCalledWith('2026-11-25T10:15:00.123Z info: hello');
      expect(error).toHaveBeenCalledWith('2026-11-25T10:15:00.123Z error: bad', 'detail');
    } finally {
      done();
    }
  });

  it('uses the real time when no clock is injected', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { engine, done } = open();
    try {
      engine.ctx.logger.info('hello');
      expect(info.mock.calls[0]![0]).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z info: hello$/,
      );
    } finally {
      done();
    }
  });
});
