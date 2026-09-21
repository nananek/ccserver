#!/usr/bin/env node
// Phase 1 diagnostic for "Terminal exits immediately (code 0) under /Users
// but works under /" on the macOS seatbelt backend. READ-ONLY on the repo:
// it only generates profiles into /tmp and prints commands to run by hand.
// Root cause found and fixed: macOS startup requires reading "/" itself
// (see docs/seatbelt-root-read-abort-diagnosis.md); this script remains as
// a profile-delta repro tool for future seatbelt launch issues.
//
// Usage (on the Mac, from the repo root):
//   node scripts/seatbelt-diagnose.mjs [cwd-that-fails]
// e.g.
//   node scripts/seatbelt-diagnose.mjs /Users/you/some/project
//
// What it does:
//   1. Builds a seatbelt launch for cwd=/ and for the failing cwd with the
//      same shape buildSandboxSpawn uses for a shell. gitBroker/commitGuard/
//      sockets are kept OFF to isolate the cwd-driven profile delta (their
//      wiring is identical between the two cwds).
//   2. Prints the cwd-specific profile delta.
//   3. Prints sandbox-exec one-liners to reproduce the launch outside the
//      server (profile + env + a trivial shell command), plus environment
//      sanity checks (/Users reachability, $SHELL).

import { mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const failCwd = resolve(process.argv[2] || join(homedir(), 'Documents'));
const outDir = '/tmp/ccserver-seatbelt-diag';
mkdirSync(outDir, { recursive: true });

// Same script paths seatbeltScripts() wires up in sandbox.js. fileURLToPath
// (not URL.pathname) so spaces in the repo path stay spaces -- URL.pathname
// percent-encodes them and the resulting profile rules would never match.
const wsDir = fileURLToPath(new URL('../server/ws/', import.meta.url));
const scripts = {
  ghWrapper: join(wsDir, 'sandbox-gh-wrapper.cjs'),
  credHelper: join(wsDir, 'sandbox-git-credential-helper.cjs'),
  sshWrapper: join(wsDir, 'sandbox-ssh-wrapper.cjs'),
  commitHook: join(wsDir, 'sandbox-commit-msg-hook.cjs'),
  entrypoint: join(wsDir, 'sandbox-entrypoint.sh'),
  mcpBridge: join(wsDir, 'sandbox-mcp-wrapper.cjs'),
};

const { buildSeatbeltLaunch, seatbeltEnvArgs } = await import('../server/ws/sandbox-seatbelt.js');
const { SANDBOX_PATH } = await import('../server/ws/sandbox.js');

function buildFor(cwd, tag) {
  const sb = buildSeatbeltLaunch({
    cwd,
    hostHome: homedir(),
    homeDir: null,
    sandboxPathBase: SANDBOX_PATH,
    nodeBin: realpathSync(process.execPath),
    scripts,
    // opencode session shape (XDG redirect); the profile delta is app-
    // independent, but the env block then matches the real launch.
    app: 'opencode',
    ssh: {}, gitBroker: null, commitGuard: null,
    sockets: {}, extraBinds: [], extraEnv: {},
    authSock: null, gnupg: false, claudeDir: null,
    orchestratorClaudeMdSrc: null, gitCommonDir: null, groupFilesDir: null,
    tools: null,
  });
  // Copy the generated profile next to the diff-able location (the launch
  // runtime dir is removed when the session tears down, so keep a copy).
  const dest = join(outDir, `profile-${tag}.sb`);
  writeFileSync(dest, readFileSync(sb.profilePath, 'utf-8'));
  return { dest, sb, env: seatbeltEnvArgs(sb.env) };
}

const a = buildFor('/', 'root');
const b = buildFor(failCwd, 'fails');

console.log(`profiles written:
  ${a.dest}
  ${b.dest}
(per-launch runtime dirs kept for inspection:
  ${a.sb.dir}
  ${b.sb.dir} )
`);

// cwd-specific delta (may be empty for non-git cwds -- that itself is a
// finding: the difference is then NOT in the profile text).
const lines = (p) => readFileSync(p, 'utf-8').split('\n');
const la = lines(a.sb.profilePath);
const lb = lines(b.sb.profilePath);
const diff = [];
for (let i = 0; i < Math.max(la.length, lb.length); i++) {
  if (la[i] !== lb[i]) diff.push(`- ${la[i] ?? ''}\n+ ${lb[i] ?? ''}`);
}
console.log('cwd-driven profile delta:');
console.log(diff.length ? diff.join('\n') : '(identical -- the difference is NOT in the profile text)');

console.log(`
Next steps, by hand:

1) reproduce the failing launch outside the server with a trivial shell --
   if THIS exits 0 immediately, the problem is the profile/env; if it prints
   OK, the problem is the server's spawn path (shell/dotfile):

   sandbox-exec -f ${b.dest} /usr/bin/env \\
${b.env.map((e) => `     ${e}`).join(' \\\n')} \\
     /bin/bash --noprofile --norc -c 'echo OK; exit 3'

   (compare with the root profile: -f ${a.dest} and its env block)

2) sanity checks:
   ls -ld /Users '${failCwd}'            # reachable from the server process?
   echo "$SHELL"; "$SHELL" -c 'echo ok'  # shell itself healthy?

3) after a failing launch from the UI, grab the runtime dir the server
   minted for it (under \$CCSERVER_SANDBOX_SEATBELT_TMP, i.e. tmpdir, look
   for ccserver-seatbelt-* -- the newest one) and re-run step 1 with THAT
   profile + the env from its process (ps eww <pid> on the sandbox-exec
   process, or /usr/bin/env printed by the entrypoint): that profile carries
   the real gitBroker/sockets wiring the minimal one above lacks.
`);
