// notifyBridgeSettings.js -- the notify.bridge slice of sandbox.config.json
// (plan: plan-notify-bridge, Step 2). Same temp-file harness as
// sandbox-config.test.js / notify.test.js: point CCSERVER_SANDBOX_CONFIG at a
// scratch file and drive the real read/write path.
//
// The two properties that matter most here are the same ones
// networkAllowlist.test.js guards for its own slice:
//   - a partial patch must leave every other key in the file untouched,
//     including the `//` comment keys the example config is full of,
//   - a file that is not valid JSON must be refused, never overwritten.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import {
  normalizeBridgeSettings,
  getBridgeSettings,
  updateBridgeSettings,
  BRIDGE_APPS,
  BRIDGE_CHANNELS,
  BRIDGE_DEFAULTS,
  BRIDGE_LIMITS,
  getBridgeSettingsCached,
  invalidateBridgeSettingsCache,
} from './notifyBridgeSettings.js';
import { resolveSandboxConfigPath } from './networkAllowlist.js';
import { loadSandboxConfig } from './sandbox.js';

function withConfig(contents, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ccserver-bridge-'));
  const cfgPath = join(dir, 'sandbox.config.json');
  const prev = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  try {
    if (contents !== null) {
      writeFileSync(cfgPath, typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2));
    }
    return fn(cfgPath);
  } finally {
    if (prev === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
    else process.env.CCSERVER_SANDBOX_CONFIG = prev;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

const readBack = (p) => JSON.parse(readFileSync(p, 'utf-8'));

// --- normalize (the lenient read path) --------------------------------------

test('normalizeBridgeSettings: absent/garbage input yields the documented defaults', () => {
  for (const input of [undefined, null, {}, 'nope', 42, []]) {
    assert.deepEqual(normalizeBridgeSettings(input), { ...BRIDGE_DEFAULTS, apps: [...BRIDGE_DEFAULTS.apps], channels: [...BRIDGE_DEFAULTS.channels] });
  }
});

test('normalizeBridgeSettings: the feature is OFF by default', () => {
  assert.equal(normalizeBridgeSettings(undefined).enabled, false);
  assert.equal(BRIDGE_DEFAULTS.enabled, false);
});

test('normalizeBridgeSettings: codex is not a default app (its config is unverified)', () => {
  assert.ok(!BRIDGE_DEFAULTS.apps.includes('codex'), 'codex must be opt-in');
  assert.ok(BRIDGE_APPS.includes('codex'), 'but it must still be selectable');
});

test('normalizeBridgeSettings: unknown app ids and channels are dropped, duplicates collapsed', () => {
  const s = normalizeBridgeSettings({
    apps: ['claude', 'bogus', 'claude', 42, null, 'codex'],
    channels: ['webpush', 'vikunja', 'webpush', 'discord'],
  });
  assert.deepEqual(s.apps, ['claude', 'codex']);
  assert.deepEqual(s.channels, ['webpush', 'discord']);
});

test('normalizeBridgeSettings: an empty list is meaningful and is kept, a non-array is not', () => {
  assert.deepEqual(normalizeBridgeSettings({ apps: [], channels: [] }).apps, [], 'capture nothing');
  assert.deepEqual(normalizeBridgeSettings({ apps: [], channels: [] }).channels, [], 'deliver nowhere');
  assert.deepEqual(normalizeBridgeSettings({ apps: 'claude' }).apps, [...BRIDGE_DEFAULTS.apps], 'a string is not a list');
});

test('normalizeBridgeSettings: out-of-range and non-integer numbers fall back to defaults', () => {
  for (const [key, limits] of Object.entries(BRIDGE_LIMITS)) {
    for (const bad of [limits.min - 1, limits.max + 1, 1.5, 'x', null, NaN, Infinity]) {
      assert.equal(
        normalizeBridgeSettings({ [key]: bad })[key], BRIDGE_DEFAULTS[key],
        `${key}=${String(bad)} must fall back`,
      );
    }
    assert.equal(normalizeBridgeSettings({ [key]: limits.min })[key], limits.min, `${key} accepts its minimum`);
    assert.equal(normalizeBridgeSettings({ [key]: limits.max })[key], limits.max, `${key} accepts its maximum`);
  }
});

test('normalizeBridgeSettings: an unknown level falls back to info', () => {
  assert.equal(normalizeBridgeSettings({ level: 'fatal' }).level, 'info');
  assert.equal(normalizeBridgeSettings({ level: 'warning' }).level, 'warning');
});

// --- loadSandboxConfig shares the same normalizer ---------------------------

test('loadSandboxConfig().notify.bridge resolves identically to getBridgeSettings()', () => {
  const cfg = {
    notify: {
      discordWebhook: 'https://discord.example/hook',
      bridge: { enabled: true, apps: ['claude', 'bogus'], minIntervalMs: 500, level: 'warning' },
    },
  };
  withConfig(cfg, () => {
    assert.deepEqual(loadSandboxConfig().notify.bridge, getBridgeSettings(),
      'the GUI boundary and the launcher must not be able to disagree');
    assert.equal(getBridgeSettings().enabled, true);
    assert.deepEqual(getBridgeSettings().apps, ['claude']);
  });
});

test('a config with no notify key at all still yields defaults', () => {
  withConfig({ docker: true }, () => {
    assert.deepEqual(getBridgeSettings(), normalizeBridgeSettings(undefined));
  });
});

test('a missing config file yields defaults rather than throwing', () => {
  withConfig(null, (p) => {
    assert.equal(existsSync(p), false);
    assert.deepEqual(getBridgeSettings(), normalizeBridgeSettings(undefined));
  });
});

// --- update (the strict write path) -----------------------------------------

test('a partial patch changes only the keys it names', () => {
  withConfig({ notify: { bridge: { enabled: false, maxPerHour: 10 } } }, () => {
    const res = updateBridgeSettings({ enabled: true });
    assert.equal(res.ok, true);
    assert.equal(res.settings.enabled, true);
    assert.equal(res.settings.maxPerHour, 10, 'an untouched key keeps its stored value');
  });
});

test('a patch preserves every other feature key and the // comment keys', () => {
  const original = {
    '//': 'top comment',
    docker: true,
    '//network': 'network comment',
    network: { isolate: true, allowedHosts: ['example.com'] },
    notify: {
      '//bridge': 'bridge comment',
      discordWebhook: 'https://discord.example/hook',
      subscriptions: [{ url: 'https://hooks.example.com/x', name: 'x' }],
    },
  };
  withConfig(original, (p) => {
    const res = updateBridgeSettings({ enabled: true, channels: ['discord'] });
    assert.equal(res.ok, true);
    const after = readBack(p);
    assert.equal(after['//'], 'top comment');
    assert.equal(after['//network'], 'network comment');
    assert.deepEqual(after.network, original.network);
    assert.equal(after.docker, true);
    assert.equal(after.notify['//bridge'], 'bridge comment');
    assert.equal(after.notify.discordWebhook, 'https://discord.example/hook');
    assert.deepEqual(after.notify.subscriptions, original.notify.subscriptions);
    assert.deepEqual(after.notify.bridge, { enabled: true, channels: ['discord'] },
      'only the patched keys are written; the rest stay implicit defaults');
  });
});

test('a corrupt config is refused, not overwritten', () => {
  const garbage = '{ this is not json';
  withConfig(garbage, (p) => {
    const res = updateBridgeSettings({ enabled: true });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'internal');
    assert.match(res.message, /not valid JSON/);
    assert.equal(readFileSync(p, 'utf-8'), garbage, 'the file must be left exactly as it was');
  });
});

test('validation: booleans, lists, numbers and level are each rejected with a reason', () => {
  withConfig({}, () => {
    const cases = [
      [{ enabled: 'yes' }, /enabled must be a boolean/],
      [{ injectConfig: 1 }, /injectConfig must be a boolean/],
      [{ captureBell: null }, /captureBell must be a boolean/],
      [{ apps: 'claude' }, /apps must be an array/],
      [{ apps: ['claude', 'bogus'] }, /unknown app id\(s\): bogus/],
      [{ channels: ['vikunja'] }, /unknown channel\(s\): vikunja/],
      [{ minIntervalMs: 1.5 }, /minIntervalMs must be an integer/],
      [{ minIntervalMs: -1 }, /minIntervalMs must be between/],
      [{ maxPerHour: 0 }, /maxPerHour must be between/],
      [{ maxPerHour: 99999 }, /maxPerHour must be between/],
      [{ dedupeWindowMs: 'soon' }, /dedupeWindowMs must be an integer/],
      [{ level: 'fatal' }, /level must be one of/],
      ['nope', /patch must be an object/],
      [['a'], /patch must be an object/],
    ];
    for (const [patch, re] of cases) {
      const res = updateBridgeSettings(patch);
      assert.equal(res.ok, false, `${JSON.stringify(patch)} must be rejected`);
      assert.equal(res.code, 'validation');
      assert.match(res.message, re);
    }
  });
});

test('a rejected patch writes nothing at all', () => {
  withConfig({ notify: { bridge: { enabled: false } } }, (p) => {
    const before = readFileSync(p, 'utf-8');
    assert.equal(updateBridgeSettings({ enabled: true, apps: ['bogus'] }).ok, false);
    assert.equal(readFileSync(p, 'utf-8'), before, 'a partially-valid patch must be all-or-nothing');
    assert.equal(getBridgeSettings().enabled, false);
  });
});

test('an empty channels list is a legitimate patch (deliver nowhere)', () => {
  withConfig({}, () => {
    const res = updateBridgeSettings({ channels: [] });
    assert.equal(res.ok, true);
    assert.deepEqual(res.settings.channels, []);
  });
});

test('duplicates in a patch are collapsed before writing', () => {
  withConfig({}, (p) => {
    assert.equal(updateBridgeSettings({ apps: ['claude', 'claude', 'codex'] }).ok, true);
    assert.deepEqual(readBack(p).notify.bridge.apps, ['claude', 'codex']);
  });
});

test('an update creates the notify/bridge objects when the file has neither', () => {
  withConfig({ docker: true }, (p) => {
    const res = updateBridgeSettings({ enabled: true });
    assert.equal(res.ok, true);
    assert.deepEqual(readBack(p).notify.bridge, { enabled: true });
    assert.equal(readBack(p).docker, true);
  });
});

test('an update against a missing config file creates it', () => {
  withConfig(null, (p) => {
    assert.equal(updateBridgeSettings({ enabled: true }).ok, true);
    assert.equal(readBack(p).notify.bridge.enabled, true);
  });
});

test('the written file stays 2-space formatted with a trailing newline', () => {
  withConfig({ docker: true }, (p) => {
    updateBridgeSettings({ enabled: true });
    const text = readFileSync(p, 'utf-8');
    assert.ok(text.endsWith('\n'), 'trailing newline');
    assert.match(text, /\n {2}"notify": \{/, '2-space indentation');
  });
});

test('a leftover notify.vikunja block survives a bridge update untouched', () => {
  // The Vikunja channel is gone but an operator's file may still carry the
  // key; a bridge edit must not be the thing that silently rewrites it.
  withConfig({ notify: { vikunja: { baseUrl: 'https://v.example', apiToken: 't' } } }, (p) => {
    assert.equal(updateBridgeSettings({ enabled: true }).ok, true);
    assert.deepEqual(readBack(p).notify.vikunja, { baseUrl: 'https://v.example', apiToken: 't' });
  });
});

// --- path agreement ----------------------------------------------------------

test('this module writes the same file networkAllowlist.js does', () => {
  withConfig({}, (p) => {
    assert.equal(resolveSandboxConfigPath(), p,
      'both Settings slices must edit one config file, not two');
  });
});

test('sandbox.config.example.json documents exactly the code defaults', () => {
  // The example file is what an operator copies to sandbox.config.json. If it
  // drifts from BRIDGE_DEFAULTS, copying it silently changes behavior relative
  // to running with no config at all.
  const examplePath = new URL('../sandbox.config.example.json', import.meta.url);
  const example = JSON.parse(readFileSync(examplePath, 'utf-8'));
  assert.deepEqual(
    normalizeBridgeSettings(example.notify?.bridge),
    normalizeBridgeSettings(undefined),
    'the example notify.bridge block must normalize to the built-in defaults',
  );
});

// --- attacker review F2 / code review F9: atomic writes ----------------------

test('the config is replaced atomically, never truncated in place', () => {
  // A plain writeFileSync truncates first, so a crash or ENOSPC mid-write
  // leaves a partial JSON document -- and server/index.js refuses to BOOT on a
  // config it cannot parse. The swap must be a rename.
  withConfig({ docker: true, notify: { discordWebhook: 'https://discord.example/hook' } }, (p) => {
    const before = readFileSync(p, 'utf-8');
    assert.equal(updateBridgeSettings({ enabled: true }).ok, true);
    const after = readBack(p);
    assert.equal(after.notify.bridge.enabled, true);
    assert.equal(after.notify.discordWebhook, 'https://discord.example/hook');
    assert.notEqual(readFileSync(p, 'utf-8'), before);
    // No temp file is left behind on success.
    const leftovers = readdirSync(dirname(p)).filter((f) => f.includes('.tmp-'));
    assert.deepEqual(leftovers, []);
  });
});

test('a write that cannot land is reported, not half-applied', () => {
  // Point the config at a path whose directory does not exist: the temp write
  // itself fails, so there is nothing to rename and nothing to clean up. The
  // caller must hear about it rather than believe the save succeeded.
  const dir = mkdtempSync(join(tmpdir(), 'ccserver-bridge-fail-'));
  const prev = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_SANDBOX_CONFIG = join(dir, 'no-such-dir', 'sandbox.config.json');
  try {
    const res = updateBridgeSettings({ enabled: true });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'internal');
    assert.match(res.message, /could not write the sandbox config/);
    assert.deepEqual(readdirSync(dir), [], 'no stray temp file');
  } finally {
    if (prev === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
    else process.env.CCSERVER_SANDBOX_CONFIG = prev;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// --- attacker review F1: the settings cache ----------------------------------

test('the cached read does not touch the filesystem within its TTL', () => {
  withConfig({ notify: { bridge: { enabled: true } } }, (p) => {
    invalidateBridgeSettingsCache();
    const first = getBridgeSettingsCached(1_000_000);
    assert.equal(first.enabled, true);
    // Change the file underneath: a cached read must not see it yet.
    writeFileSync(p, JSON.stringify({ notify: { bridge: { enabled: false } } }));
    assert.equal(getBridgeSettingsCached(1_000_500).enabled, true, 'still cached');
    assert.equal(getBridgeSettingsCached(1_001_001).enabled, false, 'TTL expired, re-read');
  });
});

test('a write invalidates the cache, so the GUI sees its own change immediately', () => {
  withConfig({ notify: { bridge: { enabled: false } } }, () => {
    invalidateBridgeSettingsCache();
    assert.equal(getBridgeSettingsCached(2_000_000).enabled, false);
    assert.equal(updateBridgeSettings({ enabled: true }).ok, true);
    // Same millisecond, well inside the TTL -- the PUT path must not be stale.
    assert.equal(getBridgeSettingsCached(2_000_000).enabled, true);
  });
});
