import type { JiraError, JiraClient, JiraComment, JiraIssue } from './types.ts';

/** In-memory Jira for tests. `searchPage` ignores the JQL and records it. */
export class FakeJiraClient implements JiraClient {
  pageSize = 50;
  calls: { method: string; args: unknown[] }[] = [];
  private issues: JiraIssue[] = [];
  private comments = new Map<string, JiraComment[]>();
  private failure: Error | null = null;
  private gate: Promise<void> | null = null;
  private open: (() => void) | null = null;

  setIssues(list: JiraIssue[]): void {
    this.issues = list;
  }

  setComments(key: string, list: JiraComment[]): void {
    this.comments.set(key, list);
  }

  failNext(err: JiraError | Error): void {
    this.failure = err;
  }

  block(): void {
    this.gate = new Promise((resolve) => (this.open = resolve));
  }

  release(): void {
    this.open?.();
    this.gate = null;
    this.open = null;
  }

  private async enter(method: string, args: unknown[]): Promise<void> {
    this.calls.push({ method, args });
    if (this.gate) await this.gate;
    if (this.failure) {
      const err = this.failure;
      this.failure = null;
      throw err;
    }
  }

  async searchPage(jql: string, cursor?: string) {
    await this.enter('searchPage', [jql, cursor]);
    const start = cursor ? Number(cursor) : 0;
    const end = start + this.pageSize;
    const page: { issues: JiraIssue[]; nextCursor?: string } = {
      issues: this.issues.slice(start, end),
    };
    if (end < this.issues.length) page.nextCursor = String(end);
    return page;
  }

  async getIssues(keys: string[]) {
    await this.enter('getIssues', [keys]);
    return this.issues.filter((i) => keys.includes(i.key));
  }

  async getComments(key: string) {
    await this.enter('getComments', [key]);
    return this.comments.get(key) ?? [];
  }
}
