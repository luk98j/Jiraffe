import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    name: 'web',
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: [
      new URL('../../vitest.setup.ts', import.meta.url).pathname,
      new URL('./test/setup.ts', import.meta.url).pathname,
    ],
  },
});
