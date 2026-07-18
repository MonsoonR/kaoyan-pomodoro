import { defineConfig, devices } from '@playwright/test';

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
const webPort = Number(process.env.KAOYAN_E2E_WEB_PORT ?? 4173);
const apiPort = Number(process.env.KAOYAN_E2E_API_PORT ?? 4174);
const webOrigin = `http://localhost:${webPort}`;
const apiOrigin = `http://127.0.0.1:${apiPort}`;

export default defineConfig({
  testDir: './tests/e2e',
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  outputDir: 'test-results/e2e',
  use: {
    baseURL: webOrigin,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'desktop-chrome',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 1000 },
        launchOptions: executablePath ? { executablePath, args: ['--no-sandbox'] } : undefined,
      },
    },
    {
      name: 'tablet-chromium-820',
      testMatch: /(?:page-coverage|permissions-responsive)\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 820, height: 1180 },
        hasTouch: true,
        launchOptions: executablePath ? { executablePath, args: ['--no-sandbox'] } : undefined,
      },
    },
    {
      name: 'mobile-chromium-390',
      testMatch: /(?:page-coverage|permissions-responsive|release-candidate)\.spec\.ts/,
      use: {
        ...devices['Pixel 5'],
        viewport: { width: 390, height: 844 },
        launchOptions: executablePath ? { executablePath, args: ['--no-sandbox'] } : undefined,
      },
    },
  ],
  webServer: [
    {
      command: 'node --import ../api/node_modules/tsx/dist/loader.mjs tests/e2e/support/test-server.ts',
      url: `${apiOrigin}/api/timer`,
      env: { KAOYAN_E2E_API_PORT: String(apiPort), KAOYAN_APP_ORIGIN: webOrigin },
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `npm run dev -- --host localhost --port ${webPort}`,
      env: { KAOYAN_API_ORIGIN: apiOrigin },
      url: webOrigin,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
