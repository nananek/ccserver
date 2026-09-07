import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPtyHostSockPath, startPtyHost } from './index.js';

test('getPtyHostSockPath: CCSERVER_PTY_HOST_SOCK wins, else XDG_RUNTIME_DIR, else /run/user/<uid>', () => {
  const prevSock = process.env.CCSERVER_PTY_HOST_SOCK;
  const prevXdg = process.env.XDG_RUNTIME_DIR;
  try {
    process.env.CCSERVER_PTY_HOST_SOCK = '/tmp/explicit.sock';
    assert.equal(getPtyHostSockPath(), '/tmp/explicit.sock');

    delete process.env.CCSERVER_PTY_HOST_SOCK;
    process.env.XDG_RUNTIME_DIR = '/tmp/xdg-test-dir';
    assert.equal(getPtyHostSockPath(), '/tmp/xdg-test-dir/ccserver-pty-host.sock');
  } finally {
    if (prevSock === undefined) delete process.env.CCSERVER_PTY_HOST_SOCK; else process.env.CCSERVER_PTY_HOST_SOCK = prevSock;
    if (prevXdg === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = prevXdg;
  }
});

test('startPtyHost: listens on the given path, serves a real session, and stop() tears the listener down without touching live sessions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccserver-pty-host-index-test-'));
  const sockPath = join(dir, 'pty-host.sock');
  // No orphaned brokers exist yet -- point the registry at a private path so
  // this test can never race a real pty-host instance's own registry file.
  process.env.CCSERVER_PTY_HOST_GITBROKER_REGISTRY = join(dir, 'gitbroker-registry.json');
  try {
    const host = await startPtyHost({ sockPath });
    try {
      assert.ok(existsSync(sockPath), 'the socket file exists once listening');

      const { id } = host.ptyStore.spawn({
        cwd: process.env.HOME || '/tmp',
        cols: 80,
        rows: 24,
        command: process.env.SHELL || '/bin/bash',
        args: [],
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
      });
      assert.equal(host.ptyStore.size(), 1);

      await host.stop();
      // stop() closes the RPC listener, not the sessions it was serving --
      // plan5's passive-teardown guarantee applies to pty-host's own UDS
      // server shutdown too, not just an unexpected disconnect.
      assert.equal(host.ptyStore.size(), 1, 'stop() must not destroy live sessions');
      host.ptyStore.destroy(id);
    } finally {
      // best-effort: already stopped above in the success path
      await host.stop().catch(() => {});
    }
  } finally {
    delete process.env.CCSERVER_PTY_HOST_GITBROKER_REGISTRY;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('startPtyHost reaps a leftover orphaned git-broker registry entry on boot', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccserver-pty-host-index-reap-test-'));
  const sockPath = join(dir, 'pty-host.sock');
  const regPath = join(dir, 'gitbroker-registry.json');
  process.env.CCSERVER_PTY_HOST_GITBROKER_REGISTRY = regPath;
  try {
    // A pid essentially guaranteed not to be alive, standing in for a
    // previous pty-host generation's orphaned git-broker.
    writeFileSync(regPath, JSON.stringify({ 'stale-session': { pid: 999999, dir: join(dir, 'gone') } }));
    const host = await startPtyHost({ sockPath });
    try {
      assert.equal(existsSync(regPath), false, 'the stale registry was cleared during startup');
    } finally {
      await host.stop();
    }
  } finally {
    delete process.env.CCSERVER_PTY_HOST_GITBROKER_REGISTRY;
    rmSync(dir, { recursive: true, force: true });
  }
});
