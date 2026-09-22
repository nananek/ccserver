// H1 follow-up (PR #178 review): the network broker's admin token must not be
// recoverable from anything a same-UID process can read off the broker process
// itself. The review's threat model is a sandboxed agent reading the broker's
// argv/env (macOS: KERN_PROCARGS2 -- see sandbox-seatbelt.exec.test.js's
// sibling probe; Linux: /proc/PID/{cmdline,environ}) to call /__admin/mode or
// /__admin/allowlist and unlock its own egress policy. network-broker.js hands
// the token to the child over its private stdin pipe at startup instead
// (readAdminTokenFromStdin), so these tests assert the negative against a real
// broker process, with the proxy token as a positive control: it IS in the
// broker's env by design (it also has to end up in the sandbox's own
// HTTP_PROXY), so a probe that cannot see it cannot see anything.
//
// The failure-path half at the bottom pins the parent-side handshake
// hardening from the same review: a child that gets EOF or an oversized
// payload, or that never listens at all, must reject the launch, reap the
// child, and leave no runtime dir behind -- never leave an unauthenticated
// server or a stray directory waiting around.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn as spawnFn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startNetworkBroker } from './network-broker.js';

// /proc/<pid>/environ + cmdline are how this file reads a sibling process's
// argv/env; the macOS analogue (KERN_PROCARGS2) is covered by the seatbelt
// exec suite, which skips on Linux for the same reason this file skips on
// macOS.
const LINUX_ONLY = { skip: process.platform !== 'linux' };

