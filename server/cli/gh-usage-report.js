#!/usr/bin/env node
// Local-only control surface for Issue #198's recording draft.  No command
// here uploads, opens a browser, or invokes gh.
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { defaultRecordingPath, formatGhUsageReport, resetGhUsage } from '../ghUsageRecording.js';

function configPath() { return process.env.CCSERVER_SANDBOX_CONFIG || join(dirname(new URL(import.meta.url).pathname), '..', 'sandbox.config.json'); }
function readConfig(path) {
  try { const value = JSON.parse(readFileSync(path, 'utf8')); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
  catch { return {}; }
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
const file = fileArg ? resolve(fileArg) : (typeof current.file === 'string' ? current.file : defaultRecordingPath(cfgPath));
if (command === 'show') process.stdout.write(formatGhUsageReport(file, { includePeriod: !noPeriod }));
else if (command === 'reset') {
  if (!resetGhUsage(file)) { console.error(`Failed to reset local aggregate: ${file}`); process.exit(1); }
  console.log(`Reset local aggregate: ${file}`);
} else {
  cfg.ghUsageRecording = { enabled: command === 'enable', file };
  writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  // mode above only applies when the file is created; tighten pre-existing
  // config files too (sandbox.config.json can carry secrets such as tokens).
  try { chmodSync(cfgPath, 0o600); } catch (e) { console.error(`warning: could not tighten permissions on ${cfgPath}: ${e.message}`); }
  console.log(`${command === 'enable' ? 'Enabled' : 'Disabled'} local gh usage recording. ${command === 'enable' ? 'Restart new sandbox sessions to apply it.' : ''}`);
}
