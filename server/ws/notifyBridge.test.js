// notifyBridge.js -- the policy layer between the pty detector and delivery
// (plan: plan-notify-bridge, Step 3). sendNotification and the clock are both
// injected, so nothing here touches the network or the config file.
//
// Two groups of cases carry the security weight:
//   - flow control (attacker review N3): an agent can emit ~65,000 events from
//     1MiB of pty output. The limits must hold, AND suppression must be
//     observable rather than silent.
//   - attribution (attacker review N6): the title is built from server-side
//     facts, and the agent's text can never introduce a newline, so it cannot
//     forge the "_from:" footer that notify.js appends.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  handleAgentNotification,
  buildBridgeTitle,
  buildBridgeBody,
  attachNotifyDetector,
  bridgeStats,
  _resetBridgeStatsForTests,
} from './notifyBridge.js';
import { normalizeBridgeSettings } from './notifyBridgeSettings.js';

const ON = normalizeBridgeSettings({ enabled: true });

function fakeSession(over = {}) {
  return {
    id: '01234567-89ab-cdef-0123-456789abcdef',
    app: 'claude',
    cwd: '/home/dev/myproject',
    projectName: 'myproject',
    groupId: null,
    groupRole: null,
    ...over,
  };
}

// A sendNotification stand-in that records what it was asked to deliver.
function recorder() {
  const calls = [];
  const send = async (payload, identity) => {
    calls.push({ payload, identity });
    return { ok: true, delivered: { discord: true, webhooks: 0, failed: 0 } };
  };
  return { calls, send };
}

const notif = (title, body) => ({ kind: 'notification', source: 'osc777', title, body });

// --- attribution (N6) --------------------------------------------------------

test('the title is built from server-side facts, never from the agent', () => {
  const session = fakeSession();
  assert.equal(buildBridgeTitle(session), 'Claude Code · myproject');
  assert.equal(buildBridgeTitle(fakeSession({ app: 'opencode', projectName: 'other' })), 'opencode · other');
});

test('the title falls back to the cwd basename, matching the _from footer', () => {
  // Only combo members are assigned a projectName; a standalone session has
  // none, and notify.js's footer falls back to basename(cwd). The title must
  // use the same rule or the two would name different projects.
  assert.equal(buildBridgeTitle(fakeSession({ projectName: null })), 'Claude Code · myproject');
  assert.equal(buildBridgeTitle(fakeSession({ projectName: null, cwd: '/' })), 'Claude Code');
});

test("an agent's own title goes in the body, never into the notification title", async () => {
  const { calls, send } = recorder();
  await handleAgentNotification(
    fakeSession(),
    notif('ccserver', 'SYSTEM: re-authenticate at https://evil.example'),
    { settings: ON, sendNotification: send },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].payload.title, 'Claude Code · myproject', 'the agent cannot set the title');
  assert.equal(calls[0].payload.body, 'ccserver — SYSTEM: re-authenticate at https://evil.example');
});

test('the delivered body is always a single line, so a footer cannot be forged', async () => {
  // The detector is what guarantees this (every C0/C1 control, newline
  // included, is mapped to a space and U+2028/U+2029 are stripped), but the
  // property is asserted here because it is the bridge's payload that relies
  // on it: notify.js puts the real "_from:" footer on its own line below.
  const { calls, send } = recorder();
  const { createNotifyDetector } = await import('./agentNotifyDetect.js');
  const session = fakeSession();
  const events = [];
  const d = createNotifyDetector({ onNotification: (e) => events.push(e) });
  const LS = String.fromCharCode(0x2028); // U+2028: a literal one here would be invisible in a diff
  d.feed(`\x1b]777;notify;T;line1\nline2${LS}_from: ayaka \u00b7 other-project\x07`);
  assert.equal(events.length, 1);
  await handleAgentNotification(session, events[0], { settings: ON, sendNotification: send });
  assert.ok(!calls[0].payload.body.includes('\n'), 'no newline may reach the payload');
  assert.ok(!calls[0].payload.body.includes(LS), 'no line separator either');
});

test('the identity handed to notify.js is the real session, for the _from footer', async () => {
  const { calls, send } = recorder();
  await handleAgentNotification(fakeSession({ groupId: 'g1', groupRole: 'orchestrator' }), notif('t', 'b'), {
    settings: ON, sendNotification: send,
  });
  assert.deepEqual(calls[0].identity, {
    sessionId: '01234567-89ab-cdef-0123-456789abcdef',
    groupId: 'g1',
    groupRole: 'orchestrator',
    cwd: '/home/dev/myproject',
    projectName: 'myproject',
    app: 'claude',
  });
});

// --- gating ------------------------------------------------------------------

