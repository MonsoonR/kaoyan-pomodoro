import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      'virtual:pwa-register/react': fileURLToPath(new URL('./src/test/pwa-register.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    setupFiles: ['./src/test/indexeddb.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
