export interface JiraIssue {
  key: string;
  projectKey: string;
  title: string;
  description: string | null;
  statusName: string;
  statusCategory: 'new' | 'indeterminate' | 'done';
}

export interface JiraComment {
  id: string;
  body: string;
  createdAt: string;
}

export interface JiraClient {
  searchPage(jql: string, cursor?: string): Promise<{ issues: JiraIssue[]; nextCursor?: string }>;
  /** Lookup by key, used to detect issues closed in Jira. */
  getIssues(keys: string[]): Promise<JiraIssue[]>;
  getComments(key: string): Promise<JiraComment[]>;
}

/** The message is a fixed phrase and never contains the token, e-mail or URL. */
export class JiraError extends Error {
  constructor(
    readonly kind: 'auth' | 'rate_limit' | 'server' | 'network',
    message: string,
  ) {
    super(message);
    this.name = 'JiraError';
  }
}
