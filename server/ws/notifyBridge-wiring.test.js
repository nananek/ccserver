// End-to-end wiring for the notification bridge (plan: plan-notify-bridge,
// Step 3): a REAL session spawn, through node-pty, whose "agent" is a stub
// script standing in for claude. It writes its own argv to a file and then
// emits the exact OSC 777 sequence claude's ghostty channel produces, so this
// suite can assert both halves of the feature at once:
//
//   - the LAUNCH half: what actually landed on the command line. This is where
//     the "with the bridge off, the command line is byte-for-byte what it was
//     before this feature existed" invariant is checked against a real spawn
//     rather than against the pure builder (agentNotifyConfig.test.js covers
//     that separately).
//   - the DELIVERY half: pty bytes -> detector -> bridge policy -> notify.js's
//     delivery, with global.fetch stubbed so nothing leaves the machine.
//
// CCSERVER_CLAUDE_BIN is what makes this possible without the real CLI: it is
// the documented override for where `claude` lives (see sandbox.js).

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let runtimeDir;
let sessionManager;
let notifyModule;
let cfgPath;
let argvPath;
let stubBin;
const saved = {};

function writeConfig(obj) {
  writeFileSync(cfgPath, JSON.stringify(obj, null, 2));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Wait for `check()` to become truthy, so the tests never race the pty.
async function until(check, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = check();
    if (v) return v;
    if (Date.now() > deadline) return null;
    await sleep(25);
  }
}

before(async () => {
  runtimeDir = mkdtempSync(join(tmpdir(), 'ccserver-notify-wiring-'));
  cfgPath = join(runtimeDir, 'sandbox.config.json');
  argvPath = join(runtimeDir, 'argv.txt');
  stubBin = join(runtimeDir, 'fake-claude.sh');

  // The stub "agent": record argv, emit one ghostty-channel notification,
  // then idle so the session stays alive for the assertions.
  writeFileSync(stubBin, [
    '#!/bin/sh',
    `printf '%s\\n' "$@" > ${JSON.stringify(argvPath)}`,
    "printf '\\033]777;notify;Claude Code;Waiting for your input\\007'",
    // `exec` so the pty kill reaches this directly rather than orphaning it
    // behind the shell, and a short sleep so a failed cleanup cannot leave a
    // process sitting around for the rest of the suite.
    'exec sleep 10',
    '',
  ].join('\n'));
  chmodSync(stubBin, 0o755);

  for (const k of ['XDG_RUNTIME_DIR', 'CCSERVER_SANDBOX_CONFIG', 'CCSERVER_CLAUDE_BIN',
    'CCSERVER_GROUPS_PATH', 'CCSERVER_NOTIFY_PATH', 'CCSERVER_DISCORD_WEBHOOK']) {
    saved[k] = process.env[k];
  }
  process.env.XDG_RUNTIME_DIR = runtimeDir;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  process.env.CCSERVER_CLAUDE_BIN = stubBin;
  process.env.CCSERVER_GROUPS_PATH = join(runtimeDir, 'saved-groups.json');
  process.env.CCSERVER_NOTIFY_PATH = join(runtimeDir, 'saved-notifications.json');
  delete process.env.CCSERVER_DISCORD_WEBHOOK;

  writeConfig({});
  sessionManager = await import('./sessionManager.js');
  notifyModule = await import('./notify.js');
});

after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { rmSync(runtimeDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  try { rmSync(argvPath, { force: true }); } catch { /* ignore */ }
});

async function launch() {
  const res = await sessionManager.createSession({
    cwd: runtimeDir, cols: 80, rows: 24, shell: false, app: 'claude', sandbox: false,
  });
  assert.ok(res.session, `session should spawn: ${res.error || ''}`);
  return res;
}

async function readArgv() {
  await until(() => existsSync(argvPath));
  return readFileSync(argvPath, 'utf-8').split('\n').filter(Boolean);
}

