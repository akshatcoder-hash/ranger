import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    hookTimeout: 30000,
    testTimeout: 30000,
    // Bounded concurrency on the 4-CPU host (mission boundary).
    maxWorkers: 2,
  },
});
