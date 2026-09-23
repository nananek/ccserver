#!/usr/bin/env node
// Local-only control surface for Issue #198's recording draft.  No command
// here uploads, opens a browser, or invokes gh.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { defaultRecordingPath, formatGhUsageReport, resetGhUsage } from '../ghUsageRecording.js';

function configPath() { return process.env.CCSERVER_SANDBOX_CONFIG || join(dirname(new URL(import.meta.url).pathname), '..', 'sandbox.config.json'); }
function readConfig(path) {
  try { const value = JSON.parse(readFileSync(path, 'utf8')); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
  catch { return {}; }
}
function usage() { console.error('Usage: gh-usage-report.js <enable|disable|show|reset> [--file PATH] [--no-period]'); process.exitCode = 2; }
const [command, ...args] = process.argv.slice(2);
const fileAt = args.indexOf('--file');
if (fileAt !== -1 && (!args[fileAt + 1] || fileAt + 2 !== args.length && args.slice(fileAt + 2).some((x) => !x.startsWith('--')))) usage();
const rawFile = fileAt === -1 ? null : args[fileAt + 1];
const unsupported = args.filter((arg, i) => arg.startsWith('--') && arg !== '--file' && arg !== '--no-period' && i !== fileAt + 1);
if (!command || unsupported.length || (command !== 'show' && args.includes('--no-period'))) usage();
const cfgPath = configPath();
const cfg = readConfig(cfgPath);
const current = cfg.ghUsageRecording && typeof cfg.ghUsageRecording === 'object' ? cfg.ghUsageRecording : {};
const file = rawFile ? resolve(rawFile) : (typeof current.file === 'string' ? current.file : defaultRecordingPath(cfgPath));
if (!['enable', 'disable', 'show', 'reset'].includes(command)) usage();
if (command === 'show') process.stdout.write(formatGhUsageReport(file, { includePeriod: !args.includes('--no-period') }));
else if (command === 'reset') { resetGhUsage(file); console.log(`Reset local aggregate: ${file}`); }
else {
  cfg.ghUsageRecording = { enabled: command === 'enable', file };
  writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  console.log(`${command === 'enable' ? 'Enabled' : 'Disabled'} local gh usage recording. ${command === 'enable' ? 'Restart new sandbox sessions to apply it.' : ''}`);
}
