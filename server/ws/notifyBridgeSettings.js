// Read/write boundary for the agent notification bridge settings in
// sandbox.config.json (`notify.bridge`), backing the Settings GUI tab
// (plan: plan-notify-bridge, Step 2). Structurally the same shape as
// networkAllowlist.js -- that module is the precedent for "a feature's slice
// of sandbox.config.json, edited from the browser":
//
//   - the file is read fresh on every call (no cache, like loadSandboxConfig),
//     so a successful update governs the next launch with no reload,
//   - updates are a partial patch: only keys present in `patch` change, every
//     other key in the file (other features' settings, the `//` comment keys)
//     is preserved untouched,
//   - a file that is not valid JSON is refused rather than overwritten,
//   - normalizeBridgeSettings is shared with loadSandboxConfig() (sandbox.js)
//     so the GUI cannot show something the launcher resolves differently.
//
// Reads are lenient (a junk value falls back to its default, so a hand-edited
// file never bricks the feature); writes are strict (a junk value is a 400, so
// the GUI cannot silently drop what the operator typed). Same split
// normalizeNetworkSettings/updateNetworkSettings already use.
//
// SECURITY NOTE -- why several of these knobs exist at all: this feature
// forwards bytes an agent inside the sandbox chose to emit out to external
// services (Discord, subscribed webhooks, Web Push). The agent fully controls
// the OSC 777 payload, so the bridge must treat it as untrusted input:
//   - minIntervalMs / dedupeWindowMs / maxPerHour bound how much an agent can
//     push through the relay (no flooding the operator's Discord),
//   - `channels` bounds where it can reach at all,
//   - `enabled` defaults to OFF, so nothing is relayed until an operator opts
//     in on purpose.
// Sanitizing the text itself (control characters, length) happens earlier, in
// agentNotifyDetect.js, and attribution is attached later, in notifyBridge.js
// (Step 3) -- neither is configurable, on purpose.

import { readFileSync, writeFileSync } from 'node:fs';
import { APPS } from './appLaunch.js';
import { resolveSandboxConfigPath } from './networkAllowlist.js';

// Which agent CLIs the detector is fed for. Not every app can be made to emit
// a notification: claude needs `preferredNotifChannel` injected and opencode
// emits OSC 777 on its own (both verified against the shipped binaries), while
// copilot/commandcode have no CLI-arg/env config injection at all and codex
// could not be verified on the development host. The ones that cannot be
// driven are still *selectable* -- capture costs nothing and picks them up
// automatically if they turn out to emit something -- they are just not on by
// default.
export const BRIDGE_APPS = Object.freeze([...APPS]);

// 'webpush' is accepted from the start even though the transport lands in
// Step 4: the settings file is what an operator edits, and a key that appears
// later would mean a second migration of their config.
export const BRIDGE_CHANNELS = Object.freeze(['discord', 'webpush']);

export const BRIDGE_LEVELS = Object.freeze(['info', 'success', 'warning', 'error']);

// Bounds, not preferences: a 0 interval means "relay every frame" and a huge
// one means "silently drop everything", both of which look like a broken
// feature rather than a setting. Exported for the route's error messages and
// for the GUI's input constraints.
export const BRIDGE_LIMITS = Object.freeze({
  minIntervalMs: { min: 0, max: 600_000 },
  dedupeWindowMs: { min: 0, max: 3_600_000 },
  maxPerHour: { min: 1, max: 1000 },
});

export const BRIDGE_DEFAULTS = Object.freeze({
  // Off until an operator opts in. While false the capture is not wired up and
  // -- critically -- no CLI gets a notification flag injected, so an agent's
  // launch command line is byte-for-byte what it is today.
  enabled: false,
  // codex is deliberately absent: its notification config could not be
  // verified (no codex binary on the development host), so it is opt-in rather
  // than a default that might inject an unknown `-c` override.
  apps: Object.freeze(['claude', 'opencode']),
  injectConfig: true,
  channels: Object.freeze(['discord', 'webpush']),
  // A bare BEL is emitted by shell completion, by `printf '\a'` and by
  // claude's iterm2_with_bell channel -- far too weak a signal to relay by
  // default.
  captureBell: false,
  minIntervalMs: 3000,
  dedupeWindowMs: 10_000,
  maxPerHour: 60,
  // 'info' rather than 'warning': the bridge relays whatever the agent
  // happened to emit, which is not by itself a claim that a human is blocked.
  level: 'info',
});

function normalizeStringList(value, allowed, fallback) {
  if (!Array.isArray(value)) return [...fallback];
  const out = [];
  for (const entry of value) {
    if (typeof entry === 'string' && allowed.includes(entry) && !out.includes(entry)) out.push(entry);
  }
  return out;
}

function normalizeBool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

