import { JiraError, type JiraClient, type JiraComment, type JiraIssue } from './types.ts';

// shortcut: written against the Jira Cloud REST API v3 from memory (cursor-based
// search, ADF text, basic auth) and only exercised with fixtures; verify against
// a real instance before relying on it.
const SEARCH_FIELDS = 'summary,description,status,project';
const KEY_RE = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;
const CHUNK = 50;

interface AdfNode {
  type?: string;
  text?: string;
  content?: AdfNode[];
}

/** Flattens an Atlassian Document Format value (or plain string) to plain text. */
function adfToText(node: unknown): string {
  if (typeof node === 'string') return node;
  if (!node || typeof node !== 'object') return '';
  const n = node as AdfNode;
  if (n.type === 'text') return n.text ?? '';
  if (n.type === 'hardBreak') return '\n';
  const children = (n.content ?? []).map(adfToText);
  const block = n.type === 'doc' || n.type === 'listItem' || n.type === 'bulletList' || n.type === 'orderedList';
  return children.join(block ? '\n' : '');
}

interface RawIssue {
  key: string;
  fields: {
    summary?: string;
    description?: unknown;
    status?: { name?: string; statusCategory?: { key?: string } };
    project?: { key?: string };
  };
}

function toIssue(raw: RawIssue): JiraIssue {
  const cat = raw.fields.status?.statusCategory?.key;
  const description = raw.fields.description == null ? null : adfToText(raw.fields.description);
  return {
    key: raw.key,
    projectKey: raw.fields.project?.key ?? raw.key.split('-')[0] ?? '',
    title: raw.fields.summary ?? '',
    description,
    statusName: raw.fields.status?.name ?? '',
    statusCategory: cat === 'done' ? 'done' : cat === 'indeterminate' ? 'indeterminate' : 'new',
  };
}

const toIso = (s: string) => {
  const d = new Date(s.replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));
  return Number.isNaN(d.getTime()) ? s : d.toISOString();
};

export function createHttpJiraClient(opts: {
  baseUrl: string;
  email: string;
  token: string;
  fetch?: typeof fetch;
}): JiraClient {
  const doFetch = opts.fetch ?? fetch;
  const base = opts.baseUrl.replace(/\/+$/, '');
  const authorization = `Basic ${Buffer.from(`${opts.email}:${opts.token}`).toString('base64')}`;

  async function get<T>(path: string, params: Record<string, string>): Promise<T> {
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    let res: Response;
    try {
      res = await doFetch(url.toString(), {
        headers: { authorization, accept: 'application/json' },
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new JiraError('network', 'Could not reach Jira');
    }
    if (res.status === 401 || res.status === 403) {
      throw new JiraError('auth', `Jira rejected the credentials (HTTP ${res.status})`);
    }
    if (res.status === 429) throw new JiraError('rate_limit', 'Jira rate limit reached (HTTP 429)');
    if (!res.ok) throw new JiraError('server', `Jira returned an error (HTTP ${res.status})`);
    try {
      return (await res.json()) as T;
    } catch {
      throw new JiraError('server', 'Jira returned an unreadable response');
    }
  }

  async function searchPage(jql: string, cursor?: string) {
    const params: Record<string, string> = { jql, fields: SEARCH_FIELDS, maxResults: String(CHUNK) };
    if (cursor) params.nextPageToken = cursor;
    const body = await get<{ issues?: RawIssue[]; nextPageToken?: string }>('/rest/api/3/search/jql', params);
    const page: { issues: JiraIssue[]; nextCursor?: string } = { issues: (body.issues ?? []).map(toIssue) };
    if (body.nextPageToken) page.nextCursor = body.nextPageToken;
    return page;
  }

  return {
    searchPage,

    async getIssues(keys) {
      for (const k of keys) {
        if (!KEY_RE.test(k)) throw new JiraError('server', 'Invalid Jira issue key');
      }
      const out: JiraIssue[] = [];
      for (let i = 0; i < keys.length; i += CHUNK) {
        const jql = `key IN (${keys.slice(i, i + CHUNK).join(',')})`;
        let cursor: string | undefined;
        do {
          const page = await searchPage(jql, cursor);
          out.push(...page.issues);
          cursor = page.nextCursor;
        } while (cursor);
      }
      return out;
    },

    async getComments(key) {
      if (!KEY_RE.test(key)) throw new JiraError('server', 'Invalid Jira issue key');
      const out: JiraComment[] = [];
      let startAt = 0;
      for (;;) {
        const body = await get<{
          comments?: { id: string; body?: unknown; created: string }[];
          total?: number;
        }>(`/rest/api/3/issue/${key}/comment`, { startAt: String(startAt), maxResults: '100' });
        const list = body.comments ?? [];
        for (const c of list) out.push({ id: String(c.id), body: adfToText(c.body), createdAt: toIso(c.created) });
        startAt += list.length;
        if (list.length === 0 || startAt >= (body.total ?? 0)) return out;
      }
    },
  };
}
