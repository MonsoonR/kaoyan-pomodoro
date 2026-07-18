import { defineConfig, devices } from '@playwright/test';

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
const webPort = Number(process.env.KAOYAN_E2E_WEB_PORT ?? 4173);
const apiPort = Number(process.env.KAOYAN_E2E_API_PORT ?? 4174);
const webOrigin = `https://localhost:${webPort}`;
const apiOrigin = `http://127.0.0.1:${apiPort}`;

export default defineConfig({
  testDir: './tests/pwa',
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  outputDir: 'test-results/pwa',
  use: {
    baseURL: webOrigin,
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
      url: `${apiOrigin}/api/health/live`,
      env: { KAOYAN_E2E_API_PORT: String(apiPort), KAOYAN_APP_ORIGIN: webOrigin },
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'pnpm build && node tests/pwa/support/https-server.mjs',
      env: { KAOYAN_E2E_WEB_PORT: String(webPort), KAOYAN_E2E_API_PORT: String(apiPort) },
      url: webOrigin,
      ignoreHTTPSErrors: true,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
