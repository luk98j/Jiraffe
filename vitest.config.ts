import { defineConfig } from 'vitest/config';

const setupFiles = [new URL('./vitest.setup.ts', import.meta.url).pathname];
const pkg = (name: string) => ({
  test: { name, root: `packages/${name}`, include: ['test/**/*.test.ts'], setupFiles },
});

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      { test: { name: 'root', include: ['tests/**/*.test.ts'], setupFiles } },
      pkg('adapters'),
      pkg('core'),
      pkg('db'),
      pkg('engine'),
      pkg('jira'),
      pkg('server'),
      'packages/web',
    ],
  },
});
