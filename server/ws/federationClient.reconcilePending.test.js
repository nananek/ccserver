// M7 (vuln_scan report): reconcilePending() used to await each pending
// row's getReadyLink()/pairing.status round trip one at a time in a
// for...of loop. Since getReadyLink can take up to its own ~5s ready-
// timeout for an unreachable/still-connecting peer, a handful of dead rows
// among up to MAX_PENDING_ROWS pending ones could stack into ~seconds-to-
// ~100s of SERIAL waiting behind a single REST poll (routes/federation.js) --
// from the browser's perspective, the pending-approvals UI just hangs.
// This proves the fix (Promise.all over the rows) actually bounds total
// wall time to the SLOWEST single row, not the sum of all of them, using
// the same black-hole test address (10.255.255.1:9 -- TCP connects to it
// never respond) every other federation test file in this repo already
// relies on for a deterministic "unreachable" case.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, getDb } from '../db.js';
import * as pairing from './federationPairing.js';
import { opensslAvailable, _resetIdentityCacheForTests, ensureIdentity } from './federationIdentity.js';
import { _resetLinksForTests } from './federationLink.js';
import { reconcilePending } from './federationClient.js';

const skip = !opensslAvailable();
const BLACKHOLE_ADDR = '10.255.255.1:9';
let tmpRoot;
const savedHome = process.env.CCSERVER_FEDERATION_HOME;

before(async () => {
  if (skip) return;
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-reconcile-pending-'));
  process.env.CCSERVER_DB_PATH = join(tmpRoot, 'test.sqlite3');
  process.env.CCSERVER_SANDBOX_HOME_ROOT = join(tmpRoot, 'home');
  process.env.CCSERVER_FEDERATION_HOME = join(tmpRoot, 'self-federation');
  _resetIdentityCacheForTests();
  await ensureIdentity();
});

after(() => {
  if (skip) return;
  _resetLinksForTests();
  _resetIdentityCacheForTests();
  closeDb();
  delete process.env.CCSERVER_DB_PATH;
  delete process.env.CCSERVER_SANDBOX_HOME_ROOT;
  if (savedHome === undefined) delete process.env.CCSERVER_FEDERATION_HOME; else process.env.CCSERVER_FEDERATION_HOME = savedHome;
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  if (skip) return;
  getDb().prepare('DELETE FROM paired_instances').run();
  _resetLinksForTests();
});

test('M7: reconcilePending() checks unreachable pending rows concurrently, not one at a time', { skip }, async () => {
  const ROW_COUNT = 3;
  const rows = [];
  for (let i = 0; i < ROW_COUNT; i++) {
    rows.push(pairing.recordInboundRequest({
      fingerprint: `fake-fingerprint-${i}`,
      certPem: 'n/a',
      hostnameClaimed: `unreachable-${i}`,
      addr: BLACKHOLE_ADDR,
    }));
  }
  assert.equal(pairing.listPending().length, ROW_COUNT);

  const start = Date.now();
  const outcomes = await reconcilePending();
  const elapsedMs = Date.now() - start;

  // Serial execution of 3 rows against a ~5s per-row ready-timeout would
  // take ~15s; concurrent execution takes roughly one row's worth of time.
  // A generous 9s bound comfortably separates the two without being flaky
  // on a loaded CI box, while still failing hard against the old serial
  // behavior.
  assert.ok(
    elapsedMs < 9000,
    `reconcilePending() over ${ROW_COUNT} unreachable rows must run them concurrently (took ${elapsedMs}ms, `
    + 'serial execution would take ~5s per row)',
  );
  assert.equal(outcomes.length, ROW_COUNT);
  for (const o of outcomes) assert.equal(o.reachable, false);
  assert.deepEqual(outcomes.map((o) => o.id).sort(), rows.map((r) => r.id).sort());
});