// Number(null) is 0 and Number(true) is 1, so a bare Number() coercion would
// quietly read `"minIntervalMs": null` as "relay every frame". Only a real
// integer -- or the decimal string an <input type="number"> round-trips --
// counts; everything else is "not a number here".
function toInt(value) {
  if (typeof value === 'number') return Number.isInteger(value) ? value : null;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

function normalizeInt(value, { min, max }, fallback) {
  const n = toInt(value);
  if (n === null || n < min || n > max) return fallback;
  return n;
}

// The effective settings exactly as the launcher and the bridge resolve them.
// Lenient by design: an absent key, a wrong type, an unknown app id or an
// out-of-range number all fall back to the default rather than failing.
// An empty `apps`/`channels` array is meaningful (capture nothing / deliver
// nowhere) and is NOT replaced by the default -- only a non-array is.
export function normalizeBridgeSettings(raw) {
  const b = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  return {
    enabled: normalizeBool(b.enabled, BRIDGE_DEFAULTS.enabled),
    apps: normalizeStringList(b.apps, BRIDGE_APPS, BRIDGE_DEFAULTS.apps),
    injectConfig: normalizeBool(b.injectConfig, BRIDGE_DEFAULTS.injectConfig),
    channels: normalizeStringList(b.channels, BRIDGE_CHANNELS, BRIDGE_DEFAULTS.channels),
    captureBell: normalizeBool(b.captureBell, BRIDGE_DEFAULTS.captureBell),
    minIntervalMs: normalizeInt(b.minIntervalMs, BRIDGE_LIMITS.minIntervalMs, BRIDGE_DEFAULTS.minIntervalMs),
    dedupeWindowMs: normalizeInt(b.dedupeWindowMs, BRIDGE_LIMITS.dedupeWindowMs, BRIDGE_DEFAULTS.dedupeWindowMs),
    maxPerHour: normalizeInt(b.maxPerHour, BRIDGE_LIMITS.maxPerHour, BRIDGE_DEFAULTS.maxPerHour),
    level: BRIDGE_LEVELS.includes(b.level) ? b.level : BRIDGE_DEFAULTS.level,
  };
}

function readRawConfig() {
  try {
    return { raw: JSON.parse(readFileSync(resolveSandboxConfigPath(), 'utf-8')), corrupt: false };
  } catch (err) {
    if (err?.code === 'ENOENT') return { raw: {}, corrupt: false };
    return { raw: null, corrupt: true };
  }
}

export function getBridgeSettings() {
  const { raw } = readRawConfig();
  const notify = (raw && typeof raw === 'object' && raw.notify && typeof raw.notify === 'object')
    ? raw.notify
    : undefined;
  return normalizeBridgeSettings(notify?.bridge);
}

// Strict validators for the write path: unlike the read path above, a bad
// value is reported rather than silently replaced, so the GUI can say what was
// wrong instead of appearing to accept an edit it then discards.
function validateList(value, allowed, name) {
  if (!Array.isArray(value)) return `${name} must be an array`;
  const bad = value.filter((v) => typeof v !== 'string' || !allowed.includes(v));
  if (bad.length > 0) return `${name} contains unknown ${name === 'apps' ? 'app id' : 'channel'}(s): ${bad.map(String).join(', ')} (allowed: ${allowed.join(', ')})`;
  return null;
}

function validateInt(value, limits, name) {
  const n = toInt(value);
  if (n === null) return `${name} must be an integer`;
  if (n < limits.min || n > limits.max) return `${name} must be between ${limits.min} and ${limits.max}`;
  return null;
}

// Partial update. Returns { ok: true, settings } or
// { ok: false, code: 'validation' | 'internal', message }.
export function updateBridgeSettings(patch = {}) {
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
  const notify = (next.notify && typeof next.notify === 'object' && !Array.isArray(next.notify))
    ? { ...next.notify }
    : {};
  const bridge = (notify.bridge && typeof notify.bridge === 'object' && !Array.isArray(notify.bridge))
    ? { ...notify.bridge }
    : {};

  for (const key of ['enabled', 'injectConfig', 'captureBell']) {
    if (patch[key] === undefined) continue;
    if (typeof patch[key] !== 'boolean') {
      return { ok: false, code: 'validation', message: `${key} must be a boolean` };
    }
    bridge[key] = patch[key];
  }

  for (const [key, allowed] of [['apps', BRIDGE_APPS], ['channels', BRIDGE_CHANNELS]]) {
    if (patch[key] === undefined) continue;
    const err = validateList(patch[key], allowed, key);
    if (err) return { ok: false, code: 'validation', message: err };
    bridge[key] = [...new Set(patch[key])];
  }

  for (const key of ['minIntervalMs', 'dedupeWindowMs', 'maxPerHour']) {
    if (patch[key] === undefined) continue;
    const err = validateInt(patch[key], BRIDGE_LIMITS[key], key);
    if (err) return { ok: false, code: 'validation', message: err };
    bridge[key] = toInt(patch[key]);
  }

  if (patch.level !== undefined) {
    if (!BRIDGE_LEVELS.includes(patch.level)) {
      return { ok: false, code: 'validation', message: `level must be one of: ${BRIDGE_LEVELS.join(', ')}` };
    }
    bridge.level = patch.level;
  }

  notify.bridge = bridge;
  next.notify = notify;

  try {
    writeFileSync(resolveSandboxConfigPath(), `${JSON.stringify(next, null, 2)}\n`);
  } catch (err) {
    return {
      ok: false,
      code: 'internal',
      message: `could not write the sandbox config (${resolveSandboxConfigPath()}): ${err.message}`,
    };
  }
  return { ok: true, settings: normalizeBridgeSettings(bridge) };
}
