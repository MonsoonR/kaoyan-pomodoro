import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./src/test/indexeddb.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
