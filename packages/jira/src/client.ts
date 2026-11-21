import type { JiraClient, JiraIssue } from './types.ts';

/** Follows the opaque cursor until the last page. */
export async function fetchAllIssues(client: JiraClient, jql: string): Promise<JiraIssue[]> {
  const all: JiraIssue[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.searchPage(jql, cursor);
    all.push(...page.issues);
    cursor = page.nextCursor;
  } while (cursor);
  return all;
}
