import { defineConfig, devices } from '@playwright/test';

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;

export default defineConfig({
  testDir: './tests/e2e',
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173',
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
      name: 'mobile-chromium-390',
      testMatch: /release-candidate\.spec\.ts/,
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
      url: 'http://127.0.0.1:4174/api/timer',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'npm run dev -- --host localhost --port 4173',
      env: { KAOYAN_API_ORIGIN: 'http://127.0.0.1:4174' },
      url: 'http://localhost:4173',
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
