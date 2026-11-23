import { describe, expect, it } from 'vitest';
import { parseVerdict } from '../src/index.ts';

const valid = {
  verdict: 'READY',
  questions: [],
  missing: [],
  permissions: ['read: src/**'],
  summary: 'Looks fine',
};
const fence = (v: unknown, lang = 'json') =>
  `\`\`\`${lang}\n${typeof v === 'string' ? v : JSON.stringify(v, null, 2)}\n\`\`\``;

describe('parseVerdict', () => {
  it('parses a valid block at the end of the answer', () => {
    const r = parseVerdict(`My analysis.\n\n${fence(valid)}`);
    expect(r).toEqual({ ok: true, verdict: valid });
  });

  it('accepts NEEDS_INFO with questions', () => {
    const v = { ...valid, verdict: 'NEEDS_INFO', questions: ['Which API?'], missing: ['AC'] };
    expect(parseVerdict(fence(v))).toEqual({ ok: true, verdict: v });
  });

  it('accepts an untagged fence and CRLF line ends', () => {
    expect(parseVerdict(fence(valid, '')).ok).toBe(true);
    expect(parseVerdict(fence(valid).replace(/\n/g, '\r\n')).ok).toBe(true);
  });

  it('tolerates prose before and after the block', () => {
    expect(parseVerdict(`before\n${fence(valid)}\nafter text`).ok).toBe(true);
  });

  it('uses the last block when there are several', () => {
    const first = { ...valid, verdict: 'NEEDS_INFO', questions: ['q'] };
    const r = parseVerdict(`${fence(first)}\n\nrevised:\n${fence(valid)}`);
    expect(r).toEqual({ ok: true, verdict: valid });
  });

  it('rejects when the last block is invalid even if an earlier one is valid', () => {
    expect(parseVerdict(`${fence(valid)}\n${fence('{ nope')}`).ok).toBe(false);
  });

  it.each([
    ['no block', 'just prose, verdict READY'],
    ['empty text', ''],
    ['malformed JSON', fence('{"verdict": "READY",')],
    ['not an object', fence('[1,2]')],
    ['unknown verdict', fence({ ...valid, verdict: 'MAYBE' })],
    ['lower case verdict', fence({ ...valid, verdict: 'ready' })],
    ['missing questions', fence({ ...valid, questions: undefined })],
    ['missing summary', fence({ ...valid, summary: undefined })],
    ['questions wrong type', fence({ ...valid, questions: 'why' })],
    ['question item wrong type', fence({ ...valid, questions: [1] })],
    ['summary wrong type', fence({ ...valid, summary: 5 })],
    ['permissions wrong type', fence({ ...valid, permissions: 'all' })],
    ['unclosed fence', '```json\n{"verdict":"READY"}'],
    ['only a non-json fence', fence(valid, 'ts')],
  ])('rejects %s', (_name, text) => {
    const r = parseVerdict(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.length).toBeGreaterThan(0);
  });

  it('enforces size caps', () => {
    expect(parseVerdict(fence({ ...valid, summary: 'x'.repeat(5000) })).ok).toBe(false);
    expect(parseVerdict(fence({ ...valid, questions: Array(101).fill('q') })).ok).toBe(false);
    expect(parseVerdict(fence({ ...valid, questions: ['q'.repeat(3000)] })).ok).toBe(false);
    expect(parseVerdict(fence({ ...valid, permissions: Array(201).fill('p') })).ok).toBe(false);
  });

  it('handles a very long run of blanks after a fence quickly (no regex backtracking)', () => {
    const started = Date.now();
    for (const text of [
      `\`\`\`${'\t'.repeat(100_000)}`,
      `\`\`\`${' \t'.repeat(100_000)}x`,
      `\`\`\`json${'\t'.repeat(100_000)}\n${'```'.repeat(1000)}`,
    ])
      expect(parseVerdict(text).ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('never throws on hostile input', () => {
    for (const t of ['```json\n```', '```\n\n```', '```json\nnull\n```', '`'.repeat(500)]) {
      expect(parseVerdict(t).ok).toBe(false);
    }
  });
});
