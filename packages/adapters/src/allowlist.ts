/**
 * Deny rules for `allowed_tools` (E3). Fail closed: an entry that might permit a push,
 * an allow-all mode or an unrestricted command is refused, even if that rejects a harmless
 * entry such as `git log --grep push`.
 */

const BLANKET = /^[\s*.?]*$|^(all|any|allow[-_ ]?all|everything)$/i;
const FLAG_DENY = /--yolo|--allow-all|--autopilot|allow[-_]all|skip-permissions|dangerously/i;

/** Lower-cased words of a command with quoting and escapes removed, split on shell separators. */
function words(entry: string): string[] {
  return entry
    .replace(/['"`\\]/g, '')
    .toLowerCase()
    .split(/[\s;&|()<>${}=]+/)
    .filter(Boolean);
}

const isGit = (w: string) => w === 'git' || w.endsWith('/git');

function mentionsPush(entry: string): boolean {
  const w = words(entry);
  if (w.some((x) => x === 'git-push' || x.endsWith('/git-push'))) return true;
  const g = w.findIndex(isGit);
  return g >= 0 && w.slice(g + 1).includes('push');
}

/** `git` alone or `git *` would permit `git push`. */
function bareGit(entry: string): boolean {
  const w = entry.trim().split(/\s+/);
  return (
    w.length >= 1 &&
    isGit((w[0] ?? '').toLowerCase()) &&
    (w.length === 1 || /^[*?]/.test(w[1] ?? ''))
  );
}

export type AllowlistCheck = { ok: true } | { ok: false; reason: string };

export function validateAllowedTools(tools: readonly string[]): AllowlistCheck {
  if (tools.length === 0) return { ok: false, reason: 'allowed_tools is empty' };
  for (const raw of tools) {
    const entry = typeof raw === 'string' ? raw.trim() : '';
    if (!entry) return { ok: false, reason: 'allowed_tools has an empty entry' };
    if (FLAG_DENY.test(entry))
      return { ok: false, reason: `allowed_tools entry "${entry}" allows everything` };
    if (BLANKET.test(entry))
      return { ok: false, reason: `allowed_tools entry "${entry}" is a blanket entry` };
    if (mentionsPush(entry))
      return { ok: false, reason: `allowed_tools entry "${entry}" would allow git push` };
    if (bareGit(entry))
      return { ok: false, reason: `allowed_tools entry "${entry}" would allow every git command` };
  }
  return { ok: true };
}

/**
 * Token-boundary match of a command against one allowlist entry: `git status` matches
 * `git status -s` but not `git statusx` or `git status; rm -rf x`. Used for validating
 * entries and by the test fake; it is NOT run on real agent tool calls (they are not visible).
 */
export function matchesAllowEntry(entry: string, command: string): boolean {
  if (/[;&|<>`$()\n\r]/.test(command)) return false;
  const e = entry.trim().split(/\s+/).filter(Boolean);
  const c = command.trim().split(/\s+/).filter(Boolean);
  return e.length > 0 && e.length <= c.length && e.every((t, i) => c[i] === t);
}
