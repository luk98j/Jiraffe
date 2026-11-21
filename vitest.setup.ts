import { beforeEach } from 'vitest';

// Tests never see Jira credentials and never touch the network (AC-5).
for (const key of Object.keys(process.env)) {
  if (key.startsWith('JIRA_')) delete process.env[key];
}

beforeEach(() => {
  globalThis.fetch = () => {
    throw new Error('network disabled in tests');
  };
});
