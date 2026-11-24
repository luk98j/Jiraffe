import type { MessageDto, Verdict } from '@jiraffe/core';

export interface ContextInput {
  key: string;
  status: string;
  analysis: { role: string; verdict: Verdict }[];
  /** User and Jira messages; agent questions are in the verdicts. */
  comments: Pick<MessageDto, 'source' | 'content' | 'createdAt'>[];
}

const list = (title: string, items: string[]) =>
  items.length > 0 ? [`${title}:`, ...items.map((i) => `- ${i}`)] : [];

/** Permissions the agents proposed, without duplicates. Shown to the agent as information only. */
export const permissionsOf = (analysis: ContextInput['analysis']): string[] => [
  ...new Set(analysis.flatMap((a) => a.verdict.permissions)),
];

/**
 * One text for both `.orchestrator/context.md` and the `{{context}}` part of the prompt, so
 * they are the same snapshot. Built from task data only, never from the environment.
 */
export function buildContext(i: ContextInput): string {
  const out = [`# Context for ${i.key}`, '', `Status: ${i.status}`, '', '## Analysis'];
  if (i.analysis.length === 0) out.push('(none)');
  for (const a of i.analysis) {
    out.push(
      `### ${a.role}: ${a.verdict.verdict}`,
      a.verdict.summary,
      ...list('Questions', a.verdict.questions),
      ...list('Missing', a.verdict.missing),
      '',
    );
  }
  out.push('## Comments');
  if (i.comments.length === 0) out.push('(none)');
  for (const c of i.comments) out.push(`- [${c.source}] ${c.createdAt}: ${c.content}`);
  const permissions = permissionsOf(i.analysis);
  out.push('', '## Permissions proposed by the analysis (information only, not applied)');
  out.push(...(permissions.length > 0 ? permissions.map((p) => `- ${p}`) : ['(none)']));
  return `${out.join('\n')}\n`;
}
