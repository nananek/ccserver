// REST boundary for the agent notification bridge settings in
// sandbox.config.json (`notify.bridge`), backing the Settings GUI tab
// (plan: plan-notify-bridge, Step 2). Registered under /api (server/index.js),
// so the optional token / passkey auth hook applies automatically.
//
// GET returns the effective settings plus the choices the GUI needs to render
// them (which app ids and channels exist, the numeric bounds) and which
// delivery channels are actually configured on this host -- a `channels`
// entry the operator ticked is inert until the underlying channel exists, and
// the GUI says so rather than silently doing nothing.
//
// PUT takes a partial patch and writes it to the file. Unlike the network
// settings route there is nothing to push to running sessions:
//
//   enabled, apps, injectConfig   launch-time. A CLI only emits notifications
//                                 because of a flag it was started with, and
//                                 whether a session is watched at all is
//                                 decided once, at launch.
//   channels (empty vs non-empty) launch-time in ONE direction: an empty list
//                                 means no detector is attached at all, so
//                                 adding the first channel takes effect on the
//                                 next launch. Which channels, among a
//                                 non-empty set, is delivery-time.
//   captureBell                   BOTH, asymmetrically (review finding F10):
//                                 turning it OFF takes effect immediately
//                                 (the bridge re-checks per notification),
//                                 turning it ON only affects new sessions
//                                 (the detector's bell scanning is fixed at
//                                 launch, so that output is not scanned for
//                                 BEL when the feature is off). Fail-safe in
//                                 the direction that matters.
//   level, minIntervalMs,         delivery-time: re-read (from a 1s cache,
//   dedupeWindowMs, maxPerHour    invalidated by this route on every write)
//                                 when a notification actually fires.
//
// Status mapping: validation -> 400, internal -> 500 (same as
// routes/networkAllowlist.js).
//
// Web Push subscription endpoints land here too, in Step 4.

import {
  getBridgeSettings,
  updateBridgeSettings,
  BRIDGE_APPS,
  BRIDGE_CHANNELS,
  BRIDGE_LEVELS,
  BRIDGE_LIMITS,
  BRIDGE_DEFAULTS,
} from '../ws/notifyBridgeSettings.js';
import { loadSandboxConfig } from '../ws/sandbox.js';
import { listSubscriptions } from '../ws/notify.js';
import { bridgeStats } from '../ws/notifyBridge.js';
import { notifyDetectorStats } from '../ws/sessionManager.js';

// Which delivery channels this host can actually reach right now. 'discord'
// covers the configured Discord webhook AND every runtime subscription
// together (notify.js does not split them), matching the `notify` MCP tool's
// own channel vocabulary.
function channelsAvailable() {
  const notify = loadSandboxConfig().notify || {};
  return {
    discord: !!notify.discordWebhook || listSubscriptions().length > 0,
    // Wired up in Step 4 (VAPID keys + push subscriptions); until then the
    // GUI shows the channel as selectable but unreachable.
    webpush: false,
  };
}

export async function notificationsRoute(fastify) {
  fastify.get('/notify-settings', async () => ({
    settings: getBridgeSettings(),
    channelsAvailable: channelsAvailable(),
    // Review finding F4: the bridge documents "suppression is never silent"
    // and names these counters as one of the three ways it keeps that promise
    // -- so they have to be reachable by something other than a test.
    // `armed` answers "is anything even being watched right now", which is the
    // first question when notifications are not arriving.
    stats: { ...bridgeStats(), ...notifyDetectorStats() },
    // Static vocabulary, served alongside the values so the GUI never has to
    // hardcode a list that could drift from the server's validation.
    choices: {
      apps: [...BRIDGE_APPS],
      channels: [...BRIDGE_CHANNELS],
      levels: [...BRIDGE_LEVELS],
      limits: BRIDGE_LIMITS,
      defaults: BRIDGE_DEFAULTS,
    },
  }));

  fastify.put('/notify-settings', async (request, reply) => {
    const res = updateBridgeSettings(request.body);
    if (!res.ok) {
      const status = res.code === 'validation' ? 400 : 500;
      return reply.code(status).send({ error: res.message || res.code });
    }
    return { settings: res.settings, channelsAvailable: channelsAvailable() };
  });
}
