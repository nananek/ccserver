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
    // HOME is redirected for the WIZARD and only for the wizard -- note the
    // subshell around it. The registry's legacyDataRoot() is homedir()-based
    // on purpose (see server/paths.js), so with the real $HOME `setup --yes`
    // finds and migrates the developer's live
    // ~/.local/share/ccserver-sandbox -- their SQLite DB, federation private
    // key and group-files -- into this throwaway directory. Verified: it does
    // exactly that.
    //
    // The SERVER keeps the real $HOME, and that is deliberate too. Once the
    // marker exists the layout is v2, so every registry entry resolves under
    // the XDG roots above and legacyDataRoot() is only read (scratchRoots()'s
    // lexical check) -- the server writes nothing under $HOME, and the
    // old-old DB hop is skipped outright at v2. Meanwhile several specs
    // (breadcrumb-nested, home-tilde) compare the server's paths against the
    // TEST process's $HOME, so redirecting the server's broke four of them in
    // CI. Isolating the server's HOME bought nothing and cost those tests.
    //
    // isolated-env.js is the other half of that, and it is not optional
    // either. NINE registry entries have their legacy location outside $HOME
    // (server/sandbox.config.json and the seven state JSONs in the CHECKOUT,
    // plus the DB's pre-#190 spelling one level ABOVE it), and repoRoot() is
    // import.meta.url-based -- no environment variable moves it. Without
    // those overrides `setup --yes` migrates the developer's live
    // sandbox.config.json, saved-* state and parent-directory DB into $T on
    // every e2e run. Verified: it did exactly that.
    //
    // The list is deliberately NOT written out here. It used to be, and this
    // copy was missing CCSERVER_DB_PATH while testIsolation.js's had it --
    // which is how the parent-directory DB kept being migrated for three
    // rounds after the JS side was fixed. server/tools/isolated-env.js
    // renders the one definition (CHECKOUT_ENTRIES in testIsolation.js) for a
    // shell, and testIsolation.test.js pins that every shell caller uses it
    // and writes none of those vars by hand.
    //
    // It is eval'd ONLY for the wizard, deliberately. The wizard reports those
    // entries as `env-override` and leaves them alone; the SERVER then starts
    // without them, so at runtime it resolves the real migrated layout under
    // $T/state and $T/config -- which is the production path this suite is
    // supposed to be evidence for.
    //
    // CCSERVER_HOST=127.0.0.1: this suite never sets CCSERVER_TOKEN/
    // CCSERVER_AUTH_MODE, so AUTH_MODE resolves to 'none' -- and the H3 fix
    // (server/index.js) refuses to boot with none-mode on the server's
    // 0.0.0.0 default bind. BASE_URL above is already localhost.
    command: `T=$(mktemp -d /tmp/ccserver-e2e.XXXXXX) && npm run build --workspace=client && `
      + `( eval "$(node server/tools/isolated-env.js "$T")" && node server/cli/setup.js --yes ) && `
      + `env XDG_CONFIG_HOME=$T/config XDG_DATA_HOME=$T/data XDG_STATE_HOME=$T/state `
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