const brokers = [];
after(() => {
  for (const b of brokers) {
    try { b.proc.kill('SIGKILL'); } catch { /* already dead */ }
    try { rmSync(b.dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function adminPost(port, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(data),
      },
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

function waitForExit(proc, timeoutMs) {
  if (proc.exitCode !== null || proc.signalCode !== null) {
    return Promise.resolve({ code: proc.exitCode, signal: proc.signalCode });
  }
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), timeoutMs);
    proc.on('exit', (code, signal) => { clearTimeout(t); resolve({ code, signal }); });
  });
}

test('H1: the admin token is absent from the broker env, argv, and runtime files (Linux /proc probe)', LINUX_ONLY, async () => {
  const broker = await startNetworkBroker({ allowedHosts: [] });
  brokers.push(broker);
  assert.notEqual(broker.token, broker.adminToken, 'proxy and admin token must be independent secrets');

  const environRaw = readFileSync(`/proc/${broker.proc.pid}/environ`, 'utf8');
  // Positive control: the proxy token IS deliberately in the broker's env, so
  // a working probe must see it -- otherwise the negative assertions below
  // would be vacuous.
  assert.ok(
    environRaw.split('\0').includes(`CCSANDBOX_NETWORK_BROKER_TOKEN=${broker.token}`),
    'positive control: the proxy token must be visible in the broker env via /proc',
  );
  assert.ok(!environRaw.includes(broker.adminToken), 'admin token must not be in the broker env');
  assert.ok(!environRaw.includes('CCSANDBOX_NETWORK_BROKER_ADMIN_TOKEN'), 'no admin-token env var may exist at all');

  const cmdline = readFileSync(`/proc/${broker.proc.pid}/cmdline`, 'latin1');
  assert.ok(!cmdline.includes(broker.adminToken), 'admin token must not be in the broker argv');

  for (const name of readdirSync(broker.dir)) {
    const text = readFileSync(join(broker.dir, name), 'latin1');
    assert.ok(!text.includes(broker.adminToken), `admin token must not be written to the runtime file ${name}`);
  }
});

test('H1: every credential extractable from the broker env/argv is rejected by both admin endpoints', LINUX_ONLY, async () => {
  const broker = await startNetworkBroker({ allowedHosts: [] });
  brokers.push(broker);

  // Simulate the attacker: harvest every 32-char base64url-looking string and
  // every env value from the broker's own readable argv/env, then try each as
  // an admin credential.
  const environRaw = readFileSync(`/proc/${broker.proc.pid}/environ`, 'utf8');
  const cmdline = readFileSync(`/proc/${broker.proc.pid}/cmdline`, 'latin1');
  const candidates = new Set();
  for (const kv of environRaw.split('\0')) {
    const i = kv.indexOf('=');
    if (i > 0) candidates.add(kv.slice(i + 1));
  }
  for (const m of `${environRaw}\0${cmdline}`.matchAll(/[A-Za-z0-9_-]{32}/g)) candidates.add(m[0]);
  assert.ok(candidates.has(broker.token), 'positive control: the proxy token is extractable (by design)');
  assert.ok(!candidates.has(broker.adminToken), 'admin token must not be among the extractable strings');

  for (const candidate of candidates) {
    const mode = await adminPost(broker.port, '/__admin/mode', candidate, { mode: 'open' });
    assert.equal(mode.status, 401, 'no extractable credential may flip the live mode');
    const allowlist = await adminPost(broker.port, '/__admin/allowlist', candidate, { hosts: ['evil.example'] });
    assert.equal(allowlist.status, 401, 'no extractable credential may replace the allow-list');
  }

  // The real admin token still works, so the 401s above are auth rejections
  // and not a broken endpoint.
  const accepted = await adminPost(broker.port, '/__admin/mode', broker.adminToken, { mode: 'open' });
  assert.equal(accepted.status, 200);
});

test('H1: neither the admin nor the proxy token ever appears in the broker logs', async () => {
  const captured = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  // Tee: the broker forwards its child stdout/stderr through these, so a token
  // printed anywhere along the startup/toggle path would land in `captured`.
  process.stdout.write = (chunk, ...a) => { captured.push(String(chunk)); return origOut(chunk, ...a); };
  process.stderr.write = (chunk, ...a) => { captured.push(String(chunk)); return origErr(chunk, ...a); };
  try {
    const broker = await startNetworkBroker({ allowedHosts: [] });
    brokers.push(broker);
    await adminPost(broker.port, '/__admin/mode', broker.adminToken, { mode: 'open' });
    await new Promise((resolve) => setTimeout(resolve, 50)); // let forwarded child output flush
    const logs = captured.join('');
    assert.ok(!logs.includes(broker.adminToken), 'admin token must never be logged');
    assert.ok(!logs.includes(broker.token), 'proxy token must never be logged');
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
});

test('H1: handshake failures (EOF, oversized payload, never-listening child) reject the launch and leave no runtime dir', async () => {
  // Point the broker runtime dir at a private, empty dir so "no leftovers"
  // cannot be confused with -- or disturbed by -- dirs from concurrently
  // running test files. hostRuntimeDir() honours XDG_RUNTIME_DIR.
  const prevXdg = process.env.XDG_RUNTIME_DIR;
  const priv = mkdtempSync(join(tmpdir(), 'ccserver-nb-handshake-test-'));
  process.env.XDG_RUNTIME_DIR = priv;
  try {
    // (a) The child sees an immediate EOF with no token: it must refuse to
    //     start, and startNetworkBroker must surface that as a failed launch.
    let eofChild = null;
    await assert.rejects(
      () => startNetworkBroker({}, {
        spawnProcess: (cmd, args, opts) => { eofChild = spawnFn(cmd, args, opts); eofChild.stdin.end(); return eofChild; },
      }),
      /network broker failed to start/,
    );
    assert.ok(await waitForExit(eofChild, 3000), 'child must be dead after the failed launch');
    assert.deepEqual(readdirSync(priv), [], 'no runtime dir may survive the failed launch');

    // (b) An oversized payload (written before the real token): the child
    //     rejects it, so the whole launch must fail and clean up too.
    let bigChild = null;
    await assert.rejects(
      () => startNetworkBroker({}, {
        spawnProcess: (cmd, args, opts) => { bigChild = spawnFn(cmd, args, opts); bigChild.stdin.write('z'.repeat(1000)); return bigChild; },
      }),
      /network broker failed to start/,
    );
    assert.ok(await waitForExit(bigChild, 3000), 'child must be dead after the failed launch');
    assert.deepEqual(readdirSync(priv), [], 'no runtime dir may survive the failed launch');

    // (c) The child never listens: startNetworkBroker must give up on its
    //     readiness deadline, SIGKILL the child, and remove the directory.
    let hungChild = null;
    const t0 = Date.now();
    await assert.rejects(
      () => startNetworkBroker({}, {
        spawnProcess: (cmd, args, opts) => { hungChild = spawnFn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], opts); return hungChild; },
      }),
      /port file not ready within 2s/,
    );
    assert.ok(Date.now() - t0 >= 1900, 'must wait for the readiness deadline before giving up');
    assert.ok(await waitForExit(hungChild, 3000), 'timed-out child must be killed');
    assert.deepEqual(readdirSync(priv), [], 'no runtime dir may survive the timed-out launch');
  } finally {
    if (prevXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = prevXdg;
    try { rmSync(priv, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});
