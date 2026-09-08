// notify.js -- the server-global ccserver-notify registry + delivery. Tests
// the pure decision and persistence paths (withConfig-style temp files, like
// sandbox-config.test.js / groupManager.test.js) and the fetch delivery with a
// mocked global.fetch. The broker lifecycle (Unix socket + MCP wire) is covered
// in mcpBroker.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, hostname } from 'node:os';
import {
  notifyEnabled,
  shouldInjectNotify,
  subscribe,
  unsubscribe,
  listSubscriptions,
  restoreNotify,
  sendNotification,
  resolvedHostname,
} from './notify.js';

// Point CCSERVER_SANDBOX_CONFIG + CCSERVER_NOTIFY_PATH at temp files and
// isolate from any CCSERVER_DISCORD_WEBHOOK leak from the environment.
async function withNotifyConfig(sandboxJson, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ccserver-notify-'));
  const cfgPath = join(dir, 'sandbox.config.json');
  const statePath = join(dir, 'notifications.json');
  const prevCfg = process.env.CCSERVER_SANDBOX_CONFIG;
  const prevPath = process.env.CCSERVER_NOTIFY_PATH;
  const prevWebhook = process.env.CCSERVER_DISCORD_WEBHOOK;
  try {
    writeFileSync(cfgPath, JSON.stringify(sandboxJson));
    process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
    process.env.CCSERVER_NOTIFY_PATH = statePath;
    delete process.env.CCSERVER_DISCORD_WEBHOOK;
    await fn(statePath);
  } finally {
    if (prevCfg === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
    else process.env.CCSERVER_SANDBOX_CONFIG = prevCfg;
    if (prevPath === undefined) delete process.env.CCSERVER_NOTIFY_PATH;
    else process.env.CCSERVER_NOTIFY_PATH = prevPath;
    if (prevWebhook === undefined) delete process.env.CCSERVER_DISCORD_WEBHOOK;
    else process.env.CCSERVER_DISCORD_WEBHOOK = prevWebhook;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

test('notifyEnabled: discord-only, subscriptions-only, and neither', async () => {
  await withNotifyConfig({ notify: { subscriptions: [] } }, async () => {
    restoreNotify();
    assert.equal(notifyEnabled(), false, 'no webhook + empty registry -> disabled');
  });
  await withNotifyConfig({ notify: { discordWebhook: 'https://discord.example/hook' } }, async () => {
    restoreNotify();
    assert.equal(notifyEnabled(), true, 'a Discord webhook alone enables it');
  });
  await withNotifyConfig({ notify: { subscriptions: [{ url: 'https://example.com/sub' }] } }, async () => {
    restoreNotify();
    assert.equal(notifyEnabled(), true, 'a seeded subscription alone enables it');
  });
});

// Confirmed with the user (see tmp/notify-vikunja-integration-plan.md section
// 5, point 2): a Vikunja-only setup -- no Discord webhook, no subscriptions --
// still counts as "notify is on" so the MCP server gets injected. This is the
// one point the plan left open that was explicitly resolved before
// implementation.
test('notifyEnabled: vikunja-only (no discord, no subscriptions) also enables it', async () => {
  await withNotifyConfig(
    { notify: { subscriptions: [], vikunja: { baseUrl: 'https://vikunja.example', apiToken: 'tok' } } },
    async () => {
      restoreNotify();
      assert.equal(notifyEnabled(), true, 'vikunja baseUrl+apiToken alone enables notify');
    },
  );
  await withNotifyConfig(
    { notify: { subscriptions: [], vikunja: { baseUrl: 'https://vikunja.example' } } },
    async () => {
      restoreNotify();
      assert.equal(notifyEnabled(), false, 'vikunja baseUrl alone (no apiToken) is not enough');
    },
  );
});

test('shouldInjectNotify: standalone agents and combo orchestrators only', () => {
  const base = { shell: false, app: 'claude', groupId: null, groupRole: null, notifyEnabled: true };
  assert.equal(shouldInjectNotify(base), true, 'standalone agent session');
  assert.equal(shouldInjectNotify({ ...base, app: 'opencode' }), true, 'standalone agent (opencode)');
  assert.equal(shouldInjectNotify({ ...base, groupId: 'g1', groupRole: 'orchestrator' }), true, 'combo orchestrator');
  assert.equal(shouldInjectNotify({ ...base, shell: true, app: null }), false, 'shell sessions never');
  assert.equal(shouldInjectNotify({ ...base, groupId: 'g1', groupRole: 'workerA' }), false, 'combo worker never');
  assert.equal(shouldInjectNotify({ ...base, notifyEnabled: false }), false, 'feature disabled -> never');
});

test('shouldInjectNotify: copilot is never injected (no CLI-arg/env MCP injection)', () => {
  const base = { shell: false, app: 'copilot', groupId: null, groupRole: null, notifyEnabled: true };
  assert.equal(shouldInjectNotify(base), false, 'standalone copilot never gets the notify server');
  assert.equal(shouldInjectNotify({ ...base, groupId: 'g1', groupRole: 'orchestrator' }), false, 'copilot as combo orchestrator also never');
});

test('subscribe/unsubscribe/list persist to the state file and restore', async () => {
  await withNotifyConfig(
    { notify: { subscriptions: [{ url: 'https://seed.example/webhook', name: 'seed' }] } },
    async (statePath) => {
      restoreNotify();
      assert.equal(listSubscriptions().length, 1, 'config seed is the initial registry');
      assert.equal(listSubscriptions()[0].name, 'seed');

      const added = subscribe({ url: 'https://example.com/runtime' });
      assert.equal(added.ok, true);
      assert.ok(added.subscription.id, 'runtime subscription gets an id');
      assert.equal(listSubscriptions().length, 2);

      const saved = JSON.parse(readFileSync(statePath, 'utf-8'));
      assert.equal(saved.subscriptions.length, 2, 'subscribe persists');

      assert.deepEqual(
        subscribe({ url: 'http://insecure.example/webhook' }),
        { error: 'invalid-url', message: 'webhook url must be an https:// URL' },
        'non-https urls are rejected',
      );

      assert.deepEqual(unsubscribe(added.subscription.id), { ok: true });
      assert.equal(listSubscriptions().length, 1);
      const after = JSON.parse(readFileSync(statePath, 'utf-8'));
      assert.equal(after.subscriptions.length, 1, 'unsubscribe persists');
      assert.equal(after.subscriptions[0].url, 'https://seed.example/webhook');

      assert.deepEqual(unsubscribe('no-such-id'), { error: 'not-found' });

      // A fresh boot re-reads config seed + persisted registry (deduped).
      restoreNotify();
      const urls = listSubscriptions().map((s) => s.url);
      assert.deepEqual(urls, ['https://seed.example/webhook'], 'unsubscribed entry does not resurrect');
    },
  );
});

test('a persisted runtime-only subscription restores alongside the config seed', async () => {
  await withNotifyConfig(
    { notify: { subscriptions: [{ url: 'https://seed.example/webhook' }] } },
    async (statePath) => {
      writeFileSync(statePath, JSON.stringify({
        subscriptions: [{ id: 'persisted-id', url: 'https://persisted.example/webhook', name: 'persisted', createdAt: 1 }],
      }));
      restoreNotify();
      const urls = listSubscriptions().map((s) => s.url);
      assert.ok(urls.includes('https://seed.example/webhook'), 'config seed restored');
      assert.ok(urls.includes('https://persisted.example/webhook'), 'persisted runtime subscription restored');
      const persisted = listSubscriptions().find((s) => s.url === 'https://persisted.example/webhook');
      assert.equal(persisted.id, 'persisted-id', 'restore keeps the persisted id');
    },
  );
});

test('sendNotification POSTs { content, username } to discord and every subscription', async () => {
  await withNotifyConfig(
    { notify: { discordWebhook: 'https://discord.example/hook' } },
    async () => {
      restoreNotify();
      subscribe({ url: 'https://hook-a.example/x', name: 'slack' });
      subscribe({ url: 'https://hook-b.example/x' });

      const calls = [];
      const realFetch = global.fetch;
      global.fetch = async (url, opts) => {
        calls.push({ url: String(url), opts });
        if (String(url).includes('hook-a')) throw new Error('unreachable');
        return { ok: true };
      };
      try {
        const res = await sendNotification({ title: 'Build failed', body: 'details here', level: 'error' });
        assert.equal(res.ok, true);
        assert.deepEqual(res.delivered, { discord: true, webhooks: 1, failed: 1 },
          'discord ok, one subscription ok, the failing one counted');
        assert.equal(calls.length, 3, 'discord + two subscriptions');

        const [discord, a, b] = calls;
        assert.equal(discord.url, 'https://discord.example/hook');
        assert.equal(discord.opts.method, 'POST');
        assert.equal(discord.opts.headers['Content-Type'], 'application/json');
        const payload = JSON.parse(discord.opts.body);
        assert.equal(payload.username, 'ccserver');
        assert.ok(payload.content.startsWith('🚨 Build failed'), 'level emoji prefixes title');
        assert.ok(payload.content.includes('details here'), 'body included');
        assert.equal(a.url, 'https://hook-a.example/x');
        assert.equal(b.url, 'https://hook-b.example/x');
      } finally {
        global.fetch = realFetch;
      }
    },
  );
});

test('sendNotification never throws and an empty message sends nothing', async () => {
  await withNotifyConfig({ notify: { discordWebhook: 'https://discord.example/hook' } }, async () => {
    restoreNotify();
    const realFetch = global.fetch;
    global.fetch = async () => { throw new Error('network down'); };
    try {
      const res = await sendNotification({ title: 'x' });
      assert.equal(res.ok, true, 'a total delivery failure still returns ok (non-blocking)');
      assert.deepEqual(res.delivered, { discord: false, webhooks: 0, failed: 0 });

      let calls = 0;
      global.fetch = async () => { calls++; return { ok: true }; };
      const empty = await sendNotification({});
      assert.equal(calls, 0, 'no content -> no delivery attempted');
      assert.deepEqual(empty.delivered, { discord: false, webhooks: 0, failed: 0 });
    } finally {
      global.fetch = realFetch;
    }
  });
});

// Attribution footer: sendNotification(args, identity) appends
// "_from: host · project · group <groupShort> · session <sessionShort>" to the
// payload content. host comes from the resolved notify hostname, project from
// the connection identity's projectName, group only when a groupId exists.
test('sendNotification appends an attribution footer from the connection identity', async () => {
  await withNotifyConfig({ notify: { discordWebhook: 'https://discord.example/hook' } }, async () => {
    restoreNotify();
    const calls = [];
    const realFetch = global.fetch;
    global.fetch = async (url, opts) => { calls.push({ url: String(url), opts }); return { ok: true }; };
    const prevHost = process.env.CCSERVER_HOSTNAME;
    try {
      process.env.CCSERVER_HOSTNAME = 'test-host';
      await sendNotification(
        { title: 'Build failed', body: 'details here', level: 'error' },
        { sessionId: '0123456789abcdef', groupId: 'grp-12345678', groupRole: 'orchestrator', cwd: '/srv/proj', projectName: 'proj', app: 'claude' },
      );
      const payload = JSON.parse(calls[0].opts.body);
      assert.equal(payload.username, 'ccserver');
      assert.equal(
        payload.content,
        '🚨 Build failed\ndetails here\n\n_from: test-host · proj · group grp-1234 · session 01234567',
        'footer carries host, project, short group id and short session id',
      );
    } finally {
      if (prevHost === undefined) delete process.env.CCSERVER_HOSTNAME;
      else process.env.CCSERVER_HOSTNAME = prevHost;
      global.fetch = realFetch;
    }
  });
});

test('sendNotification without identity carries a host-only footer', async () => {
  await withNotifyConfig({ notify: { discordWebhook: 'https://discord.example/hook' } }, async () => {
    restoreNotify();
    const calls = [];
    const realFetch = global.fetch;
    global.fetch = async (url, opts) => { calls.push({ url: String(url), opts }); return { ok: true }; };
    const prevHost = process.env.CCSERVER_HOSTNAME;
    try {
      process.env.CCSERVER_HOSTNAME = 'test-host';
      await sendNotification({ title: 'plain', body: 'message' });
      const payload = JSON.parse(calls[0].opts.body);
      assert.ok(payload.content.endsWith('_from: test-host'), `footer should be host-only, got: ${payload.content}`);
      assert.ok(!payload.content.includes('·'), 'no project/group/session segments without identity');
    } finally {
      if (prevHost === undefined) delete process.env.CCSERVER_HOSTNAME;
      else process.env.CCSERVER_HOSTNAME = prevHost;
      global.fetch = realFetch;
    }
  });
});

test('notify.attribution=false strips the footer entirely', async () => {
  await withNotifyConfig({ notify: { discordWebhook: 'https://discord.example/hook', attribution: false } }, async () => {
    restoreNotify();
    const calls = [];
    const realFetch = global.fetch;
    global.fetch = async (url, opts) => { calls.push({ url: String(url), opts }); return { ok: true }; };
    const prevHost = process.env.CCSERVER_HOSTNAME;
    try {
      process.env.CCSERVER_HOSTNAME = 'test-host';
      await sendNotification(
        { title: 'Build failed', body: 'details here', level: 'error' },
        { sessionId: '0123456789abcdef', groupId: 'grp-1', groupRole: 'orchestrator', cwd: '/srv/proj', projectName: 'proj' },
      );
      const payload = JSON.parse(calls[0].opts.body);
      assert.equal(payload.content, '🚨 Build failed\ndetails here', 'payload unchanged when attribution is off');
      assert.ok(!payload.content.includes('_from:'), 'no footer at all');
    } finally {
      if (prevHost === undefined) delete process.env.CCSERVER_HOSTNAME;
      else process.env.CCSERVER_HOSTNAME = prevHost;
      global.fetch = realFetch;
    }
  });
});

// Hostname resolution precedence: CCSERVER_HOSTNAME > notify.hostname > the
// OS hostname (os.hostname()).
test('notify hostname precedence: env wins over config, config over os.hostname()', async () => {
  const prevHost = process.env.CCSERVER_HOSTNAME;
  const assertFooterHost = async (payloadHost) => {
    const calls = [];
    const realFetch = global.fetch;
    global.fetch = async (url, opts) => { calls.push({ url: String(url), opts }); return { ok: true }; };
    try {
      await sendNotification({ title: 'x', body: 'y' });
      const payload = JSON.parse(calls[0].opts.body);
      assert.equal(payload.content, `x\ny\n\n_from: ${payloadHost}`);
    } finally {
      global.fetch = realFetch;
    }
  };
  try {
    // CCSERVER_HOSTNAME wins over notify.hostname.
    process.env.CCSERVER_HOSTNAME = 'env-host';
    await withNotifyConfig({ notify: { discordWebhook: 'https://discord.example/hook', hostname: 'cfg-host' } }, async () => {
      restoreNotify();
      await assertFooterHost('env-host');
    });

    // notify.hostname is used when the env var is absent.
    delete process.env.CCSERVER_HOSTNAME;
    await withNotifyConfig({ notify: { discordWebhook: 'https://discord.example/hook', hostname: 'cfg-host' } }, async () => {
      restoreNotify();
      await assertFooterHost('cfg-host');
    });

    // No override -> the OS hostname.
    await withNotifyConfig({ notify: { discordWebhook: 'https://discord.example/hook' } }, async () => {
      restoreNotify();
      await assertFooterHost(hostname());
    });
  } finally {
    if (prevHost === undefined) delete process.env.CCSERVER_HOSTNAME;
    else process.env.CCSERVER_HOSTNAME = prevHost;
  }
});

// resolvedHostname() (exported for the browser tab title, dirs.js /dirs/home):
// same precedence as the footer -- CCSERVER_HOSTNAME > notify.hostname >
// os.hostname().
test('resolvedHostname precedence: env > notify.hostname > os.hostname()', async () => {
  const prevHost = process.env.CCSERVER_HOSTNAME;
  try {
    process.env.CCSERVER_HOSTNAME = 'env-host';
    await withNotifyConfig({ notify: { hostname: 'cfg-host' } }, async () => {
      assert.equal(resolvedHostname(), 'env-host');
    });
    delete process.env.CCSERVER_HOSTNAME;
    await withNotifyConfig({ notify: { hostname: 'cfg-host' } }, async () => {
      assert.equal(resolvedHostname(), 'cfg-host');
    });
    await withNotifyConfig({ notify: {} }, async () => {
      assert.equal(resolvedHostname(), hostname());
    });
  } finally {
    if (prevHost === undefined) delete process.env.CCSERVER_HOSTNAME;
    else process.env.CCSERVER_HOSTNAME = prevHost;
  }
});

// Vikunja channel (see vikunjaClient.js): sendNotification dispatches to it
// in parallel with Discord/webhooks and merges the result into
// delivered.vikunja, never letting a Vikunja failure affect the overall
// ok:true / non-blocking contract (plan section 2.5 / 6).
async function withVikunjaTasksPath(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ccserver-notify-vikunja-'));
  const tasksPath = join(dir, 'vikunja-tasks.json');
  const prev = process.env.CCSERVER_VIKUNJA_TASKS_PATH;
  process.env.CCSERVER_VIKUNJA_TASKS_PATH = tasksPath;
  try {
    await fn(tasksPath);
  } finally {
    if (prev === undefined) delete process.env.CCSERVER_VIKUNJA_TASKS_PATH;
    else process.env.CCSERVER_VIKUNJA_TASKS_PATH = prev;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

test('sendNotification includes delivered.vikunja when Vikunja is configured and a tracking key is present', async () => {
  await withNotifyConfig(
    {
      notify: {
        discordWebhook: 'https://discord.example/hook',
        vikunja: { baseUrl: 'https://vikunja.example', apiToken: 'tok', projectId: 3 },
      },
    },
    async () => {
      restoreNotify();
      await withVikunjaTasksPath(async () => {
        const realFetch = global.fetch;
        global.fetch = async (url, opts) => {
          const u = String(url);
          if (u.includes('discord.example')) return { ok: true };
          const path = new URL(u).pathname;
          const method = opts.method;
          if (method === 'GET' && path === '/api/v1/labels') return { ok: true, status: 200, text: async () => '[]' };
          if (method === 'PUT' && path === '/api/v1/labels') return { ok: true, status: 201, text: async () => JSON.stringify({ id: 1 }) };
          if (method === 'PUT' && /^\/api\/v1\/projects\/\d+\/tasks$/.test(path)) return { ok: true, status: 201, text: async () => JSON.stringify({ id: 42 }) };
          if (method === 'PUT' && /^\/api\/v1\/tasks\/\d+\/labels$/.test(path)) return { ok: true, status: 201, text: async () => '{}' };
          throw new Error(`unexpected fetch: ${method} ${path}`);
        };
        try {
          const res = await sendNotification(
            { title: 'Build failed', body: 'details', level: 'error' },
            { sessionId: 'sess-abc', groupId: null, cwd: '/srv/proj', projectName: 'proj' },
          );
          assert.equal(res.ok, true);
          assert.equal(res.delivered.discord, true);
          assert.deepEqual(res.delivered.vikunja, { ok: true, action: 'created', taskId: 42 });
        } finally {
          global.fetch = realFetch;
        }
      });
    },
  );
});

test('sendNotification omits delivered.vikunja when there is no tracking key (no identity)', async () => {
  await withNotifyConfig(
    {
      notify: {
        discordWebhook: 'https://discord.example/hook',
        vikunja: { baseUrl: 'https://vikunja.example', apiToken: 'tok', projectId: 3 },
      },
    },
    async () => {
      restoreNotify();
      const realFetch = global.fetch;
      let vikunjaCalled = false;
      global.fetch = async (url) => {
        const u = String(url);
        if (u.includes('discord.example')) return { ok: true };
        vikunjaCalled = true;
        return { ok: true, status: 200, text: async () => '{}' };
      };
      try {
        const res = await sendNotification({ title: 'x', body: 'y', level: 'info' });
        assert.equal(res.delivered.vikunja, undefined, 'no identity -> no tracking key -> vikunja is skipped entirely');
        assert.equal(vikunjaCalled, false);
      } finally {
        global.fetch = realFetch;
      }
    },
  );
});

test('sendNotification stays ok:true even when the Vikunja call fails (non-blocking, like Discord)', async () => {
  await withNotifyConfig(
    {
      notify: {
        discordWebhook: 'https://discord.example/hook',
        vikunja: { baseUrl: 'https://vikunja.example', apiToken: 'tok', projectId: 3 },
      },
    },
    async () => {
      restoreNotify();
      await withVikunjaTasksPath(async () => {
        const realFetch = global.fetch;
        global.fetch = async (url) => {
          const u = String(url);
          if (u.includes('discord.example')) return { ok: true };
          return { ok: false, status: 500, text: async () => '{}' };
        };
        try {
          const res = await sendNotification(
            { title: 'x', body: 'y', level: 'error' },
            { sessionId: 'sess-fail' },
          );
          assert.equal(res.ok, true, 'a failing Vikunja call does not fail sendNotification');
          assert.equal(res.delivered.discord, true);
          assert.equal(res.delivered.vikunja.ok, false);
        } finally {
          global.fetch = realFetch;
        }
      });
    },
  );
});

// channels param (Issue #152): lets a caller pick a subset of the configured
// channels per-call instead of always getting every configured channel.
// Omitting it (every test above) must keep delivering to everything -- these
// only cover the new, narrower channels:[...] behavior.
test("sendNotification with channels:['discord'] skips Vikunja even when configured and a tracking key is present", async () => {
  await withNotifyConfig(
    {
      notify: {
        discordWebhook: 'https://discord.example/hook',
        vikunja: { baseUrl: 'https://vikunja.example', apiToken: 'tok', projectId: 3 },
      },
    },
    async () => {
      restoreNotify();
      await withVikunjaTasksPath(async () => {
        const realFetch = global.fetch;
        let vikunjaCalled = false;
        global.fetch = async (url) => {
          const u = String(url);
          if (u.includes('discord.example')) return { ok: true };
          vikunjaCalled = true;
          return { ok: true, status: 200, text: async () => '{}' };
        };
        try {
          const res = await sendNotification(
            {
              title: 'x', body: 'y', level: 'info', channels: ['discord'],
            },
            { sessionId: 'sess-discord-only' },
          );
          assert.equal(res.ok, true);
          assert.equal(res.delivered.discord, true);
          assert.equal(res.delivered.vikunja, undefined, "channels:['discord'] must skip Vikunja entirely");
          assert.equal(vikunjaCalled, false);
        } finally {
          global.fetch = realFetch;
        }
      });
    },
  );
});

test("sendNotification with channels:['vikunja'] skips Discord and every subscribed webhook", async () => {
  await withNotifyConfig(
    {
      notify: {
        discordWebhook: 'https://discord.example/hook',
        subscriptions: [{ url: 'https://hooks.example.com/slack', name: 'slack' }],
        vikunja: { baseUrl: 'https://vikunja.example', apiToken: 'tok', projectId: 3 },
      },
    },
    async () => {
      restoreNotify();
      await withVikunjaTasksPath(async () => {
        const realFetch = global.fetch;
        let webhookCalled = false;
        global.fetch = async (url, opts) => {
          const u = String(url);
          if (u.includes('discord.example') || u.includes('hooks.example.com')) {
            webhookCalled = true;
            return { ok: true };
          }
          const path = new URL(u).pathname;
          const method = opts.method;
          if (method === 'GET' && path === '/api/v1/labels') return { ok: true, status: 200, text: async () => '[]' };
          if (method === 'PUT' && path === '/api/v1/labels') return { ok: true, status: 201, text: async () => JSON.stringify({ id: 1 }) };
          if (method === 'PUT' && /^\/api\/v1\/projects\/\d+\/tasks$/.test(path)) return { ok: true, status: 201, text: async () => JSON.stringify({ id: 7 }) };
          if (method === 'PUT' && /^\/api\/v1\/tasks\/\d+\/labels$/.test(path)) return { ok: true, status: 201, text: async () => '{}' };
          throw new Error(`unexpected fetch: ${method} ${path}`);
        };
        try {
          const res = await sendNotification(
            {
              title: 'x', body: 'y', level: 'info', channels: ['vikunja'],
            },
            { sessionId: 'sess-vikunja-only' },
          );
          assert.equal(res.ok, true);
          assert.equal(res.delivered.discord, false, "channels:['vikunja'] must skip Discord");
          assert.equal(res.delivered.webhooks, 0, "channels:['vikunja'] must skip subscribed webhooks too");
          assert.equal(res.delivered.failed, 0);
          assert.deepEqual(res.delivered.vikunja, { ok: true, action: 'created', taskId: 7 });
          assert.equal(webhookCalled, false);
        } finally {
          global.fetch = realFetch;
        }
      });
    },
  );
});
