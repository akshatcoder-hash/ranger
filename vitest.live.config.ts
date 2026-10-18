import { defineConfig } from 'vitest/config';

/** Opt-in live Instabox suite. Default npm test does not include it. */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/live/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    hookTimeout: 120000,
    testTimeout: 600000,
    maxWorkers: 1,
    fileParallelism: false,
  },
});
