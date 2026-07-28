#!/ccserver-sandbox-node
// Runs INSIDE the sandbox as git's credential.helper (bound at a fixed
// path; see sandbox.js). Speaks the git credential helper protocol
// (https://git-scm.com/docs/git-credential#IOFMT): `get` reads key=value
// lines from stdin and, if allowed, prints username/password to stdout.
//
// The actual allow/deny decision and the token itself live on the host —
// this script only relays host+path to the git-broker over a Unix socket
// (path from $CCSANDBOX_GIT_BROKER_SOCK) and prints whatever the broker
// says. It never sees or stores a token beyond this single process's
// lifetime, and holds no credential of its own.
//
// Fails closed: any broker error, timeout, or missing socket env means
// "print nothing, exit non-zero" — git then reports an auth failure
// rather than hanging or silently using a stale/wrong credential.
'use strict';

const net = require('net');

const action = process.argv[2];

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
    process.stdin.resume();
  });
}

function parseInput(text) {
  const out = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    out[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return out;
}

function requestCredential(req, sockPath) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };

    let sock;
    try {
      sock = net.createConnection(sockPath);
    } catch {
      finish(null);
      return;
    }

    const timer = setTimeout(() => { sock.destroy(); finish(null); }, 3000);
    let buf = '';
    sock.on('connect', () => sock.end(`${JSON.stringify(req)}\n`));
    sock.on('data', (chunk) => { buf += chunk; });
    sock.on('end', () => {
      clearTimeout(timer);
      try { finish(JSON.parse(buf)); } catch { finish(null); }
    });
    sock.on('error', () => { clearTimeout(timer); finish(null); });
  });
}

async function main() {
  // store/erase: no-op. Still drain stdin so git doesn't see a broken pipe.
  if (action === 'store' || action === 'erase') {
    await readStdin();
    process.exit(0);
  }
  if (action !== 'get') process.exit(1);

  const input = parseInput(await readStdin());
  const sockPath = process.env.CCSANDBOX_GIT_BROKER_SOCK;
  if (!sockPath) process.exit(1);

  const req = {
    op: 'credential',
    protocol: input.protocol || 'https',
    host: input.host || '',
    path: input.path || '',
  };

  const result = await requestCredential(req, sockPath);
  if (result && result.ok) {
    process.stdout.write(`username=${result.username}\npassword=${result.password}\n`);
    process.exit(0);
  }
  process.exit(1);
}

main();
