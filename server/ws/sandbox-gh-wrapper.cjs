#!/ccserver-sandbox-node
// Runs INSIDE the sandbox, bound over every discovered `gh` binary path (see
// sandbox.js). Relays the invocation to the host-side git-broker over the
// same Unix socket used for git HTTPS credentials (path from
// $CCSANDBOX_GIT_BROKER_SOCK -- see git-broker.js for the protocol and
// ghAllowlist.js for which subcommands/repos are actually allowed through).
//
// This process never sees a gh token: the real `gh` binary runs on the
// host, inside the broker, using the host's own gh auth. This script only
// forwards argv + stdin and relays back stdout/stderr/exit code.
//
// No TTY is attached on the other side, so only non-interactive gh usage
// (all required input via flags, or piped stdin) works -- gh's interactive
// prompts/editor flows can't be proxied through this bridge.
//
// Fails closed: missing/unreachable broker, or a broker denial, prints a
// message to stderr and exits 1 rather than silently doing nothing or
// falling back to any local gh config (there is none -- ~/.config/gh is
// never exposed to the sandbox).
'use strict';

const net = require('net');

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks)));
    process.stdin.on('error', () => resolve(Buffer.concat(chunks)));
    process.stdin.resume();
  });
}

function requestExec(req, sockPath) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (val) => { if (!settled) { settled = true; resolve(val); } };

    let sock;
    try {
      sock = net.createConnection(sockPath);
    } catch {
      finish(null);
      return;
    }

    // Generous timeout: gh commands run for real on the host (network round
    // trip to GitHub), well above the git-broker's own internal exec timeout.
    const timer = setTimeout(() => { sock.destroy(); finish(null); }, 35000);
    const chunks = [];
    sock.on('connect', () => sock.end(`${JSON.stringify(req)}\n`));
    sock.on('data', (c) => chunks.push(c));
    sock.on('end', () => {
      clearTimeout(timer);
      try { finish(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); } catch { finish(null); }
    });
    sock.on('error', () => { clearTimeout(timer); finish(null); });
  });
}

const DENY_MESSAGES = {
  'subcommand-not-allowed': (argv) => `sandbox: 'gh ${argv.slice(0, 2).join(' ')}' is not on the allowed gh-broker command list (see README "gh broker")`,
  'repo-unresolved': () => 'sandbox: could not resolve a target repo for this gh command (pass --repo owner/repo, or run inside a repo with an origin remote)',
  'not-allowlisted': () => 'sandbox: gh access to this repo is not allow-listed for this session',
  'bad-request': () => 'sandbox: malformed gh-broker request',
  'exec-failed': () => 'sandbox: gh-broker failed to run gh on the host',
  timeout: () => 'sandbox: gh-broker timed out running this gh command',
};

async function main() {
  const argv = process.argv.slice(2);
  const sockPath = process.env.CCSANDBOX_GIT_BROKER_SOCK;

  // Reading stdin blocks until EOF; on an interactive TTY that never comes
  // (no piped input), so skip it there rather than hang.
  const stdinBuf = process.stdin.isTTY ? Buffer.alloc(0) : await readStdin();

  if (!sockPath) {
    process.stderr.write('sandbox: gh broker not configured (CCSANDBOX_GIT_BROKER_SOCK unset)\n');
    process.exit(1);
  }

  const req = { op: 'gh-exec', argv, stdin: stdinBuf.length ? stdinBuf.toString('base64') : undefined };
  const result = await requestExec(req, sockPath);

  if (!result) {
    process.stderr.write('sandbox: gh broker unreachable (crashed or not started); gh is unavailable\n');
    process.exit(1);
  }
  if (!result.ok) {
    const describe = DENY_MESSAGES[result.reason];
    process.stderr.write(`${describe ? describe(argv) : `sandbox: gh command denied (${result.reason})`}\n`);
    process.exit(1);
  }

  if (result.stdout) process.stdout.write(Buffer.from(result.stdout, 'base64'));
  if (result.stderr) process.stderr.write(Buffer.from(result.stderr, 'base64'));
  process.exit(typeof result.exitCode === 'number' ? result.exitCode : 1);
}

main();