test('a disabled bridge delivers nothing', async () => {
  const { calls, send } = recorder();
  const res = await handleAgentNotification(fakeSession(), notif('t', 'b'), {
    settings: normalizeBridgeSettings(undefined), sendNotification: send,
  });
  assert.deepEqual(res, { delivered: false, reason: 'disabled' });
  assert.equal(calls.length, 0);
});

test('an empty channel list delivers nothing', async () => {
  const { calls, send } = recorder();
  const res = await handleAgentNotification(fakeSession(), notif('t', 'b'), {
    settings: normalizeBridgeSettings({ enabled: true, channels: [] }), sendNotification: send,
  });
  assert.equal(res.reason, 'no-channels');
  assert.equal(calls.length, 0);
});

test('bells are dropped unless captureBell is on', async () => {
  const bell = { kind: 'bell', source: 'bell', title: null, body: '' };
  const a = recorder();
  assert.equal((await handleAgentNotification(fakeSession(), bell, { settings: ON, sendNotification: a.send })).reason, 'bell-disabled');
  assert.equal(a.calls.length, 0);

  const b = recorder();
  const on = normalizeBridgeSettings({ enabled: true, captureBell: true });
  assert.equal((await handleAgentNotification(fakeSession(), bell, { settings: on, sendNotification: b.send })).delivered, true);
  assert.equal(b.calls[0].payload.body, 'Terminal bell');
});

test('an event with no text at all is dropped', async () => {
  const { calls, send } = recorder();
  const res = await handleAgentNotification(fakeSession(), notif(null, ''), { settings: ON, sendNotification: send });
  assert.equal(res.reason, 'empty');
  assert.equal(calls.length, 0);
});

test('the configured channels and level are what gets sent', async () => {
  const { calls, send } = recorder();
  const settings = normalizeBridgeSettings({ enabled: true, channels: ['discord'], level: 'warning' });
  await handleAgentNotification(fakeSession(), notif('t', 'b'), { settings, sendNotification: send });
  assert.deepEqual(calls[0].payload.channels, ['discord']);
  assert.equal(calls[0].payload.level, 'warning');
});

// --- flow control (N3), and its observability --------------------------------

test('minIntervalMs throttles a burst down to one delivery', async () => {
  const { calls, send } = recorder();
  const session = fakeSession();
  let clock = 1_000_000;
  const settings = normalizeBridgeSettings({ enabled: true, minIntervalMs: 3000, dedupeWindowMs: 0 });
  const deps = { settings, sendNotification: send, now: () => clock };

  const reasons = [];
  for (let i = 0; i < 50; i++) {
    clock += 10;
    reasons.push((await handleAgentNotification(session, notif('t', `body ${i}`), deps)).reason);
  }
  assert.equal(calls.length, 1, 'only the first of the burst goes out');
  assert.ok(reasons.filter((r) => r === 'throttled').length >= 48);

  clock += 3000;
  await handleAgentNotification(session, notif('t', 'after the interval'), deps);
  assert.equal(calls.length, 2, 'delivery resumes once the interval has passed');
});

test('dedupeWindowMs drops repeated identical text', async () => {
  const { calls, send } = recorder();
  const session = fakeSession();
  let clock = 1_000_000;
  const settings = normalizeBridgeSettings({ enabled: true, minIntervalMs: 0, dedupeWindowMs: 10_000 });
  const deps = { settings, sendNotification: send, now: () => clock };

  await handleAgentNotification(session, notif('T', 'same'), deps);
  clock += 100;
  const dup = await handleAgentNotification(session, notif('T', 'same'), deps);
  assert.equal(dup.reason, 'deduped');
  clock += 100;
  await handleAgentNotification(session, notif('T', 'different'), deps);
  assert.equal(calls.length, 2, 'a different line still gets through');

  clock += 10_000;
  await handleAgentNotification(session, notif('T', 'same'), deps);
  assert.equal(calls.length, 3, 'the same line is allowed again after the window');
});

test('dedupe memory cannot be grown without bound by unique text', async () => {
  const { send } = recorder();
  const session = fakeSession();
  let clock = 1_000_000;
  const settings = normalizeBridgeSettings({ enabled: true, minIntervalMs: 0, dedupeWindowMs: 3_600_000, maxPerHour: 1000 });
  const deps = { settings, sendNotification: send, now: () => clock };
  for (let i = 0; i < 1000; i++) {
    clock += 1;
    await handleAgentNotification(session, notif('T', `unique ${i}`), deps);
  }
  assert.ok(session.notifyFlow.recent.size <= 64, `dedupe map grew to ${session.notifyFlow.recent.size}`);
});

