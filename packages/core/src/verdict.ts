import { z } from 'zod';

const list = (maxItems: number, maxLen: number) => z.array(z.string().max(maxLen)).max(maxItems);

/** The JSON block every analysis agent ends its answer with (spec section 8). */
export const verdictSchema = z.object({
  verdict: z.enum(['READY', 'NEEDS_INFO']),
  questions: list(100, 2000),
  missing: list(100, 2000),
  permissions: list(200, 500),
  summary: z.string().max(4000),
});
export type Verdict = z.infer<typeof verdictSchema>;

export type ParsedVerdict = { ok: true; verdict: Verdict } | { ok: false; reason: string };

const FENCE = /```[ \t]*(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```/gi;

/**
 * Parses the LAST fenced JSON block of an agent answer. Never guesses: no block,
 * malformed JSON, an unknown verdict, or a wrong field type all fail.
 */
export function parseVerdict(text: string): ParsedVerdict {
  let last: string | undefined;
  for (const m of text.matchAll(FENCE)) last = m[1];
  if (last === undefined) return { ok: false, reason: 'No fenced JSON block found' };
  let json: unknown;
  try {
    json = JSON.parse(last);
  } catch {
    return { ok: false, reason: 'The JSON block is not valid JSON' };
  }
  const r = verdictSchema.safeParse(json);
  if (!r.success)
    return { ok: false, reason: 'The JSON block does not match the verdict contract' };
  return { ok: true, verdict: r.data };
}
