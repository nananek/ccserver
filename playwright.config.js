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
    // A throwaway XDG triple keeps the whole of the e2e server's state out
    // of the repo root and out of the operator's real dirs -- the DB and its
    // WAL/SHM sidecars, the saved-*.json state files, federation, the
    // sandbox home, dind. (It replaces three CCSERVER_*_PATH overrides that
    // only covered groups, sessions and the DB file itself; anything with an
    // env var set would also be reported as "env-override" by the wizard,
    // so e2e would exercise a path production never takes.)
    //
    // `setup --yes` runs first because of the #201 gate: an un-migrated host
    // refuses every state-creating request with 503. Running it here means
    // the wizard's fresh-install path is exercised by every e2e run, which
    // is most of what makes this suite evidence that setup+gate work.
    //
    // CCSERVER_HOST=127.0.0.1: this suite never sets CCSERVER_TOKEN/
    // CCSERVER_AUTH_MODE, so AUTH_MODE resolves to 'none' -- and the H3 fix
    // (server/index.js) refuses to boot with none-mode on the server's
    // 0.0.0.0 default bind. BASE_URL above is already localhost.
    command: `T=$(mktemp -d /tmp/ccserver-e2e.XXXXXX) && npm run build --workspace=client && `
      + `XDG_CONFIG_HOME=$T/config XDG_DATA_HOME=$T/data XDG_STATE_HOME=$T/state node server/cli/setup.js --yes && `
      + `NODE_ENV=production PORT=${PORT} CCSERVER_HOST=127.0.0.1 `
      + `XDG_CONFIG_HOME=$T/config XDG_DATA_HOME=$T/data XDG_STATE_HOME=$T/state node server/index.js`,
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
