import { describe, expect, it } from 'vitest';
import { copilotProfile } from '../src/index.ts';

describe('Copilot capability profile (AC-21)', () => {
  const confirmed = ['prompt', 'maxCredits', 'agent', 'model'];

  it('confirms exactly the four flags from the documentation', () => {
    const entries = Object.entries(copilotProfile);
    expect(
      entries
        .filter(([, e]) => e.status === 'confirmed')
        .map(([k]) => k)
        .sort(),
    ).toEqual([...confirmed].sort());
  });

  it('marks every other entry UNVERIFIED with a spec section 12 item and no invented flag', () => {
    for (const [name, e] of Object.entries(copilotProfile)) {
      if (confirmed.includes(name)) continue;
      expect(e.status, name).toBe('unverified');
      expect(e.spec12Item, name).toBeGreaterThanOrEqual(1);
      expect(e.note, name).not.toMatch(/--/);
      expect('args' in e, name).toBe(false);
    }
  });
});
