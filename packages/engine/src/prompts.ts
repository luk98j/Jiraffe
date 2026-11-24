import type { MessageDto } from '@jiraffe/core';

export type AnalysisRole = 'analyst' | 'architect';

const ROLE_TEXT: Record<AnalysisRole, string> = {
  analyst:
    'You are the business analyst. Check acceptance criteria, edge cases, the audience and scope gaps.',
  architect:
    'You are the software architect. Check the impact on existing code, dependencies, non-functional requirements and risks.',
};

const CONTRACT = `End your answer with exactly one fenced JSON block, and nothing after it:

\`\`\`json
{
  "verdict": "READY or NEEDS_INFO",
  "questions": ["questions for the user, empty when READY"],
  "missing": ["missing information, for example acceptance criteria"],
  "permissions": ["read: src/billing/**", "write: src/billing/**", "run: gradle test"],
  "summary": "one sentence"
}
\`\`\`

Use READY only when nothing is unclear. A READY verdict must have empty "questions" and "missing".`;

export interface PromptInput {
  role: AnalysisRole;
  title: string;
  body: string;
  messages: Pick<MessageDto, 'role' | 'source' | 'content'>[];
  /** Answers of earlier agents in this analysis, oldest first. */
  previous: { role: AnalysisRole; answer: string }[];
}

/** Pure: builds the prompt from the task data only. It never reads the environment. */
export function buildAnalysisPrompt(i: PromptInput): string {
  const parts = [
    ROLE_TEXT[i.role],
    'This is a read-only analysis. Do not create, change or delete any file, and do not run any command that changes the repository or its state.',
    `# Task\nTitle: ${i.title}\n\nDescription:\n${i.body || '(empty)'}`,
  ];
  if (i.messages.length > 0) {
    parts.push(
      `# Message history\n${i.messages.map((m) => `[${m.source}] ${m.role}: ${m.content}`).join('\n')}`,
    );
  }
  for (const p of i.previous) parts.push(`# Earlier answer (${p.role})\n${p.answer}`);
  parts.push(`# Output\n${CONTRACT}`);
  return parts.join('\n\n');
}
