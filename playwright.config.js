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
    // HOME is redirected into $T as well, and that is not optional. The
    // registry's legacyDataRoot() is homedir()-based on purpose (see
    // server/paths.js), so with the real $HOME this `setup --yes` would find
    // and migrate the developer's live ~/.local/share/ccserver-sandbox --
    // their SQLite DB, federation private key and group-files -- into this
    // throwaway directory. Verified: it does exactly that.
    //
    // The CCSERVER_* block on the `setup --yes` line is the other half of
    // that, and it is not optional either. Eight registry entries have their
    // legacy location inside the CHECKOUT (server/sandbox.config.json and the
    // seven state JSONs at the repo root), and repoRoot() is
    // import.meta.url-based -- no environment variable moves it. Without
    // these overrides `setup --yes` migrates the developer's live
    // sandbox.config.json and saved-* state into $T on every e2e run.
    // Verified: it does exactly that. (Same defect as the unit-test side;
    // server/testIsolation.js is where that one is handled and explained.)
    //
    // They are set ONLY on the wizard line, deliberately. The wizard reports
    // them as `env-override` and leaves them alone; the SERVER then starts
    // without them, so at runtime it resolves the real migrated layout under
    // $T/state and $T/config -- which is the production path this suite is
    // supposed to be evidence for.
    //
    // CCSERVER_HOST=127.0.0.1: this suite never sets CCSERVER_TOKEN/
    // CCSERVER_AUTH_MODE, so AUTH_MODE resolves to 'none' -- and the H3 fix
    // (server/index.js) refuses to boot with none-mode on the server's
    // 0.0.0.0 default bind. BASE_URL above is already localhost.
    command: `T=$(mktemp -d /tmp/ccserver-e2e.XXXXXX) && mkdir -p $T/home $T/checkout && npm run build --workspace=client && `
      + `env HOME=$T/home XDG_CONFIG_HOME=$T/config XDG_DATA_HOME=$T/data XDG_STATE_HOME=$T/state `
      + `CCSERVER_SANDBOX_CONFIG=$T/checkout/sandbox.config.json `
      + `CCSERVER_SAVED_SESSIONS_PATH=$T/checkout/saved-sessions.json `
      + `CCSERVER_SCHEDULES_PATH=$T/checkout/scheduled-prompts.json `
      + `CCSERVER_GROUPS_PATH=$T/checkout/saved-groups.json `
      + `CCSERVER_GROUP_DOCS_PATH=$T/checkout/saved-group-docs.json `
      + `CCSERVER_GROUP_FILES_PATH=$T/checkout/saved-group-files.json `
      + `CCSERVER_NOTIFY_PATH=$T/checkout/saved-notifications.json `
      + `CCSERVER_VIKUNJA_TASKS_PATH=$T/checkout/saved-vikunja-tasks.json `
      + `node server/cli/setup.js --yes && `
      + `env HOME=$T/home XDG_CONFIG_HOME=$T/config XDG_DATA_HOME=$T/data XDG_STATE_HOME=$T/state `
      + `NODE_ENV=production PORT=${PORT} CCSERVER_HOST=127.0.0.1 node server/index.js`,
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
