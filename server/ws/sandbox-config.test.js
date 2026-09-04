import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
