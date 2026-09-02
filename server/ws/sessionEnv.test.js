// Unit tests for the session base environment (see sessionEnv.js): the
// server-only variables must be dropped, everything else must pass through
// untouched, and the caller's later spreads must still win.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSessionEnv, isServerOnlyEnvKey, SERVER_ONLY_ENV_KEYS, SERVER_ONLY_ENV_PREFIXES } from './sessionEnv.js';

const SERVER_ENV = Object.freeze({
  PATH: '/usr/bin:/bin',
  HOME: '/home/user',
  SHELL: '/bin/bash',
  LANG: 'ja_JP.UTF-8',
  NODE_ENV: 'production',
  PORT: '3456',
  CCSERVER_TOKEN: 'secret',
  CCSERVER_DB_PATH: '/var/lib/ccserver.sqlite3',
  CCSERVER_DEBUG: '1',
  SSH_AUTH_SOCK: '/run/user/1000/ssh-agent.sock',
  SSH_AGENT_PID: '4242',
  CCSANDBOX_DOCKER: '0',
  MY_CCSERVER_TOKEN: 'not-a-server-var',
  ccserver_lowercase: 'kept',
});

test('buildSessionEnv drops NODE_ENV and PORT', () => {
  const env = buildSessionEnv(SERVER_ENV);
  assert.equal('NODE_ENV' in env, false);
  assert.equal('PORT' in env, false);
});

test('buildSessionEnv drops every CCSERVER_-prefixed variable', () => {
  const env = buildSessionEnv(SERVER_ENV);
  for (const key of Object.keys(env)) {
    assert.equal(key.startsWith('CCSERVER_'), false, `${key} leaked`);
  }
  assert.equal('CCSERVER_TOKEN' in env, false);
  assert.equal('CCSERVER_DB_PATH' in env, false);
  assert.equal('CCSERVER_DEBUG' in env, false);
});

test('buildSessionEnv keeps dropping the forwarded ssh-agent variables', () => {
  const env = buildSessionEnv(SERVER_ENV);
  assert.equal('SSH_AUTH_SOCK' in env, false);
  assert.equal('SSH_AGENT_PID' in env, false);
});

test('buildSessionEnv passes unrelated variables through with their values', () => {
  const env = buildSessionEnv(SERVER_ENV);
  assert.deepEqual(env, {
    PATH: '/usr/bin:/bin',
    HOME: '/home/user',
    SHELL: '/bin/bash',
    LANG: 'ja_JP.UTF-8',
    CCSANDBOX_DOCKER: '0',
    MY_CCSERVER_TOKEN: 'not-a-server-var',
    ccserver_lowercase: 'kept',
  });
});

test('buildSessionEnv matches the prefix only at the start of the name, case-sensitively', () => {
  const env = buildSessionEnv({ MY_CCSERVER_TOKEN: 'a', ccserver_token: 'b', CCSERVER: 'c', CCSERVERX: 'd' });
  assert.deepEqual(env, { MY_CCSERVER_TOKEN: 'a', ccserver_token: 'b', CCSERVER: 'c', CCSERVERX: 'd' });
});

test('buildSessionEnv returns a new object and does not mutate its input', () => {
  const input = { NODE_ENV: 'production', PATH: '/bin' };
  const env = buildSessionEnv(input);
  assert.notEqual(env, input);
  assert.deepEqual(input, { NODE_ENV: 'production', PATH: '/bin' });
  env.PATH = '/changed';
  assert.equal(input.PATH, '/bin');
});

test('buildSessionEnv reads process.env by default', () => {
  const saved = { NODE_ENV: process.env.NODE_ENV, PORT: process.env.PORT, CCSERVER_TOKEN: process.env.CCSERVER_TOKEN, SESSION_ENV_TEST_MARKER: process.env.SESSION_ENV_TEST_MARKER };
  process.env.NODE_ENV = 'production';
  process.env.PORT = '3456';
  process.env.CCSERVER_TOKEN = 'secret';
  process.env.SESSION_ENV_TEST_MARKER = 'present';
  try {
    const env = buildSessionEnv();
    assert.equal('NODE_ENV' in env, false);
    assert.equal('PORT' in env, false);
    assert.equal('CCSERVER_TOKEN' in env, false);
    assert.equal(env.SESSION_ENV_TEST_MARKER, 'present');
    assert.equal(env.PATH, process.env.PATH);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('later spreads still override the base (per-session CCSERVER_* values survive)', () => {
  const base = buildSessionEnv(SERVER_ENV);
  const merged = { ...base, CCSERVER_NOTIFY_IDENTITY: '{"host":"x"}', TERM: 'xterm-256color' };
  assert.equal(merged.CCSERVER_NOTIFY_IDENTITY, '{"host":"x"}');
  assert.equal(merged.TERM, 'xterm-256color');
  assert.equal('CCSERVER_TOKEN' in merged, false);
});

test('isServerOnlyEnvKey agrees with the exported lists', () => {
  for (const key of SERVER_ONLY_ENV_KEYS) assert.equal(isServerOnlyEnvKey(key), true, key);
  for (const prefix of SERVER_ONLY_ENV_PREFIXES) assert.equal(isServerOnlyEnvKey(`${prefix}ANYTHING`), true, prefix);
  assert.equal(isServerOnlyEnvKey('PATH'), false);
  assert.equal(isServerOnlyEnvKey('HOME'), false);
  assert.equal(isServerOnlyEnvKey('NODE_OPTIONS'), false);
  assert.equal(isServerOnlyEnvKey('CCSANDBOX_MCP_SOCK'), false);
});
