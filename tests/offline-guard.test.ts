import { expect, it } from 'vitest';

it('has no JIRA_* environment variables (AC-5)', () => {
  expect(Object.keys(process.env).filter((k) => k.startsWith('JIRA_'))).toEqual([]);
});

it('blocks network access through fetch (AC-5)', () => {
  expect(() => fetch('http://127.0.0.1:1/')).toThrow('network disabled in tests');
});
