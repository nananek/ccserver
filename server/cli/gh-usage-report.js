#!/usr/bin/env node
// Local-only control surface for Issue #198's recording draft.  No command
// here uploads, opens a browser, or invokes gh.
import { chmodSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defaultRecordingPath, formatGhUsageReport, resetGhUsage } from '../ghUsageRecording.js';

// import.meta.dirname, not new URL(import.meta.url).pathname: the latter is
// percent-encoded, so an install path containing a space or '#' resolved to a
// config path that does not exist.
function configPath() { return process.env.CCSERVER_SANDBOX_CONFIG || join(import.meta.dirname, '..', 'sandbox.config.json'); }
// Exits without the usage banner: a broken config is an operator problem, not
// a command-line mistake.
function die(message) { console.error(message); process.exit(1); }
// A missing config is legitimate (every setting has a default). An unreadable
// or unparseable one is NOT: enable/disable write this object straight back,
// so degrading to {} silently replaced the operator's entire
// sandbox.config.json -- browseRoots, forceSandbox, network, binds -- with
// nothing but ghUsageRecording. index.js already refuses to boot on such a
// file; refuse to rewrite it here for the same reason.
function readConfig(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') return {};
    return die(`Cannot read ${path}: ${e.message}. Fix the file, then retry.`);
  }
  let value;
  try { value = JSON.parse(text); }
  catch (e) { return die(`Cannot parse ${path}: ${e.message}. Fix the file, then retry (refusing to overwrite it with defaults).`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return die(`${path} is not a JSON object; refusing to overwrite it.`);
  return value;
}
// Write via a temp file + rename, like ghUsageRecording's writeState: a
// partial plain overwrite would truncate sandbox.config.json and index.js
// would then refuse to boot. 'wx' (O_CREAT|O_EXCL) also means a symlink
// planted at the tmp name cannot redirect the write; realpathSync keeps a
// deliberately symlinked config pointing where the operator put it.
function writeConfig(path, cfg) {
  let target = path;
  try { target = realpathSync(path); } catch { /* new file: write at `path` */ }
  const tmp = `${target}.${process.pid}.tmp`;
  try { unlinkSync(tmp); } catch { /* usually absent */ }
  try {
    writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(tmp, target);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* best effort */ }
    return die(`Failed to update ${target}: ${e.message}`);
  }
  return target;
}
// Exits immediately: a usage error must never fall through and mutate the
// config (an earlier draft set exitCode and kept going, so `enable --bogus`
// silently enabled recording with the default path).
function fail(message) {
  if (message) console.error(message);
  console.error('Usage: gh-usage-report.js <enable|disable|show|reset> [--file PATH] [--no-period]');
  process.exit(2);
}

const argv = process.argv.slice(2);
let command = null;
let fileArg = null;
let noPeriod = false;
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--file') {
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) fail('--file requires a path');
    if (fileArg !== null) fail('--file may only be given once');
    fileArg = value;
    i++;
  } else if (arg === '--no-period') {
    noPeriod = true;
  } else if (arg.startsWith('-')) {
    fail(`unknown option: ${arg}`);
  } else if (command === null) {
    command = arg;
  } else {
    fail(`unexpected argument: ${arg}`);
  }
}
if (!command) fail('missing command');
if (!['enable', 'disable', 'show', 'reset'].includes(command)) fail(`unknown command: ${command}`);
if (noPeriod && command !== 'show') fail('--no-period is only valid with show');

const cfgPath = configPath();
const cfg = readConfig(cfgPath);
const current = cfg.ghUsageRecording && typeof cfg.ghUsageRecording === 'object' ? cfg.ghUsageRecording : {};
// Always absolute: loadSandboxConfig rejects a relative `file` as unset, so
// writing one back here would report "Enabled" for a config the server then
// silently ignores (a hand-edited relative path, or a relative
// CCSERVER_SANDBOX_CONFIG feeding defaultRecordingPath).
const file = resolve(fileArg || (typeof current.file === 'string' && current.file ? current.file : defaultRecordingPath(cfgPath)));
if (command === 'show') process.stdout.write(formatGhUsageReport(file, { includePeriod: !noPeriod }));
else if (command === 'reset') {
  if (!resetGhUsage(file)) { console.error(`Failed to reset local aggregate: ${file}`); process.exit(1); }
  console.log(`Reset local aggregate: ${file}`);
} else {
  cfg.ghUsageRecording = { enabled: command === 'enable', file };
  const written = writeConfig(cfgPath, cfg);
  // writeConfig always creates a fresh 0600 file, but the open(2) mode is
  // masked by umask -- chmod pins it exactly (sandbox.config.json can carry
  // secrets such as tokens).
  try { chmodSync(written, 0o600); } catch (e) { console.error(`warning: could not tighten permissions on ${written}: ${e.message}`); }
  console.log(`${command === 'enable' ? 'Enabled' : 'Disabled'} local gh usage recording. ${command === 'enable' ? 'Restart new sandbox sessions to apply it.' : ''}`);
}
