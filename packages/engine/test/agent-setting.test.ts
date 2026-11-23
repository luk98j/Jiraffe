import { afterEach, describe, expect, it } from 'vitest';
import { createClaudeRunner } from '@jiraffe/adapters';
import { FakeRunner, stubSpawner } from '@jiraffe/adapters/testing';
import { ValidationError } from '@jiraffe/core';
import {
  disposeAll,
  eventRows,
  makeEngine,
  newTaskIn,
  queuedTask,
  runRows,
  say,
  statusOf,
} from './helpers.ts';

afterEach(disposeAll);

const NOT_VERIFIED = 'Claude Code adapter is not verified';

function setup() {
  const copilot = new FakeRunner(say({ verdict: 'NEEDS_INFO', questions: ['q'] }));
  const spawner = stubSpawner();
  const h = makeEngine({ runners: { copilot, claude: createClaudeRunner(spawner) } });
  h.engine.updateSetting('auto_analysis', true);
  return { copilot, spawner, h };
}

describe('the agent setting (AC-79, AC-80)', () => {
  it('defaults to copilot, rejects other values, and journals only the key name', () => {
    const { h } = setup();
    expect(h.engine.getSetting('agent')).toBe('copilot');
    expect(() => h.engine.updateSetting('agent', 'gpt')).toThrow(ValidationError);
    h.engine.updateSetting('agent', 'claude');
    expect(h.engine.getSetting('agent')).toBe('claude');
    const changes = h.engine.listJournal({ action: 'settings_changed', limit: 100 });
    expect(changes[0]?.detail).toBe('agent');
    expect(JSON.stringify(changes)).not.toContain('claude');
  });

  it('with agent = claude an analysis crashes with the readable reason, spawns nothing, and records the adapter', async () => {
    const { copilot, spawner, h } = setup();
    h.engine.updateSetting('agent', 'claude');
    const id = queuedTask(h.engine);
    await h.engine.start();
    await h.engine.idle();
    expect(statusOf(h, id)).toBe('failed');
    expect(runRows(h)[0]).toMatchObject({ agent: 'claude', end_reason: 'crashed' });
    expect(JSON.parse(eventRows(h, 'run_error', id)[0]!.payload_json!).message).toBe(NOT_VERIFIED);
    expect(spawner.spawns).toEqual([]);
    expect(copilot.calls).toEqual([]);
  });

  it('canDelegate is false with the same reason, and an execution run also fails closed', async () => {
    const { spawner, h } = setup();
    const id = newTaskIn(h.engine, 'ready_to_delegate');
    h.engine.updateSetting('agent', 'claude');
    expect(h.engine.canDelegate(id)).toMatchObject({ ok: false, reason: NOT_VERIFIED });
    const x = newTaskIn(h.engine, 'delegated');
    await h.engine.start();
    await h.engine.idle();
    expect(statusOf(h, x)).toBe('failed');
    expect(JSON.parse(eventRows(h, 'run_error', x)[0]!.payload_json!).message).toBe(NOT_VERIFIED);
    expect(spawner.spawns).toEqual([]);
  });

  it('switching back to copilot selects the Copilot runner again', async () => {
    const { copilot, h } = setup();
    h.engine.updateSetting('agent', 'claude');
    h.engine.updateSetting('agent', 'copilot');
    const id = queuedTask(h.engine);
    await h.engine.start();
    await h.engine.idle();
    expect(copilot.calls).toHaveLength(1);
    expect(runRows(h)[0]).toMatchObject({ agent: 'copilot' });
    expect(statusOf(h, id)).toBe('waiting_user');
  });

  it('fails closed when the chosen adapter is not registered at all', async () => {
    const h = makeEngine({ runners: { copilot: new FakeRunner() } });
    h.engine.updateSetting('agent', 'claude');
    h.engine.updateSetting('auto_analysis', true);
    const id = queuedTask(h.engine);
    await h.engine.start();
    await h.engine.idle();
    expect(statusOf(h, id)).toBe('failed');
  });
});
