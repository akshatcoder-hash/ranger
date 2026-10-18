import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/e2e/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    hookTimeout: 60000,
    testTimeout: 60000,
    maxWorkers: 1,
  },
});
