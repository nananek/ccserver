import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { loadSandboxConfig, installedApps, selectableAppIds, APP_IDS } from './sandbox.js';

// loadSandboxConfig reads the file at CCSERVER_SANDBOX_CONFIG (else the
// default server/sandbox.config.json). Point it at a temp file to exercise the
// forceSandbox parsing without touching a real deployment config.
function withConfig(json, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ccserver-sandbox-config-'));
  const path = join(dir, 'sandbox.config.json');
  try {
    writeFileSync(path, JSON.stringify(json));
    const prev = process.env.CCSERVER_SANDBOX_CONFIG;
    process.env.CCSERVER_SANDBOX_CONFIG = path;
    try {
      fn();
    } finally {
      if (prev === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
      else process.env.CCSERVER_SANDBOX_CONFIG = prev;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('forceSandbox defaults to false when the key is absent', () => {
  withConfig({ docker: true }, () => {
    assert.equal(loadSandboxConfig().forceSandbox, false);
  });
});

test('persistentHome defaults to true when the key is absent', () => {
  withConfig({ docker: true }, () => {
    assert.equal(loadSandboxConfig().persistentHome, true);
  });
});

test('persistentHome is false only for an explicit false value', () => {
  withConfig({ persistentHome: false }, () => {
    assert.equal(loadSandboxConfig().persistentHome, false);
  });
  withConfig({ persistentHome: true }, () => {
    assert.equal(loadSandboxConfig().persistentHome, true);
  });
  withConfig({ persistentHome: 'no' }, () => {
    assert.equal(loadSandboxConfig().persistentHome, true, 'non-boolean falls back to the default (on)');
  });
  withConfig({}, () => {
    assert.equal(loadSandboxConfig().persistentHome, true);
  });
});

test('gpgVault (plan: gpg-agent-vault) is opt-in and only true for an explicit true value', () => {
  withConfig({ gpgVault: true }, () => {
    assert.equal(loadSandboxConfig().gpgVault, true);
  });
  withConfig({ gpgVault: false }, () => {
    assert.equal(loadSandboxConfig().gpgVault, false);
  });
  withConfig({ gpgVault: 'yes' }, () => {
    assert.equal(loadSandboxConfig().gpgVault, false, 'non-boolean falls back to the default (off)');
  });
  withConfig({}, () => {
    assert.equal(loadSandboxConfig().gpgVault, false, 'absent defaults to off, like gpg/sshAgent');
  });
});

test('forceSandbox is true only for an explicit true value', () => {
  withConfig({ forceSandbox: true }, () => {
    assert.equal(loadSandboxConfig().forceSandbox, true);
  });
  withConfig({ forceSandbox: false }, () => {
    assert.equal(loadSandboxConfig().forceSandbox, false);
  });
  withConfig({ forceSandbox: 'yes' }, () => {
    assert.equal(loadSandboxConfig().forceSandbox, false);
  });
});

test('forceSandbox coexists with the other config keys', () => {
  withConfig({ forceSandbox: true, gitBroker: false, defaultApp: 'opencode' }, () => {
    const cfg = loadSandboxConfig();
    assert.equal(cfg.forceSandbox, true);
    assert.equal(cfg.gitBroker, false);
    assert.equal(cfg.defaultApp, 'opencode');
  });
});

test('defaultApp accepts supported apps and falls back to claude for anything else', () => {
  withConfig({ defaultApp: 'copilot' }, () => {
    assert.equal(loadSandboxConfig().defaultApp, 'copilot');
  });
  withConfig({ defaultApp: 'opencode' }, () => {
    assert.equal(loadSandboxConfig().defaultApp, 'opencode');
  });
  withConfig({ defaultApp: 'codex' }, () => {
    assert.equal(loadSandboxConfig().defaultApp, 'codex');
  });
  withConfig({ defaultApp: 'bogus' }, () => {
    assert.equal(loadSandboxConfig().defaultApp, 'claude');
  });
  withConfig({}, () => {
    assert.equal(loadSandboxConfig().defaultApp, 'claude');
  });
});

test('showUsage defaults to true when the key is absent', () => {
  withConfig({ docker: true }, () => {
    assert.equal(loadSandboxConfig().showUsage, true);
  });
});

test('showUsage is false only for an explicit false value', () => {
  withConfig({ showUsage: false }, () => {
    assert.equal(loadSandboxConfig().showUsage, false);
  });
  withConfig({ showUsage: true }, () => {
    assert.equal(loadSandboxConfig().showUsage, true);
  });
  withConfig({ showUsage: 'no' }, () => {
    assert.equal(loadSandboxConfig().showUsage, true);
  });
  withConfig({}, () => {
    assert.equal(loadSandboxConfig().showUsage, true);
  });
});

test('usageMcp is opt-in and only true for an explicit true value', () => {
  withConfig({}, () => {
    assert.equal(loadSandboxConfig().usageMcp, false);
  });
  withConfig({ usageMcp: true }, () => {
    assert.equal(loadSandboxConfig().usageMcp, true);
  });
  withConfig({ usageMcp: false }, () => {
    assert.equal(loadSandboxConfig().usageMcp, false);
  });
  withConfig({ usageMcp: 'yes' }, () => {
    assert.equal(loadSandboxConfig().usageMcp, false);
  });
});

// ccserver-notify config (see notify.js): the Discord webhook is parsed only
// when it is an https:// URL; anything else is dropped. The env override
// CCSERVER_DISCORD_WEBHOOK wins over the config file.
test('notify.discordWebhook parses https URLs, rejects others, env override wins', () => {
  withConfig({ notify: { discordWebhook: 'https://discord.com/api/webhooks/x' } }, () => {
    assert.equal(loadSandboxConfig().notify.discordWebhook, 'https://discord.com/api/webhooks/x');
  });
  withConfig({ notify: { discordWebhook: 'http://insecure.example/hook' } }, () => {
    assert.equal(loadSandboxConfig().notify.discordWebhook, null, 'non-https webhook is rejected');
  });
  withConfig({}, () => {
    assert.equal(loadSandboxConfig().notify.discordWebhook, null, 'absent key -> null');
    assert.deepEqual(loadSandboxConfig().notify.subscriptions, [], 'absent subscriptions -> []');
  });
  withConfig({ notify: { discordWebhook: 'https://file.example/hook' } }, () => {
    process.env.CCSERVER_DISCORD_WEBHOOK = 'https://env.example/hook';
    try {
      assert.equal(loadSandboxConfig().notify.discordWebhook, 'https://env.example/hook', 'env override wins');
    } finally {
      delete process.env.CCSERVER_DISCORD_WEBHOOK;
    }
  });
});

test('notify.subscriptions seeds only https webhook urls, keeping names', () => {
  withConfig({
    notify: {
      subscriptions: [
        { url: 'https://ok.example/hook', name: 'slack' },
        { url: 'ftp://bad.example/hook', name: 'bad' },
        { url: 'https://another.example/hook' },
      ],
    },
  }, () => {
    assert.deepEqual(loadSandboxConfig().notify.subscriptions, [
      { url: 'https://ok.example/hook', name: 'slack' },
      { url: 'https://another.example/hook', name: null },
    ]);
  });
});

// notify.vikunja (see vikunjaClient.js): baseUrl/apiToken follow the same
// https-only / env-override-wins pattern as discordWebhook above; the rest
// (projectId, timeoutSeconds, verifyTls, the label prefixes) just need
// sensible defaults when absent.
test('notify.vikunja.baseUrl parses https URLs, rejects others, env override wins', () => {
  withConfig({ notify: { vikunja: { baseUrl: 'https://vikunja.example/' } } }, () => {
    assert.equal(loadSandboxConfig().notify.vikunja.baseUrl, 'https://vikunja.example', 'trailing slash is stripped');
  });
  withConfig({ notify: { vikunja: { baseUrl: 'http://insecure.example' } } }, () => {
    assert.equal(loadSandboxConfig().notify.vikunja.baseUrl, null, 'non-https baseUrl is rejected');
  });
  withConfig({}, () => {
    assert.equal(loadSandboxConfig().notify.vikunja.baseUrl, null, 'absent key -> null');
    assert.equal(loadSandboxConfig().notify.vikunja.apiToken, null);
    assert.equal(loadSandboxConfig().notify.vikunja.projectId, null);
  });
  withConfig({ notify: { vikunja: { baseUrl: 'https://file.example' } } }, () => {
    process.env.CCSERVER_VIKUNJA_BASE_URL = 'https://env.example';
    try {
      assert.equal(loadSandboxConfig().notify.vikunja.baseUrl, 'https://env.example', 'env override wins');
    } finally {
      delete process.env.CCSERVER_VIKUNJA_BASE_URL;
    }
  });
});

test('notify.vikunja.apiToken/projectId are read from config, env overrides both', () => {
  withConfig({ notify: { vikunja: { apiToken: 'file-tok', projectId: 5 } } }, () => {
    assert.equal(loadSandboxConfig().notify.vikunja.apiToken, 'file-tok');
    assert.equal(loadSandboxConfig().notify.vikunja.projectId, 5);
  });
  withConfig({ notify: { vikunja: { apiToken: 'file-tok', projectId: 5 } } }, () => {
    process.env.CCSERVER_VIKUNJA_API_TOKEN = 'env-tok';
    process.env.CCSERVER_VIKUNJA_PROJECT_ID = '9';
    try {
      assert.equal(loadSandboxConfig().notify.vikunja.apiToken, 'env-tok', 'env override wins for apiToken');
      assert.equal(loadSandboxConfig().notify.vikunja.projectId, '9', 'env override wins for projectId');
    } finally {
      delete process.env.CCSERVER_VIKUNJA_API_TOKEN;
      delete process.env.CCSERVER_VIKUNJA_PROJECT_ID;
    }
  });
});

// hiddenApps (issue #105): apps the operator hasn't contracted for, removed
// from every launch picker regardless of install status. Unlike the other
// flags above this is an array of app ids, so it needs its own validation:
// unknown entries dropped, duplicates collapsed, non-array falls back to [].
test('hiddenApps defaults to [] when the key is absent', () => {
  withConfig({}, () => {
    assert.deepEqual(loadSandboxConfig().hiddenApps, []);
  });
});

test('hiddenApps keeps only known app ids and dedupes them', () => {
  withConfig({ hiddenApps: ['copilot', 'codex', 'copilot', 'bogus', 42, null] }, () => {
    assert.deepEqual(loadSandboxConfig().hiddenApps, ['copilot', 'codex']);
  });
});

test('hiddenApps falls back to [] for a non-array value', () => {
  withConfig({ hiddenApps: 'copilot' }, () => {
    assert.deepEqual(loadSandboxConfig().hiddenApps, []);
  });
  withConfig({ hiddenApps: { copilot: true } }, () => {
    assert.deepEqual(loadSandboxConfig().hiddenApps, []);
  });
});

test('hiddenApps can hide every known app', () => {
  withConfig({ hiddenApps: [...APP_IDS] }, () => {
    assert.deepEqual(loadSandboxConfig().hiddenApps, APP_IDS);
  });
});

// selectableAppIds() = installedApps() ∩ !hiddenApps -- the "actually
// selectable" set the server-startup guard in index.js refuses to boot on
// when empty. installedApps() itself depends on the real host, so these
// assert the INTERSECTION logic against whatever installedApps() reports,
// rather than hardcoding which apps are installed.
test('selectableAppIds mirrors installedApps when hiddenApps is empty', () => {
  withConfig({}, () => {
    const installed = installedApps();
    assert.deepEqual(selectableAppIds(), APP_IDS.filter((a) => installed[a]));
  });
});

test('selectableAppIds drops a hidden app even when it is installed', () => {
  withConfig({ hiddenApps: ['claude'] }, () => {
    const installed = installedApps();
    const expected = APP_IDS.filter((a) => a !== 'claude' && installed[a]);
    assert.deepEqual(selectableAppIds(), expected);
    assert.ok(!selectableAppIds().includes('claude'), 'claude never appears once hidden');
  });
});

test('selectableAppIds is empty once every app id is hidden, regardless of install state', () => {
  withConfig({ hiddenApps: [...APP_IDS] }, () => {
    assert.deepEqual(selectableAppIds(), [], 'this is exactly the condition index.js refuses to boot on');
  });
});

// Deterministic positive case (mirrors usageMcp.test.js's withUsageConfig
// pattern): CCSERVER_CLAUDE_BIN pinned at a real, always-executable file
// (the running node binary) makes resolveApp('claude') -- and therefore
// installedApps().claude -- report true regardless of this host's PATH.
test('selectableAppIds keeps claude selectable when only the other apps are hidden', () => {
  const prevBin = process.env.CCSERVER_CLAUDE_BIN;
  process.env.CCSERVER_CLAUDE_BIN = process.execPath;
  try {
    withConfig({ hiddenApps: ['opencode', 'copilot', 'codex'] }, () => {
      assert.deepEqual(selectableAppIds(), ['claude']);
    });
  } finally {
    if (prevBin === undefined) delete process.env.CCSERVER_CLAUDE_BIN;
    else process.env.CCSERVER_CLAUDE_BIN = prevBin;
  }
});

// opencodeGoUsage (see opencodeUsage.js): the one resolveFlag() consumer, so
// this doubles as coverage for resolveFlag()'s file-value word-form parsing
// (issue: a quoted "false" in the config file used to be silently ignored,
// since only a strict boolean fileVal was ever recognized -- see #6).
test('opencodeGoUsage defaults to true when the key is absent', () => {
  withConfig({}, () => {
    assert.equal(loadSandboxConfig().opencodeGoUsage, true);
  });
});

test('opencodeGoUsage is false for an explicit false value, or a recognized falsy word form', () => {
  withConfig({ opencodeGoUsage: false }, () => {
    assert.equal(loadSandboxConfig().opencodeGoUsage, false);
  });
  withConfig({ opencodeGoUsage: true }, () => {
    assert.equal(loadSandboxConfig().opencodeGoUsage, true);
  });
  withConfig({ opencodeGoUsage: 'false' }, () => {
    assert.equal(loadSandboxConfig().opencodeGoUsage, false, 'a quoted "false" in the file must disable it, not fall back to the default');
  });
  withConfig({ opencodeGoUsage: 'off' }, () => {
    assert.equal(loadSandboxConfig().opencodeGoUsage, false);
  });
  withConfig({ opencodeGoUsage: '0' }, () => {
    assert.equal(loadSandboxConfig().opencodeGoUsage, false);
  });
  withConfig({ opencodeGoUsage: 'nonsense' }, () => {
    assert.equal(loadSandboxConfig().opencodeGoUsage, true, 'unrecognized file value falls back to the default (on)');
  });
});

test('opencodeGoUsage: env override wins over the file both ways, unrecognized env falls back to the file', () => {
  withConfig({ opencodeGoUsage: true }, () => {
    process.env.CCSERVER_OPENCODE_GO_USAGE = '0';
    try {
      assert.equal(loadSandboxConfig().opencodeGoUsage, false, 'env override wins over a true file value');
    } finally {
      delete process.env.CCSERVER_OPENCODE_GO_USAGE;
    }
  });
  withConfig({ opencodeGoUsage: false }, () => {
    process.env.CCSERVER_OPENCODE_GO_USAGE = '1';
    try {
      assert.equal(loadSandboxConfig().opencodeGoUsage, true, 'env override wins over a false file value');
    } finally {
      delete process.env.CCSERVER_OPENCODE_GO_USAGE;
    }
  });
  withConfig({ opencodeGoUsage: 'off' }, () => {
    process.env.CCSERVER_OPENCODE_GO_USAGE = 'maybe';
    try {
      assert.equal(loadSandboxConfig().opencodeGoUsage, false, 'unrecognized env falls back to the (parsed) file value');
    } finally {
      delete process.env.CCSERVER_OPENCODE_GO_USAGE;
    }
  });
});

test('notify.vikunja defaults: timeoutSeconds=15, verifyTls=true, statusLabelPrefix=status-', () => {
  withConfig({}, () => {
    const v = loadSandboxConfig().notify.vikunja;
    assert.equal(v.timeoutSeconds, 15);
    assert.equal(v.verifyTls, true);
    assert.equal(v.statusLabelPrefix, 'status-');
  });
  withConfig({ notify: { vikunja: { timeoutSeconds: 30, verifyTls: false, statusLabelPrefix: 'state-' } } }, () => {
    const v = loadSandboxConfig().notify.vikunja;
    assert.equal(v.timeoutSeconds, 30);
    assert.equal(v.verifyTls, false);
    assert.equal(v.statusLabelPrefix, 'state-');
  });
});

test('network defaults: isolate=false, initialState=enforce, mode=enforce, empty lists', () => {
  withConfig({}, () => {
    assert.deepEqual(loadSandboxConfig().network, { isolate: false, initialState: 'enforce', mode: 'enforce', allowedHosts: [], deniedHosts: [] });
  });
});

test('network: isolate/initialState/mode/allowedHosts/deniedHosts are read from the config file', () => {
  withConfig({ network: { isolate: true, initialState: 'open', mode: 'audit', allowedHosts: ['api.example.com'], deniedHosts: ['evil.example'] } }, () => {
    assert.deepEqual(loadSandboxConfig().network, { isolate: true, initialState: 'open', mode: 'audit', allowedHosts: ['api.example.com'], deniedHosts: ['evil.example'] });
  });
});

test('network: initialState collapses anything but "open" to "enforce"', () => {
  withConfig({ network: { initialState: 'sometimes' } }, () => {
    assert.equal(loadSandboxConfig().network.initialState, 'enforce');
  });
  withConfig({ network: { initialState: 'open' } }, () => {
    assert.equal(loadSandboxConfig().network.initialState, 'open');
  });
});

test('network: mode collapses anything but "audit" to "enforce"', () => {
  withConfig({ network: { mode: 'sometimes' } }, () => {
    assert.equal(loadSandboxConfig().network.mode, 'enforce');
  });
  withConfig({ network: { mode: 'audit' } }, () => {
    assert.equal(loadSandboxConfig().network.mode, 'audit');
  });
});

test('network: allowedHosts/deniedHosts filter out non-string entries', () => {
  withConfig({ network: { allowedHosts: ['a.example', 42, null, ''], deniedHosts: ['b.example', 42, null, ''] } }, () => {
    const net = loadSandboxConfig().network;
    assert.deepEqual(net.allowedHosts, ['a.example']);
    assert.deepEqual(net.deniedHosts, ['b.example']);
  });
});

test('network: a non-object "network" key collapses to defaults', () => {
  withConfig({ network: 'nope' }, () => {
    assert.deepEqual(loadSandboxConfig().network, { isolate: false, initialState: 'enforce', mode: 'enforce', allowedHosts: [], deniedHosts: [] });
  });
  withConfig({ network: ['nope'] }, () => {
    assert.deepEqual(loadSandboxConfig().network, { isolate: false, initialState: 'enforce', mode: 'enforce', allowedHosts: [], deniedHosts: [] });
  });
});

// browseRoots (issue #189): restricts /api/files, /api/dirs and /ws/terminal
// session cwds to these directories. [] (default) means unrestricted --
// preserving the pre-#189 host-wide behavior -- so most of the actual
// containment logic lives in pathPolicy.test.js; this just covers parsing.
test('browseRoots defaults to [] when the key is absent', () => {
  withConfig({}, () => {
    const cfg = loadSandboxConfig();
    assert.deepEqual(cfg.browseRoots, []);
    assert.equal(cfg.browseRootsInvalid, false, 'absent is unrestricted, not invalid');
  });
});

test('browseRoots resolves relative/home-relative entries and dedupes', () => {
  withConfig({ browseRoots: ['/srv/projects', '/srv/projects/', '~/repos'] }, () => {
    const { browseRoots } = loadSandboxConfig();
    assert.deepEqual(browseRoots, ['/srv/projects', join(homedir(), 'repos')]);
  });
});

// Fail closed (issue #189 self-review): a present-but-unusable browseRoots
// must NOT silently collapse to [] ("unrestricted"). The normalized value is
// still [] for back-compat of this accessor, but browseRootsInvalid marks it
// so every enforcement point (and index.js's boot guard) refuses instead of
// widening access.
test('browseRoots flags a non-array value as invalid (never as unrestricted)', () => {
  withConfig({ browseRoots: '/srv/projects' }, () => {
    const cfg = loadSandboxConfig();
    assert.deepEqual(cfg.browseRoots, []);
    assert.equal(cfg.browseRootsInvalid, true);
  });
  withConfig({ browseRoots: { root: '/srv/projects' } }, () => {
    assert.equal(loadSandboxConfig().browseRootsInvalid, true);
  });
  withConfig({ browseRoots: [42, null, ''] }, () => {
    const cfg = loadSandboxConfig();
    assert.deepEqual(cfg.browseRoots, []);
    assert.equal(cfg.browseRootsInvalid, true, 'every entry dropped means nothing to enforce');
  });
});

test('browseRoots keeps an explicit [] valid (the documented unrestricted spelling)', () => {
  withConfig({ browseRoots: [] }, () => {
    const cfg = loadSandboxConfig();
    assert.deepEqual(cfg.browseRoots, []);
    assert.equal(cfg.browseRootsInvalid, false);
  });
});

test('browseRoots drops non-string / empty-string entries', () => {
  withConfig({ browseRoots: ['/srv/projects', 42, null, ''] }, () => {
    const cfg = loadSandboxConfig();
    assert.deepEqual(cfg.browseRoots, ['/srv/projects']);
    assert.equal(cfg.browseRootsInvalid, false, 'partial drops still restrict by the valid entries');
  });
});

// A config file that exists but cannot be parsed is treated as invalid too:
// silently running with every setting defaulted would drop browseRoots (and
// forceSandbox) without a word.
test('an unparseable sandbox.config.json sets configError and flags browseRootsInvalid', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccserver-sandbox-cfg-bad-'));
  const path = join(dir, 'sandbox.config.json');
  writeFileSync(path, '{ "browseRoots": ["/srv/projects"], ');
  const prev = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_SANDBOX_CONFIG = path;
  try {
    const cfg = loadSandboxConfig();
    assert.ok(cfg.configError, 'a parse error must be reported, not swallowed');
    assert.equal(cfg.browseRootsInvalid, true, 'an unreadable policy must fail closed');
  } finally {
    if (prev === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
    else process.env.CCSERVER_SANDBOX_CONFIG = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

// allowUnsandboxedAgents: only meaningful alongside browseRoots (createSession
// gates on it there), but the parse itself is independent -- same
// strict-boolean pattern as forceSandbox.
test('allowUnsandboxedAgents defaults to false and is true only for an explicit true value', () => {
  withConfig({}, () => {
    assert.equal(loadSandboxConfig().allowUnsandboxedAgents, false);
  });
  withConfig({ allowUnsandboxedAgents: 'true' }, () => {
    assert.equal(loadSandboxConfig().allowUnsandboxedAgents, false);
  });
  withConfig({ allowUnsandboxedAgents: true }, () => {
    assert.equal(loadSandboxConfig().allowUnsandboxedAgents, true);
  });
});
