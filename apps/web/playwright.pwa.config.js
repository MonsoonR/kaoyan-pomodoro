import { defineConfig, devices } from '@playwright/test';

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;

export default defineConfig({
  testDir: './tests/pwa',
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  outputDir: 'test-results/pwa',
  use: {
    baseURL: 'https://localhost:4173',
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
    launchOptions: {
      ...(executablePath ? { executablePath } : {}),
      args: [...(executablePath ? ['--no-sandbox'] : []), '--ignore-certificate-errors'],
    },
  },
  projects: [{ name: 'chromium-pwa', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node --import ../api/node_modules/tsx/dist/loader.mjs tests/e2e/support/test-server.ts',
      url: 'http://127.0.0.1:4174/api/health/live',
      env: { KAOYAN_APP_ORIGIN: 'https://localhost:4173' },
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'pnpm build && node tests/pwa/support/https-server.mjs',
      url: 'https://localhost:4173',
      ignoreHTTPSErrors: true,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
