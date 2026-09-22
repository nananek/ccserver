// Network isolation for the bwrap (Linux) backend (see network-broker.js).
//
// buildBwrapNetworkFilterScript/wrapBwrapInnerWithNetworkFilter are pure, and
// buildSandboxSpawn's isolation-enablement logic is exercised via the injectable
// deps.startNetworkBroker/deps.dockerSandboxAvailable seams -- nothing here
// spawns a real broker child process or real rootlesskit/bwrap.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildSandboxSpawn,
  BWRAP_ISOLATION_GATEWAY,
  BWRAP_ISOLATION_DNS,
  buildBwrapNetworkFilterScript,
  wrapBwrapInnerWithNetworkFilter,
  macOSNetworkBrokerInitialState,
} from './sandbox.js';

let tmpRoot;
let cfgPath;
let prevConfig;

before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-network-isolation-'));
  cfgPath = join(tmpRoot, 'sandbox.config.json');
  prevConfig = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
});

after(() => {
  if (prevConfig === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
  else process.env.CCSERVER_SANDBOX_CONFIG = prevConfig;
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

function writeConfig(obj) {
  writeFileSync(cfgPath, JSON.stringify(obj));
}

// --- buildBwrapNetworkFilterScript / wrapBwrapInnerWithNetworkFilter -------

test('buildBwrapNetworkFilterScript: structural DROP policy scoped to the broker port + DNS', () => {
  const script = buildBwrapNetworkFilterScript({ brokerPort: 54321 });
  assert.ok(script.includes('iptables -P OUTPUT DROP'), 'default-deny egress');
  assert.ok(script.includes('CCSBROKER_PORT=54321'), 'broker port embedded');
  assert.ok(script.includes('--dport "$CCSBROKER_PORT"'), 'broker port is allow-listed');
  assert.ok(script.includes(BWRAP_ISOLATION_GATEWAY), 'slirp gateway referenced');
  assert.ok(script.includes(BWRAP_ISOLATION_DNS), 'slirp DNS referenced');
  assert.ok(script.includes('nft'), 'nft fallback present');
  assert.ok(script.includes('set -eu'), 'fail-closed shell options');
  assert.throws(() => buildBwrapNetworkFilterScript({ brokerPort: 'x' }), /valid TCP port/);
  assert.throws(() => buildBwrapNetworkFilterScript({}), /valid TCP port/);
});

test('wrapBwrapInnerWithNetworkFilter: passes argv through "$@" without re-quoting', () => {
  const inner = ['/usr/bin/bash', '/ccserver-sandbox-entrypoint.sh', 'claude', '--dangerous path/with spaces & quotes"'];
  const wrapped = wrapBwrapInnerWithNetworkFilter(inner, 'set -eu\ntrue');
  assert.equal(wrapped[0], '/usr/bin/bash');
  assert.equal(wrapped[1], '-c');
  assert.ok(wrapped[2].startsWith('set -eu\ntrue\nexec "$@"'), 'filter runs first, entrypoint via "$@"');
  assert.deepEqual(wrapped.slice(4), ['/ccserver-sandbox-entrypoint.sh', 'claude', '--dangerous path/with spaces & quotes"']);
  assert.throws(() => wrapBwrapInnerWithNetworkFilter(['only-one'], 'x'), /innerCmd/);
});

// Executes the generated script against stub firewall binaries (no bwrap /
// rootlesskit needed -- pure shell), so quoting and variable-expansion bugs
// fail here instead of silently shipping an open-or-broken filter.
function runFilterScriptWithStubs(stubs) {
  const dir = mkdtempSync(join(tmpdir(), 'ccserver-netfw-stub-'));
  try {
    for (const name of stubs) {
      writeFileSync(join(dir, name), '#!/bin/sh\nprintf \'FW %s\\n\' "$*"\n', { mode: 0o755 });
    }
    const script = buildBwrapNetworkFilterScript({ brokerPort: 54321 });
    // PATH is scoped to ONLY the stub dir -- no real system bin dirs. The
    // script's `command -v iptables`/`command -v nft` checks must find
    // nothing but the stubs this test itself created; on a host that
    // happens to have real iptables/nft installed (common -- this sandbox
    // included), appending /usr/bin:/bin here would let a scenario meant to
    // stub only ONE tool (or neither) fall through to the REAL binary
    // instead, which then runs actual `iptables -P OUTPUT DROP` etc. against
    // this process's real network namespace -- breaking real egress for the
    // rest of the test run instead of exercising the fake stub. `command -v`
    // is a shell builtin and the stubbed tools are invoked by absolute
    // lookup via PATH alone, so the script needs nothing else on PATH.
    const out = execFileSync('/bin/sh', ['-c', script], {
      encoding: 'utf-8',
      env: { ...process.env, PATH: dir },
    });
    return out.trim().split('\n').filter(Boolean);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('buildBwrapNetworkFilterScript: iptables branch denies by default, allows only broker + DNS', () => {
  const lines = runFilterScriptWithStubs(['iptables', 'ip6tables']);
  assert.ok(lines.includes('FW -P OUTPUT DROP'), 'default-deny egress');
  assert.ok(lines.includes('FW -A OUTPUT -o lo -j ACCEPT'), 'loopback stays usable');
  assert.ok(
    lines.includes(`FW -A OUTPUT -d ${BWRAP_ISOLATION_GATEWAY} -p tcp --dport 54321 -j ACCEPT`),
    'only the broker port on the slirp gateway is reachable',
  );
  assert.ok(lines.includes(`FW -A OUTPUT -d ${BWRAP_ISOLATION_DNS} -p udp --dport 53 -j ACCEPT`), 'slirp DNS (udp)');
  assert.ok(lines.includes(`FW -A OUTPUT -d ${BWRAP_ISOLATION_DNS} -p tcp --dport 53 -j ACCEPT`), 'slirp DNS (tcp)');
  assert.ok(lines.includes('FW -P OUTPUT DROP') && lines.filter((l) => l.startsWith('FW -A')).length === 4, 'no other egress hole');
});

test('buildBwrapNetworkFilterScript: nft branch mirrors the iptables policy', () => {
  const lines = runFilterScriptWithStubs(['nft']);
  assert.ok(lines.some((l) => l.includes('policy drop')), 'default-deny chain');
  assert.ok(
    lines.some((l) => l.includes(BWRAP_ISOLATION_GATEWAY) && l.includes('54321') && l.includes('accept')),
    'broker port reachable via the gateway',
  );
  assert.ok(lines.some((l) => l.includes(BWRAP_ISOLATION_DNS) && l.includes('53')), 'slirp DNS reachable');
});

test('buildBwrapNetworkFilterScript: fail-closed when neither iptables nor nft exists', () => {
  assert.throws(() => runFilterScriptWithStubs([]), 'refuses to run open without firewall tooling');
});

// --- buildSandboxSpawn isolation enablement (hermetic: fake broker, forced tooling state) -

function fakeBrokerStarter(calls) {
  return (opts) => {
    calls.push(opts);
    return {
      proc: { kill() {}, pid: -1 },
      dir: join(tmpRoot, `fake-netbroker-${calls.length}`),
      port: 54321,
      token: 'fake-token',
      adminToken: 'fake-admin-token',
      allowedHosts: opts.allowedHosts,
      mode: opts.mode,
      state: opts.state,
    };
  };
}

function setenvMap(bwrapArgs) {
  const out = {};
  for (let i = 0; i < bwrapArgs.length - 1; i++) {
    if (bwrapArgs[i] === '--setenv') out[bwrapArgs[i + 1]] = bwrapArgs[i + 2];
  }
  return out;
}

// Returns the bwrap argv tail (everything after the BWRAP marker) for the
// rootlesskit-wrapped shape.
function bwrapSpawnArgs(spawn) {
  const i = spawn.args.indexOf('/usr/bin/bwrap');
  return i >= 0 ? spawn.args.slice(i + 1) : spawn.args;
}

test('macOSNetworkBrokerInitialState: initialState selects the starting state', () => {
  // network.initialState is the starting live state of an isolation-enabled launch:
  // 'open' starts open, anything else starts enforce.
  assert.equal(macOSNetworkBrokerInitialState('enforce'), 'enforce');
  assert.equal(macOSNetworkBrokerInitialState('open'), 'open');
  assert.equal(macOSNetworkBrokerInitialState(undefined), 'enforce');
  assert.equal(macOSNetworkBrokerInitialState(null), 'enforce');
  assert.equal(macOSNetworkBrokerInitialState('sometimes'), 'enforce');
});

test('buildSandboxSpawn: network.isolate:true enables structural isolation (Linux)', { skip: process.platform === 'darwin' }, async () => {
  writeConfig({ docker: false, gitBroker: false, persistentHome: false, commitMessageGuard: { enabled: false }, network: { isolate: true } });
  const calls = [];
  const spawn = await buildSandboxSpawn(
    { cwd: tmpRoot, targetCommand: ['claude'], app: 'claude' },
    { startNetworkBroker: fakeBrokerStarter(calls), dockerSandboxAvailable: () => true },
  );
  // Broker started in enforce with the config allow-list...
  assert.equal(calls.length, 1);
  assert.equal(calls[0].state, 'enforce');
  // ...wrapped in rootlesskit for a private netns even with docker:false...
  assert.equal(spawn.command, '/usr/bin/rootlesskit');
  assert.ok(spawn.args.includes('--net=slirp4netns'), 'private netns via slirp4netns');
  assert.ok(!spawn.args.includes('--disable-host-loopback'), 'gateway must reach the host-loopback broker');
  assert.ok(spawn.stateDir, 'per-launch rootlesskit state dir minted');
  // ...proxy env points at the slirp gateway (IP literal: no DNS needed)...
  const env = setenvMap(bwrapSpawnArgs(spawn));
  const expectedProxy = `http://networkbroker:${encodeURIComponent('fake-token')}@${BWRAP_ISOLATION_GATEWAY}:54321`;
  assert.equal(env.HTTP_PROXY, expectedProxy);
  assert.equal(env.HTTPS_PROXY, expectedProxy);
  assert.equal(env.http_proxy, expectedProxy);
  assert.equal(env.https_proxy, expectedProxy);
  // ...the in-netns firewall prelude runs before the entrypoint...
  const dashC = spawn.args.indexOf('-c');
  assert.ok(dashC >= 0, 'inner command wrapped as bash -c with the filter prelude');
  assert.ok(spawn.args[dashC + 1].includes('iptables -P OUTPUT DROP'), 'DROP policy in the prelude');
  assert.ok(spawn.args[dashC + 1].includes('CCSBROKER_PORT=54321'), 'broker port in the prelude');
  // ...and the session is reported isolation-enabled for the live toggle.
  assert.equal(spawn.networkIsolateArmed, true);
  assert.equal(spawn.networkIsolateMode, 'enforce');
  assert.equal(spawn.networkBrokerPort, 54321);
  assert.equal(spawn.networkBrokerToken, 'fake-token');
  // H1 regression: the admin token (used for the host-side /__admin/* live
  // toggle) must be a distinct value from the proxy token embedded in the
  // sandbox's HTTP_PROXY env above -- a sandboxed agent that reads its own
  // env must never recover a credential that can flip its own allow-list.
  assert.equal(spawn.networkBrokerAdminToken, 'fake-admin-token');
  assert.notEqual(spawn.networkBrokerAdminToken, env.HTTP_PROXY.match(/networkbroker:([^@]+)@/)[1]);
});

test('buildSandboxSpawn: a plain bwrap launch (network.isolate off) never starts a broker, even when tooling exists', { skip: process.platform === 'darwin' }, async () => {
  writeConfig({ docker: false, gitBroker: false, persistentHome: false, commitMessageGuard: { enabled: false } });
  const calls = [];
  const spawn = await buildSandboxSpawn(
    { cwd: tmpRoot, targetCommand: ['claude'], app: 'claude' },
    { startNetworkBroker: fakeBrokerStarter(calls), dockerSandboxAvailable: () => true },
  );
  assert.equal(calls.length, 0, 'on-demand: no broker when network.isolate is off, on either backend');
  assert.equal(spawn.command, '/usr/bin/bwrap', 'plain bwrap, no rootlesskit wrapping needed for isolation');
  assert.ok(!spawn.args.includes('-c'), 'no firewall prelude wrapping');
  assert.equal(spawn.networkIsolateArmed, false);
  assert.equal(spawn.networkBrokerPort, null);
});

test('buildSandboxSpawn: network.initialState:open starts the broker open (Linux)', { skip: process.platform === 'darwin' }, async () => {
  writeConfig({ docker: false, gitBroker: false, persistentHome: false, commitMessageGuard: { enabled: false }, network: { isolate: true, initialState: 'open' } });
  const calls = [];
  const spawn = await buildSandboxSpawn(
    { cwd: tmpRoot, targetCommand: ['claude'], app: 'claude' },
    { startNetworkBroker: fakeBrokerStarter(calls), dockerSandboxAvailable: () => true },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].state, 'open', 'starting live state comes from network.initialState');
  assert.equal(spawn.networkIsolateArmed, true);
  assert.equal(spawn.networkIsolateMode, 'open');
});

test('buildSandboxSpawn: docker:true (nested dockerd) alone does not enable network isolation', { skip: process.platform === 'darwin' }, async () => {
  // needBwrapIsolation is gated on network.isolate, not on the unrelated
  // `docker` (nested dockerd) flag -- a docker:true launch keeps its
  // existing unrestricted slirp4netns NAT networking unless network.isolate
  // is ALSO on. (docker:true still takes the rootlesskit path it always
  // has, for the nested dockerd's own userns -- just without the broker or
  // firewall.)
  writeConfig({ docker: true, gitBroker: false, persistentHome: false, commitMessageGuard: { enabled: false } });
  const calls = [];
  const spawn = await buildSandboxSpawn(
    { cwd: tmpRoot, targetCommand: ['claude'], app: 'claude' },
    { startNetworkBroker: fakeBrokerStarter(calls), dockerSandboxAvailable: () => true },
  );
  assert.equal(calls.length, 0, 'no broker for a plain docker:true launch');
  assert.equal(spawn.command, '/usr/bin/rootlesskit', 'nested dockerd still gets its own rootlesskit wrapping, as before this feature');
  assert.ok(spawn.args.includes('--disable-host-loopback'), 'kept: there is no broker for this launch to reach at the gateway');
  assert.ok(!spawn.args.includes('-c'), 'no firewall prelude wrapping');
  assert.equal(spawn.networkIsolateArmed, false);
});

test('buildSandboxSpawn: gracefully degrades to a plain, unisolated bwrap launch when rootlesskit tooling is missing', { skip: process.platform === 'darwin' }, async () => {
  writeConfig({ docker: false, gitBroker: false, persistentHome: false, commitMessageGuard: { enabled: false }, network: { isolate: true } });
  const calls = [];
  const spawn = await buildSandboxSpawn(
    { cwd: tmpRoot, targetCommand: ['claude'], app: 'claude' },
    { startNetworkBroker: fakeBrokerStarter(calls), dockerSandboxAvailable: () => false },
  );
  assert.equal(calls.length, 0, 'no broker started when the tooling is missing, even with network.isolate on');
  assert.equal(spawn.command, '/usr/bin/bwrap', 'falls back to a plain bwrap launch (today\'s default), not a hard failure');
  assert.ok(!spawn.args.includes('-c'), 'no firewall prelude wrapping');
  assert.equal(spawn.networkIsolateArmed, false);
  assert.equal(spawn.networkBrokerPort, null);
});
