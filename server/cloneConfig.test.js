// sandbox.config.json's "clone" block (#278): the host allow-list Clone is
// bounded by. Strict validation that FAILS CLOSED, and how it reaches
// loadSandboxConfig().

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CLONE_HOSTS, normalizeCloneConfig, normalizeCloneHost } from './cloneConfig.js';
import { loadSandboxConfig } from './ws/sandbox.js';

const chr = (n) => String.fromCharCode(n);
const entry = (host, tool = 'git') => ({ host, tool });

// A refusal is fail-closed: an error, and NO hosts -- never the default.
function assertRejected(raw, pattern) {
  const res = normalizeCloneConfig(raw);
  assert.notEqual(res.error, null, `must be rejected: ${JSON.stringify(raw)}`);
  assert.deepEqual([...res.hosts], [], 'an unusable block allows nothing (it must not fall back to the default)');
  if (pattern) assert.match(res.error, pattern);
}

test('no clone block: the default is github.com with gh, and only that', () => {
  for (const raw of [undefined, null]) {
    const res = normalizeCloneConfig(raw);
    assert.equal(res.error, null);
    assert.deepEqual([...res.hosts], [{ host: 'github.com', tool: 'gh' }]);
  }
  assert.deepEqual(normalizeCloneConfig({}).hosts, DEFAULT_CLONE_HOSTS, 'an empty block is still the default');
  assert.ok(Object.isFrozen(DEFAULT_CLONE_HOSTS) && Object.isFrozen(DEFAULT_CLONE_HOSTS[0]));
});

test('a listed block is the COMPLETE list: it does not add to the default, and may leave github.com out', () => {
  const res = normalizeCloneConfig({ hosts: [entry('Gitea.Example.ORG', 'git'), entry('ghe.example.com', 'gh')] });
  assert.equal(res.error, null);
  assert.deepEqual([...res.hosts], [
    { host: 'gitea.example.org', tool: 'git' },
    { host: 'ghe.example.com', tool: 'gh' },
  ], 'host names are case-folded; the order is kept');
  assert.ok(Object.isFrozen(res.hosts) && res.hosts.every(Object.isFrozen));
  assert.equal(normalizeCloneConfig({ hosts: [entry('github.com', 'git')] }).hosts[0].tool, 'git');
});

test('a block of the wrong shape is rejected', () => {
  for (const raw of ['github.com', 42, true, [], [entry('github.com', 'gh')]]) assertRejected(raw, /must be an object/);
  assertRejected({ host: 'github.com' }, /unknown key "host"/); // a typo for "hosts"
  assertRejected({ hosts: [entry('github.com', 'gh')], extra: 1 }, /unknown key "extra"/);
  for (const hosts of ['github.com', {}, null, 0, true]) assertRejected({ hosts }, /"hosts" must be an array/);
  assertRejected({ hosts: [] }, /at least one host/);
});

test('an entry of the wrong shape is rejected, whole block and all', () => {
  for (const bad of [null, 'github.com', 7, [], [entry('github.com')]]) {
    assertRejected({ hosts: [entry('github.com', 'gh'), bad] }, /"hosts"\[1\] must be an object/);
  }
  assertRejected({ hosts: [{ host: 'a.example.org', tool: 'git', port: 3000 }] }, /unknown key "port"/);
  assertRejected({ hosts: [{ host: 'a.example.org' }] }, /tool must be "gh" or "git"/);
  assertRejected({ hosts: [{ tool: 'git' }] }, /host must be a non-empty string/);
  for (const tool of ['GH', 'Git', 'curl', 'gh ', '', null, 1, ['git']]) {
    assertRejected({ hosts: [{ host: 'a.example.org', tool }] }, /tool must be "gh" or "git"/);
  }
  // one bad entry sinks the block: nothing is silently dropped, and the good entry does not survive
  const res = normalizeCloneConfig({ hosts: [entry('gitea.example.org', 'git'), entry('bad host', 'git')] });
  assert.notEqual(res.error, null);
  assert.deepEqual([...res.hosts], []);
  assert.match(res.error, /"hosts"\[1\]\.host/);
});

test('the same host twice is rejected however it is spelled', () => {
  assertRejected({ hosts: [entry('gitea.example.org', 'git'), entry('gitea.example.org', 'gh')] }, /listed twice/);
  assertRejected({ hosts: [entry('gitea.example.org', 'git'), entry('GITEA.example.org', 'git')] }, /listed twice/);
});

