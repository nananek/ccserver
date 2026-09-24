// Host-path canary (issue #201). Run around the test suite in CI:
//
//   node server/tools/path-canary.js place
//   npm test
//   node server/tools/path-canary.js verify      # always, even if tests failed
//   node server/tools/path-canary.js clean
//
// WHY THIS EXISTS
//
// Six separate test files on this branch resolved a REAL host path and wrote
// to it: the wizard spawned with the real $HOME, getDb() migrating a real
// database, db migration v2 renaming a real .index.json, persistSchedules()
// deleting a real .scheduled-prompts.json, the Playwright webServer migrating
// a live sandbox.config.json. Each was found by hand -- place decoys where the
// real files live, run the suite, look at what came back changed -- and each
// time the answer was "fixed, and it was fine this time". `npm test` mostly
// gets run inside a sandbox where the damage lands on a throwaway copy, so
// nothing complains.
//
// This turns that manual check into a failing build. It asserts three things
// about every location server/paths.js can name on this host:
//
//   1. a decoy placed where nothing existed is still there, byte for byte
//      -- catches DELETION, which a plain before/after snapshot cannot see
//      when the suite creates and removes a file (exactly how
//      persistSchedules()'s unlinkSync hid);
//   2. a file that already existed is unchanged -- catches the wizard moving
//      a developer's live server/sandbox.config.json;
//   3. nothing NEW appeared -- catches a test seeding real host state.
//
// Both spellings of every entry are covered: the pre-migration legacy paths
// (the dangerous ones today) and the post-migration XDG targets.
//
// SAFETY: this never overwrites. A path that already has something gets
// recorded, not replaced, so running it cannot destroy what it exists to
// protect. It still CREATES files where nothing is, so outside CI it asks for
// --force, and `clean` removes only what it made.

import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { allPaths } from '../paths.js';

const MANIFEST = process.env.CCSERVER_CANARY_MANIFEST || join(tmpdir(), 'ccserver-path-canary.json');
const DECOY_NAME = '.ccserver-path-canary';

// Valid JSON when the path it is standing in for is a .json file. Several of
// these locations are read by JSON.parse, and loadSandboxConfig() treats an
// unparseable sandbox.config.json as a fatal boot error -- a canary must not
// be the thing that breaks the run it is observing.
function decoyBody(label, path) {
  const note = `ccserver path canary: ${label}. If a test moved or deleted this, that test resolves a real host path.`;
  return path.endsWith('.json') ? `${JSON.stringify({ '//': note }, null, 2)}\n` : `${note}\n`;
}

// Every host-side location the registry can name, both layouts. Resolved with
// CCSERVER_* cleared so this reports the DEFAULTS -- the paths a test that
// forgot its overrides would be handed.
function hostPaths() {
  const saved = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('CCSERVER_')) { saved[key] = process.env[key]; delete process.env[key]; }
  }
  try {
    const out = [];
    for (const entry of allPaths()) {
      for (const path of [...entry.legacyPaths, entry.target]) {
        out.push({ id: entry.id, type: entry.type, path });
      }
    }
    // The same path can appear twice (two entries, or legacy === target on a
    // host with an exotic $XDG); keep one record each.
    return [...new Map(out.map((e) => [e.path, e])).values()];
  } finally {
    for (const [k, v] of Object.entries(saved)) process.env[k] = v;
  }
}

