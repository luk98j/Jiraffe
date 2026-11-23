import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAnalysisPrompt } from '../src/prompts.ts';

const input = {
  role: 'analyst' as const,
  title: 'Fix the invoice total',
  body: 'The total is wrong.',
  messages: [
    { role: 'user' as const, source: 'app' as const, content: 'Please hurry' },
    { role: 'user' as const, source: 'jira' as const, content: 'Seen in prod' },
    { role: 'agent' as const, source: 'app' as const, content: 'Which currency?' },
  ],
  previous: [],
};

describe('buildAnalysisPrompt (AC-24)', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.JIRA_API_TOKEN = 'tok-PROMPT-MARKER';
    process.env.JIRA_EMAIL = 'prompt.marker@example.test';
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('contains title, body, messages marked app or jira, and the verdict contract', () => {
    const p = buildAnalysisPrompt(input);
    expect(p).toContain('Title: Fix the invoice total');
    expect(p).toContain('The total is wrong.');
    expect(p).toContain('[app] user: Please hurry');
    expect(p).toContain('[jira] user: Seen in prod');
    expect(p).toContain('[app] agent: Which currency?');
    expect(p).toContain('"verdict"');
    expect(p).toContain('business analyst');
    expect(p).toMatch(/read-only/);
  });

  it('adds prior agent answers for the architect', () => {
    const p = buildAnalysisPrompt({
      ...input,
      role: 'architect',
      previous: [{ role: 'analyst', answer: 'ANALYST SAYS HELLO' }],
    });
    expect(p).toContain('software architect');
    expect(p).toContain('ANALYST SAYS HELLO');
  });

  it('never contains environment values', () => {
    const p = buildAnalysisPrompt(input);
    expect(p).not.toContain('tok-PROMPT-MARKER');
    expect(p).not.toContain('prompt.marker@example.test');
  });
});
