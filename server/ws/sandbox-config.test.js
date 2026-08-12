import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSandboxConfig } from './sandbox.js';

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

test('defaultApp accepts copilot and falls back to claude for anything else', () => {
  withConfig({ defaultApp: 'copilot' }, () => {
    assert.equal(loadSandboxConfig().defaultApp, 'copilot');
  });
  withConfig({ defaultApp: 'opencode' }, () => {
    assert.equal(loadSandboxConfig().defaultApp, 'opencode');
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
