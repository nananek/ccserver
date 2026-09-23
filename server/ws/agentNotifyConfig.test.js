// agentNotifyConfig.js -- the launch-time half of the notification bridge
// (plan: plan-notify-bridge, Step 3). Pure {args, env} assembly, so every case
// here is a direct call.
//
// The invariant this file exists to protect is the OFF one: with the bridge
// disabled, an agent's command line must be byte-for-byte what it was before
// this feature existed. Every launch on every deployment runs through this
// function, so a regression here changes how every session starts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentNotifyArgsAndEnv, shouldCaptureNotifications } from './agentNotifyConfig.js';
import { normalizeBridgeSettings, BRIDGE_APPS } from './notifyBridgeSettings.js';

const OFF = normalizeBridgeSettings(undefined);
const ON = normalizeBridgeSettings({ enabled: true });
const EMPTY = { args: [], env: {} };

test('OFF invariant: a disabled bridge injects nothing for any app', () => {
  for (const app of [...BRIDGE_APPS, null, undefined, 'unknown-cli']) {
    assert.deepEqual(
      buildAgentNotifyArgsAndEnv(app, OFF), EMPTY,
      `${app}: a disabled bridge must not touch the command line`,
    );
  }
});

test('OFF invariant: absent/garbage settings inject nothing', () => {
  for (const bridge of [null, undefined, {}, 'nope', []]) {
    assert.deepEqual(buildAgentNotifyArgsAndEnv('claude', bridge), EMPTY);
  }
});

test('OFF invariant: injectConfig=false injects nothing even when enabled', () => {
  const bridge = normalizeBridgeSettings({ enabled: true, injectConfig: false });
  for (const app of BRIDGE_APPS) {
    assert.deepEqual(buildAgentNotifyArgsAndEnv(app, bridge), EMPTY);
  }
});

test('OFF invariant: an app the operator did not select injects nothing', () => {
  const bridge = normalizeBridgeSettings({ enabled: true, apps: ['opencode'] });
  assert.deepEqual(buildAgentNotifyArgsAndEnv('claude', bridge), EMPTY);
});

test('claude gets the ghostty channel, and only that', () => {
  const { args, env } = buildAgentNotifyArgsAndEnv('claude', ON);
  assert.deepEqual(args, ['--settings', '{"preferredNotifChannel":"ghostty"}']);
  assert.deepEqual(env, {});
});

test('the injected JSON carries exactly one key and no secrets', () => {
  // Everything here lands in argv, which `ps` shows to every local user. This
  // test is the gate on that: adding a key means adding it to every process
  // listing on the host.
  const { args } = buildAgentNotifyArgsAndEnv('claude', ON);
  const payload = JSON.parse(args[1]);
  assert.deepEqual(Object.keys(payload), ['preferredNotifChannel']);
  const serialized = JSON.stringify(payload).toLowerCase();
  for (const smell of ['token', 'secret', 'key', 'password', 'webhook', 'sock', '/home/', 'http']) {
    assert.ok(!serialized.includes(smell), `the injected settings must not carry "${smell}"`);
  }
});

test('the injected JSON carries no hooks key (it must not disturb the operator\'s own)', () => {
  // Verified live: an operator Stop hook fired exactly once with this flag
  // present. That holds because there is nothing here to merge against.
  const { args } = buildAgentNotifyArgsAndEnv('claude', ON);
  assert.ok(!('hooks' in JSON.parse(args[1])));
});

test('codex is opt-in and uses a process-scoped -c override', () => {
  assert.deepEqual(buildAgentNotifyArgsAndEnv('codex', ON), EMPTY, 'not selected by default');
  const bridge = normalizeBridgeSettings({ enabled: true, apps: ['codex'] });
  assert.deepEqual(buildAgentNotifyArgsAndEnv('codex', bridge).args, ['-c', 'tui.notifications=true']);
});

test('opencode, copilot and commandcode are capture-only (nothing injectable)', () => {
  const bridge = normalizeBridgeSettings({ enabled: true, apps: ['opencode', 'copilot', 'commandcode'] });
  for (const app of ['opencode', 'copilot', 'commandcode']) {
    assert.deepEqual(buildAgentNotifyArgsAndEnv(app, bridge), EMPTY);
  }
});

test('shouldCaptureNotifications gates on shell, app and the feature flag', () => {
  assert.equal(shouldCaptureNotifications({ shell: false, app: 'claude', bridge: ON }), true);
  assert.equal(shouldCaptureNotifications({ shell: true, app: null, bridge: ON }), false, 'shells never');
  assert.equal(shouldCaptureNotifications({ shell: false, app: null, bridge: ON }), false);
  assert.equal(shouldCaptureNotifications({ shell: false, app: 'claude', bridge: OFF }), false);
  assert.equal(shouldCaptureNotifications({ shell: false, app: 'copilot', bridge: ON }), false, 'not a default app');
});

test('capture is possible for apps that cannot be injected into', () => {
  // The whole reason copilot/commandcode stay selectable: reading the pty
  // costs nothing and works if they turn out to emit something on their own.
  const bridge = normalizeBridgeSettings({ enabled: true, apps: ['copilot'] });
  assert.equal(shouldCaptureNotifications({ shell: false, app: 'copilot', bridge }), true);
  assert.deepEqual(buildAgentNotifyArgsAndEnv('copilot', bridge), EMPTY);
});