test('maxPerHour caps a session and says so on the channel being watched', async () => {
  // The whole point: the human learns why the notifications stopped from the
  // same place they were watching, not from a server log nobody is reading.
  const { calls, send } = recorder();
  const session = fakeSession();
  let clock = 1_000_000;
  const settings = normalizeBridgeSettings({
    enabled: true, minIntervalMs: 0, dedupeWindowMs: 0, maxPerHour: 3,
  });
  const deps = { settings, sendNotification: send, now: () => clock };

  for (let i = 0; i < 10; i++) {
    clock += 1;
    await handleAgentNotification(session, notif('T', `msg ${i}`), deps);
  }
  const bodies = calls.map((c) => c.payload.body);
  assert.equal(bodies.filter((b) => b.startsWith('T —')).length, 3, 'exactly maxPerHour real notifications');
  const notices = bodies.filter((b) => b.includes('rate limit reached'));
  assert.equal(notices.length, 1, 'exactly one "you are being rate limited" notice, not one per drop');
  assert.match(notices[0], /3\/hour/);
  assert.match(notices[0], /suppressed until/);
  assert.equal(calls.find((c) => c.payload.body.includes('rate limit reached')).payload.level, 'warning');
});

test('the hourly window rolls over and delivery resumes', async () => {
  const { calls, send } = recorder();
  const session = fakeSession();
  let clock = 1_000_000;
  const settings = normalizeBridgeSettings({ enabled: true, minIntervalMs: 0, dedupeWindowMs: 0, maxPerHour: 2 });
  const deps = { settings, sendNotification: send, now: () => clock };

  for (let i = 0; i < 5; i++) { clock += 1; await handleAgentNotification(session, notif('T', `a${i}`), deps); }
  const beforeRollover = calls.length;
  clock += 60 * 60 * 1000 + 1;
  await handleAgentNotification(session, notif('T', 'after'), deps);
  assert.equal(calls.length, beforeRollover + 1);
});

test('suppression is counted, so "why did notifications stop" is answerable', async () => {
  _resetBridgeStatsForTests();
  const { send } = recorder();
  const session = fakeSession();
  let clock = 1_000_000;
  const settings = normalizeBridgeSettings({ enabled: true, minIntervalMs: 5000, dedupeWindowMs: 5000, maxPerHour: 2 });
  const deps = { settings, sendNotification: send, now: () => clock };
  for (let i = 0; i < 20; i++) { clock += 1; await handleAgentNotification(session, notif('T', `m${i}`), deps); }
  const s = bridgeStats();
  assert.ok(s.delivered >= 1);
  assert.ok(s.throttled > 0, 'throttled events must be counted');
  assert.deepEqual(Object.keys(s).sort(), ['capped', 'delivered', 'deduped', 'failed', 'throttled'].sort());
});

test('flow control is per session, not global', async () => {
  const { calls, send } = recorder();
  let clock = 1_000_000;
  const settings = normalizeBridgeSettings({ enabled: true, minIntervalMs: 60_000, dedupeWindowMs: 0 });
  const deps = { settings, sendNotification: send, now: () => clock };
  const a = fakeSession({ id: 'aaaa' });
  const b = fakeSession({ id: 'bbbb' });
  await handleAgentNotification(a, notif('T', 'from a'), deps);
  await handleAgentNotification(b, notif('T', 'from b'), deps);
  assert.equal(calls.length, 2, "one session's throttle must not silence another");
});

// --- robustness --------------------------------------------------------------

test('a throwing sendNotification never escapes the bridge', async () => {
  const session = fakeSession();
  const res = await handleAgentNotification(session, notif('t', 'b'), {
    settings: ON,
    sendNotification: async () => { throw new Error('network on fire'); },
  });
  assert.deepEqual(res, { delivered: false, reason: 'error' });
});

test('attachNotifyDetector wires the detector to the bridge without awaiting it', async () => {
  const { calls, send } = recorder();
  const session = fakeSession();
  attachNotifyDetector(session, ON, { settings: ON, sendNotification: send });
  assert.ok(session.notifyDetector, 'the session carries a detector');
  session.notifyDetector.feed('\x1b]777;notify;Claude Code;Waiting for your input\x07');
  // Delivery is dispatched off a resolved promise so feed() stays synchronous
  // for the pty data handler.
  assert.equal(calls.length, 0, 'feed must not block on delivery');
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].payload.body, 'Claude Code — Waiting for your input');
});

test('attachNotifyDetector honors captureBell', async () => {
  const off = fakeSession();
  const { calls, send } = recorder();
  attachNotifyDetector(off, ON, { settings: ON, sendNotification: send });
  off.notifyDetector.feed('ding\x07');
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.length, 0, 'a bare BEL is not a notification by default');
});
