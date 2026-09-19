// Read/write boundary for the network-isolation settings in
// sandbox.config.json (`network.isolate` / `network.initialState` /
// `network.mode` / `network.allowedHosts` / `network.deniedHosts`), backing
// the Settings GUI tab and its auto-apply to running sessions. Parsing is
// network-broker.js's normalizeNetworkSettings, shared with
// loadSandboxConfig()'s network parsing in sandbox.js, so the GUI cannot show
// something the launcher resolves differently.
//
// The file is read fresh on every call (same as loadSandboxConfig -- no
// cache), so a successful update governs the next launch with no reload.
// `//` comment keys survive read-modify-write untouched (they are plain JSON
// string keys); only formatting normalizes to 2-space + trailing newline.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeAllowedHosts, MAX_ALLOWED_HOSTS, normalizeNetworkSettings } from './network-broker.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function resolveSandboxConfigPath() {
  return process.env.CCSERVER_SANDBOX_CONFIG
    || join(__dirname, '..', 'sandbox.config.json');
}

function readRawConfig() {
  try {
    return { raw: JSON.parse(readFileSync(resolveSandboxConfigPath(), 'utf-8')), corrupt: false };
  } catch (err) {
    if (err?.code === 'ENOENT') return { raw: {}, corrupt: false };
    return { raw: null, corrupt: true };
  }
}

// Effective network settings exactly as loadSandboxConfig() resolves them
// (feature off unless isolate is on; starting live state enforce unless
// initialState is 'open'; operator-only enforce/audit mode; string-only
// lists). deniedHosts uses the same syntax as allowedHosts but always wins:
// a denied host is blocked even in live open state and in audit mode. Parse
// is shared with loadSandboxConfig() (sandbox.js) via
// normalizeNetworkSettings so the two structurally cannot drift apart.
export function getNetworkSettings() {
  const { raw } = readRawConfig();
  return normalizeNetworkSettings(raw && typeof raw === 'object' ? raw.network : undefined);
}

// Partial update: only keys present in `patch` change; everything else in the
// file (all other features' keys included) is preserved byte-for-byte in
// value. Returns { ok:true, settings } or { ok:false, code, message } with
// codes 'validation' | 'internal'.
export function updateNetworkSettings(patch = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, code: 'validation', message: 'patch must be an object' };
  }
  const { raw, corrupt } = readRawConfig();
  if (corrupt) {
    return {
      ok: false,
      code: 'internal',
      message: `sandbox config is not valid JSON, refusing to overwrite it (${resolveSandboxConfigPath()}); fix it by hand first`,
    };
  }
  const next = { ...raw };
  const net = (next.network && typeof next.network === 'object' && !Array.isArray(next.network))
    ? { ...next.network }
    : {};
  if (patch.isolate !== undefined) {
    if (typeof patch.isolate !== 'boolean') {
      return { ok: false, code: 'validation', message: 'isolate must be a boolean' };
    }
    net.isolate = patch.isolate;
  }
  if (patch.initialState !== undefined) {
    if (patch.initialState !== 'enforce' && patch.initialState !== 'open') {
      return { ok: false, code: 'validation', message: 'initialState must be "enforce" or "open"' };
    }
    net.initialState = patch.initialState;
  }
  if (patch.mode !== undefined) {
    if (patch.mode !== 'enforce' && patch.mode !== 'audit') {
      return { ok: false, code: 'validation', message: 'mode must be "enforce" or "audit"' };
    }
    net.mode = patch.mode;
  }
  if (patch.allowedHosts !== undefined) {
    if (!Array.isArray(patch.allowedHosts)) {
      return { ok: false, code: 'validation', message: 'allowedHosts must be an array of hostnames' };
    }
    const { hosts, rejected } = normalizeAllowedHosts(patch.allowedHosts);
    if (rejected.length > 0) {
      return {
        ok: false,
        code: 'validation',
        message: `invalid allow-list entries: ${rejected.slice(0, 5).map((r) => JSON.stringify(r)).join(', ')}${rejected.length > 5 ? ` (+${rejected.length - 5} more)` : ''} (exact hostname or leading-dot suffix, no scheme/port/wildcard)`,
      };
    }
    if (hosts.length > MAX_ALLOWED_HOSTS) {
      return { ok: false, code: 'validation', message: `allowedHosts exceeds ${MAX_ALLOWED_HOSTS} entries` };
    }
    net.allowedHosts = hosts;
  }
  if (patch.deniedHosts !== undefined) {
    if (!Array.isArray(patch.deniedHosts)) {
      return { ok: false, code: 'validation', message: 'deniedHosts must be an array of hostnames' };
    }
    const { hosts, rejected } = normalizeAllowedHosts(patch.deniedHosts);
    if (rejected.length > 0) {
      return {
        ok: false,
        code: 'validation',
        message: `invalid deny-list entries: ${rejected.slice(0, 5).map((r) => JSON.stringify(r)).join(', ')}${rejected.length > 5 ? ` (+${rejected.length - 5} more)` : ''} (exact hostname or leading-dot suffix, no scheme/port/wildcard)`,
      };
    }
    if (hosts.length > MAX_ALLOWED_HOSTS) {
      return { ok: false, code: 'validation', message: `deniedHosts exceeds ${MAX_ALLOWED_HOSTS} entries` };
    }
    net.deniedHosts = hosts;
  }
  next.network = net;
  try {
    writeFileSync(resolveSandboxConfigPath(), `${JSON.stringify(next, null, 2)}\n`);
  } catch (err) {
    return { ok: false, code: 'internal', message: `failed to write sandbox config: ${err.message}` };
  }
  return { ok: true, settings: getNetworkSettings() };
}
