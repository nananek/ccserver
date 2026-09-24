// Prints the test-isolation environment as shell `export` lines, for the
// callers that launch server/cli/setup.js from a SHELL rather than from
// JavaScript (issue #201).
//
//   eval "$(node server/tools/isolated-env.js "$T")"
//   node server/cli/setup.js --yes
//
// WHY THIS EXISTS
//
// The wizard moves files. Keeping it away from real data needs $HOME, the
// three XDG roots, AND one CCSERVER_* override per registry entry whose
// legacy location is outside $HOME (the checkout's state files, and the DB's
// pre-#190 spelling one level above the checkout -- see testIsolation.js).
//
// That list was written out by hand in three places: testIsolation.js for the
// JS callers, playwright.config.js's webServer, and the macOS workflow. The
// two shell copies were both missing CCSERVER_DB_PATH, so `npm run test:e2e`
// moved <checkout parent>/ccserver.sqlite3 into its throwaway directory --
// the fourth time on this branch that closing one entrance left another open
// (the checkout state files, then the repo-parent DB the canary caught, then
// the real legacy worktrees/ two tests mkdir'd into, then this).
//
// So there is now one definition. CHECKOUT_ENTRIES in testIsolation.js is it;
// this file just renders it for a shell, and testIsolation.test.js pins that
// every shell caller uses this instead of its own copy.

import { checkoutEnv } from '../testIsolation.js';

const dir = process.argv[2];
if (!dir || !dir.startsWith('/')) {
  console.error('usage: node server/tools/isolated-env.js <absolute-scratch-dir>');
  console.error('  prints `export KEY=VALUE` lines to eval in a shell before running the wizard');
  process.exit(2);
}

// Single-quoted with embedded quotes escaped, so a path with a space or a
// quote cannot turn into extra shell words.
const quote = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`;

const env = {
  HOME: `${dir}/home`,
  XDG_CONFIG_HOME: `${dir}/config`,
  XDG_DATA_HOME: `${dir}/data`,
  XDG_STATE_HOME: `${dir}/state`,
  ...checkoutEnv(dir),
};

for (const [key, value] of Object.entries(env)) {
  console.log(`export ${key}=${quote(value)}`);
}
// The directories the wizard will not create for itself.
console.log(`mkdir -p ${quote(`${dir}/home`)} ${quote(`${dir}/checkout`)}`);
