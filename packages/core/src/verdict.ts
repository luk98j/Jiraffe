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

const FENCE = '```';

/**
 * Body of the last block that opens with ``` or ```json at the end of a line and is closed by
 * the next ```. A single left-to-right scan, so the cost is linear in the text length (no
 * regular expression that can backtrack on long runs of blanks).
 */
function lastFencedBlock(text: string): string | undefined {
  let last: string | undefined;
  let pos = 0;
  for (;;) {
    const open = text.indexOf(FENCE, pos);
    if (open < 0) return last;
    pos = open + FENCE.length;
    let k = pos;
    while (text[k] === ' ' || text[k] === '\t') k++;
    if (text.slice(k, k + 4).toLowerCase() === 'json') k += 4;
    while (text[k] === ' ' || text[k] === '\t') k++;
    if (text[k] === '\r' && text[k + 1] === '\n') k += 2;
    else if (text[k] === '\n') k += 1;
    else continue; // not an opening line, for example ```ts or a closing fence
    const close = text.indexOf(FENCE, k);
    if (close < 0) return last;
    let end = close;
    if (text[end - 1] === '\n') end -= text[end - 2] === '\r' ? 2 : 1;
    last = end >= k ? text.slice(k, end) : '';
    pos = close + FENCE.length;
  }
}

/**
 * Parses the LAST fenced JSON block of an agent answer. Never guesses: no block,
 * malformed JSON, an unknown verdict, or a wrong field type all fail.
 */
export function parseVerdict(text: string): ParsedVerdict {
  const last = lastFencedBlock(text);
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
