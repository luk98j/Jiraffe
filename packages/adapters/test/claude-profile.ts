import { claudeProfile, type ClaudeProfile } from '../src/index.ts';

// Made-up flags marked confirmed, only here, to prove the builder emits exactly what the
// profile says and nothing else. They are not real Claude Code flags.
export const testOnlyClaudeProfile: ClaudeProfile = {
  ...claudeProfile,
  prompt: { status: 'confirmed', note: 'test only', args: (p) => ['--test-prompt', p] },
  maxBudget: { status: 'confirmed', note: 'test only', args: (n) => ['--test-budget', String(n)] },
  model: { status: 'confirmed', note: 'test only', args: (m) => [`--test-model=${m}`] },
  allowTool: {
    status: 'confirmed',
    note: 'test only',
    args: (tools) => tools.flatMap((t) => ['--test-allow', t]),
  },
};