test('OFF: the command line carries nothing from this feature, and no detector is attached', async () => {
  writeConfig({ notify: { bridge: { enabled: false } } });
  const { sessionId, session } = await launch();
  try {
    const argv = await readArgv();
    assert.ok(!argv.includes('--settings'), `--settings must not appear: ${JSON.stringify(argv)}`);
    assert.ok(
      !argv.some((a) => a.includes('preferredNotifChannel')),
      `no notification config may reach argv: ${JSON.stringify(argv)}`,
    );
    assert.equal(session.notifyDetector, undefined, 'a disabled bridge attaches no detector');
  } finally {
    sessionManager.destroySession(sessionId, { keepSchedule: false });
  }
});

test('OFF: the agent emitting a notification anyway delivers nothing', async () => {
  writeConfig({
    notify: { discordWebhook: 'https://discord.example/hook', bridge: { enabled: false } },
  });
  const realFetch = global.fetch;
  const posts = [];
  global.fetch = async (url, opts) => { posts.push({ url: String(url), body: JSON.parse(opts.body) }); return { ok: true }; };
  const { sessionId } = await launch();
  try {
    await sleep(600); // the stub emits immediately; give the pty time to land
    assert.deepEqual(posts, [], 'nothing may be delivered while the bridge is off');
  } finally {
    global.fetch = realFetch;
    sessionManager.destroySession(sessionId, { keepSchedule: false });
  }
});

test('ON: the ghostty channel is injected, process-scoped', async () => {
  writeConfig({ notify: { bridge: { enabled: true } } });
  const { sessionId } = await launch();
  try {
    const argv = await readArgv();
    const i = argv.indexOf('--settings');
    assert.ok(i >= 0, `--settings must be present: ${JSON.stringify(argv)}`);
    assert.deepEqual(JSON.parse(argv[i + 1]), { preferredNotifChannel: 'ghostty' });
  } finally {
    sessionManager.destroySession(sessionId, { keepSchedule: false });
  }
});

test('ON: a notification the agent writes to its pty reaches the delivery channel', async () => {
  writeConfig({
    notify: { discordWebhook: 'https://discord.example/hook', bridge: { enabled: true, channels: ['discord'] } },
  });
  notifyModule.restoreNotify();
  const realFetch = global.fetch;
  const posts = [];
  global.fetch = async (url, opts) => { posts.push({ url: String(url), body: JSON.parse(opts.body) }); return { ok: true }; };
  const { sessionId, session } = await launch();
  try {
    assert.ok(session.notifyDetector, 'an enabled bridge attaches a detector');
    const got = await until(() => (posts.length > 0 ? posts[0] : null));
    assert.ok(got, 'the notification must reach the webhook');
    assert.equal(got.url, 'https://discord.example/hook');

    const { content } = got.body;
    // The title is ccserver's, built from the session -- not the agent's.
    assert.match(content, /Claude Code · /, 'the server-built title leads the payload');
    // The agent's own title and text follow, on one line.
    assert.match(content, /Claude Code — Waiting for your input/);
    // notify.js's attribution footer is still appended, below a blank line.
    assert.match(content, /\n\n_from: /);
    // And @everyone-style pings are declared inert (attacker review N4).
    assert.deepEqual(got.body.allowed_mentions, { parse: [] });
  } finally {
    global.fetch = realFetch;
    sessionManager.destroySession(sessionId, { keepSchedule: false });
  }
});

test('ON: a shell session is never captured, whatever it prints', async () => {
  writeConfig({
    notify: { discordWebhook: 'https://discord.example/hook', bridge: { enabled: true } },
  });
  const realFetch = global.fetch;
  const posts = [];
  global.fetch = async () => { posts.push(1); return { ok: true }; };
  const res = await sessionManager.createSession({
    cwd: runtimeDir, cols: 80, rows: 24, shell: true, sandbox: false,
  });
  try {
    assert.equal(res.session.notifyDetector, undefined, 'shells carry no detector');
    sessionManager.writeToSession(res.sessionId, "printf '\\033]777;notify;X;Y\\007'\n");
    await sleep(600);
    assert.deepEqual(posts, [], 'a shell writing the sequence must not deliver anything');
  } finally {
    global.fetch = realFetch;
    sessionManager.destroySession(res.sessionId, { keepSchedule: false });
  }
});