function sha(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// A directory is summarized by its recursive file list rather than a hash: the
// point is "did anything in here move", and hashing a multi-gigabyte sandbox
// HOME would be absurd.
function listTree(path, depth = 0) {
  if (depth > 3) return ['...'];
  let names;
  try { names = readdirSync(path).sort(); } catch { return []; }
  const out = [];
  for (const name of names) {
    const child = join(path, name);
    let st;
    try { st = lstatSync(child); } catch { continue; }
    out.push(st.isDirectory() ? `${name}/` : name);
    if (st.isDirectory()) for (const sub of listTree(child, depth + 1)) out.push(`${name}/${sub}`);
  }
  return out;
}

function describe(path, type) {
  if (!existsSync(path)) return { state: 'absent' };
  const st = lstatSync(path);
  if (st.isDirectory()) return { state: 'dir', entries: listTree(path) };
  if (!st.isFile()) return { state: 'special' };
  return { state: 'file', sha: sha(path), size: st.size };
}

function place({ force }) {
  if (!process.env.CI && !force) {
    console.error('path-canary: this creates files at real host paths. Pass --force if that is what you want.');
    console.error('  (it never overwrites anything that already exists, and `clean` removes what it made)');
    process.exit(2);
  }
  const records = [];
  for (const { id, type, path } of hostPaths()) {
    const before = describe(path, type);
    let created = null;
    if (before.state === 'absent') {
      // Seed a decoy so DELETION is detectable. For a directory entry the
      // decoy is a file inside it, since the suite is what would create the
      // directory itself.
      const decoy = type === 'dir' ? join(path, DECOY_NAME) : path;
      try {
        mkdirSync(dirname(decoy), { recursive: true });
        writeFileSync(decoy, decoyBody(`${id} @ ${path}`, decoy), { flag: 'wx' });
        created = decoy;
      } catch (err) {
        console.error(`path-canary: could not seed ${decoy}: ${err.message}`);
      }
    }
    records.push({ id, type, path, before, created, after: created ? describe(created, 'file') : null });
  }
  writeFileSync(MANIFEST, JSON.stringify({ at: Date.now(), records }, null, 2));
  const seeded = records.filter((r) => r.created).length;
  console.log(`path-canary: recorded ${records.length} host paths, seeded ${seeded} decoys -> ${MANIFEST}`);
}

function verify() {
  if (!existsSync(MANIFEST)) {
    console.error(`path-canary: no manifest at ${MANIFEST} -- run \`place\` before the suite.`);
    process.exit(2);
  }
  const { records } = JSON.parse(readFileSync(MANIFEST, 'utf-8'));
  const violations = [];
  for (const r of records) {
    if (r.created) {
      // 1. the decoy must still be exactly as written.
      const now = describe(r.created, 'file');
      if (now.state !== 'file') violations.push(`${r.id}: decoy ${r.created} is now ${now.state} -- a test deleted or replaced it`);
      else if (now.sha !== r.after.sha) violations.push(`${r.id}: decoy ${r.created} was rewritten`);
      continue;
    }
    const now = describe(r.path, r.type);
    // 2. something that was already there must be untouched.
    if (r.before.state === 'file' && (now.state !== 'file' || now.sha !== r.before.sha)) {
      violations.push(`${r.id}: pre-existing file ${r.path} changed (${r.before.state} -> ${now.state})`);
    } else if (r.before.state === 'dir' && now.state === 'dir') {
      const gone = r.before.entries.filter((e) => !now.entries.includes(e));
      const added = now.entries.filter((e) => !r.before.entries.includes(e));
      if (gone.length) violations.push(`${r.id}: ${r.path} lost ${gone.length} entries: ${gone.slice(0, 5).join(', ')}`);
      // 3. new host state is a violation too, not just destruction.
      if (added.length) violations.push(`${r.id}: ${r.path} gained ${added.length} entries: ${added.slice(0, 5).join(', ')}`);
    } else if (r.before.state === 'dir' && now.state !== 'dir') {
      violations.push(`${r.id}: directory ${r.path} is now ${now.state}`);
    }
  }
  if (violations.length > 0) {
    console.error('path-canary: FAILED -- the test suite touched real host paths:\n');
    for (const v of violations) console.error(`  - ${v}`);
    console.error('\nA test resolved a default registry path instead of a scratch one. See');
    console.error('server/testEnvDefaults.js and server/testIsolation.js.');
    process.exit(1);
  }
  console.log(`path-canary: OK -- ${records.length} host paths untouched by the suite.`);
}

function clean() {
  if (!existsSync(MANIFEST)) return;
  const { records } = JSON.parse(readFileSync(MANIFEST, 'utf-8'));
  for (const r of records) {
    if (!r.created) continue;
    try { rmSync(r.created, { force: true }); } catch { /* best effort */ }
  }
  rmSync(MANIFEST, { force: true });
  console.log('path-canary: removed the decoys it created.');
}

const args = process.argv.slice(2);
const force = args.includes('--force');
const cmd = args.find((a) => !a.startsWith('--'));
if (cmd === 'place') place({ force });
else if (cmd === 'verify') verify();
else if (cmd === 'clean') clean();
else {
  console.error('usage: node server/tools/path-canary.js place|verify|clean [--force]');
  process.exit(2);
}
