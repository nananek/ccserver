import { defineConfig, devices } from '@playwright/test';

const PORT = process.env.E2E_PORT || 3210;
const BASE_URL = `http://localhost:${PORT}`;

// By default use Playwright's bundled browser (`npx playwright install`).
// Set CHROMIUM_BIN to point at a system Chromium when the download is unavailable.
const executablePath = process.env.CHROMIUM_BIN || undefined;

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    headless: true,
    trace: 'retain-on-failure',
  },
  webServer: {
    // CCSERVER_GROUPS_PATH/CCSERVER_SAVED_SESSIONS_PATH keep the e2e server's
    // state out of the repo root: a killed test run would otherwise leave a
    // .saved-groups.json behind that the next run's restoreGroups() resurrects
    // as ghost groups.
    command: `npm run build --workspace=client && NODE_ENV=production PORT=${PORT} CCSERVER_GROUPS_PATH=$(mktemp -u /tmp/ccserver-e2e-groups.XXXXXX) CCSERVER_SAVED_SESSIONS_PATH=$(mktemp -u /tmp/ccserver-e2e-sessions.XXXXXX) node server/index.js`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(executablePath ? { launchOptions: { executablePath } } : {}),
      },
    },
  ],
});
