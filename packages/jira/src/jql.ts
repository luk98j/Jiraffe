const quote = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** `projects` must already be validated against the settings schema (letters, digits, underscore). */
export function buildJql(opts: { ignoredStatuses: string[]; projects: string[] }): string {
  let jql = 'assignee = currentUser() AND statusCategory != Done';
  if (opts.ignoredStatuses.length > 0) {
    jql += ` AND status NOT IN (${opts.ignoredStatuses.map(quote).join(',')})`;
  }
  if (opts.projects.length > 0) jql += ` AND project IN (${opts.projects.join(',')})`;
  return jql;
}