test('host names: bare, ASCII, dotted labels; nothing that could mean a different host', () => {
  for (const good of ['github.com', 'GitHub.COM', 'gitea', 'a.b.c.d.example.org', 'xn--gtea-9ua.example.org', '192.168.0.5', 'a-b.example.org', 'a'.repeat(63), `${'a'.repeat(63)}.example.org`]) {
    assert.equal(normalizeCloneHost(good).ok, true, good);
  }
  const bad = [
    '', ' ', ' github.com', 'github.com ', 'git hub.com', 'github.com\n',
    // a port, a scheme, a path, userinfo, a wildcard, an IPv6 literal, a trailing dot, empty labels
    'github.com:443', 'gitea.example.org:3000', 'https://github.com', 'github.com/', 'github.com/o', 'user@github.com',
    '*.example.org', '.example.org', 'example..org', 'gitea.example.org.', '.', '..', '[::1]', '::1', 'gitea_1.example.org',
    // labels that start or end with a hyphen, or are too long; the whole name too long
    '-a.example.org', 'a-.example.org', 'a'.repeat(64), `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.e`,
    // Unicode: look-alikes, an IDN written as Unicode, invisible characters
    `g${chr(0x131)}thub.com`, `gitea.exampl${chr(0x435)}.org`, `${chr(0xff47)}ithub.com`, `${chr(0x65e5)}${chr(0x672c)}.example`,
    `gitea${chr(0x3002)}example.org`, `github.com${chr(0x200b)}`, `${chr(0x212a)}itea.example.org`,
    // non-strings
    null, undefined, 42, {}, [], ['github.com'],
  ];
  for (const host of bad) assert.equal(normalizeCloneHost(host).ok, false, `must refuse ${JSON.stringify(host)}`);
  assert.match(normalizeCloneHost(`${chr(0x65e5)}.example`).reason, /punycode/);
  assertRejected({ hosts: [entry('gitea.example.org:3000', 'git')] }, /"hosts"\[0\]\.host/);
});

// --- through loadSandboxConfig ---------------------------------------------------------------

function withConfigFile(json, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ccserver-clonecfg-'));
  const path = join(dir, 'sandbox.config.json');
  const prev = process.env.CCSERVER_SANDBOX_CONFIG;
  try {
    if (json !== null) writeFileSync(path, typeof json === 'string' ? json : JSON.stringify(json));
    process.env.CCSERVER_SANDBOX_CONFIG = path;
    return fn();
  } finally {
    if (prev === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
    else process.env.CCSERVER_SANDBOX_CONFIG = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('loadSandboxConfig: no file, no key, a valid block, an invalid block', () => {
  withConfigFile(null, () => {
    const cfg = loadSandboxConfig();
    assert.deepEqual([...cfg.cloneHosts], [{ host: 'github.com', tool: 'gh' }]);
    assert.equal(cfg.cloneHostsError, null);
  });
  withConfigFile({ docker: false }, () => {
    assert.deepEqual([...loadSandboxConfig().cloneHosts], [{ host: 'github.com', tool: 'gh' }]);
  });
  withConfigFile({ clone: { hosts: [entry('github.com', 'gh'), entry('gitea.example.org', 'git')] } }, () => {
    const cfg = loadSandboxConfig();
    assert.deepEqual([...cfg.cloneHosts], [{ host: 'github.com', tool: 'gh' }, { host: 'gitea.example.org', tool: 'git' }]);
    assert.equal(cfg.cloneHostsError, null);
  });
  withConfigFile({ clone: { hosts: [entry('gitea.example.org:3000', 'git')] } }, () => {
    const cfg = loadSandboxConfig();
    assert.deepEqual([...cfg.cloneHosts], [], 'not the default');
    assert.match(cfg.cloneHostsError, /"clone" "hosts"\[0\]\.host/);
  });
  // an unparseable file cannot say what "clone" said; the block is then simply absent here, and
  // configError / browseRootsInvalid (which fail closed everywhere) are what stop the routes
  withConfigFile('{ not json', () => {
    const cfg = loadSandboxConfig();
    assert.notEqual(cfg.configError, null);
    assert.equal(cfg.browseRootsInvalid, true);
  });
});

test('sandbox.config.example.json documents exactly the default', () => {
  const example = JSON.parse(readFileSync(new URL('./sandbox.config.example.json', import.meta.url), 'utf-8'));
  assert.ok(example.clone, 'the example documents the clone block');
  assert.deepEqual(normalizeCloneConfig(example.clone), normalizeCloneConfig(undefined),
    'copying the example must not change which hosts Clone may use');
});
