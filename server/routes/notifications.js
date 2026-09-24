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
import {
  vapidPublicKey, listSubscriptions as listPushSubscriptions,
  addSubscription, removeSubscription, countSubscriptions,
} from '../ws/pushSubscriptions.js';
import { sendNotification } from '../ws/notify.js';
import { notifyDetectorStats } from '../ws/sessionManager.js';

// Which delivery channels this host can actually reach right now. 'discord'
// covers the configured Discord webhook AND every runtime subscription
// together (notify.js does not split them), matching the `notify` MCP tool's
// own channel vocabulary.
function channelsAvailable() {
  const notify = loadSandboxConfig().notify || {};
  return {
    discord: !!notify.discordWebhook || listSubscriptions().length > 0,
    // A channel is "available" when something is actually behind it: for Web
    // Push that means at least one browser has subscribed. The VAPID key alone
    // does not make it reachable.
    webpush: countSubscriptions() > 0,
  };
}

// Throttle state for the test-send route below. Process-wide rather than
// per-session on purpose: the thing being protected is the operator's Discord
// channel and their phones, and those are shared no matter who pressed it.
const TEST_SEND_MIN_INTERVAL_MS = 5000;
let lastTestSendAt = 0;

export function _resetTestSendThrottleForTests() {
  lastTestSendAt = 0;
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
    // What a browser needs to call pushManager.subscribe(). Public by
    // definition (it is the applicationServerKey every subscriber embeds).
    vapidPublicKey: vapidPublicKey(),
    pushSubscriptions: listPushSubscriptions(),
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

  // --- Web Push subscriptions ------------------------------------------------
  //
  // The endpoint a browser hands us is a bearer secret: anyone holding it can
  // push to that browser. It is therefore accepted here, stored, and never
  // sent back out -- GET returns only each subscription's origin and label.

  fastify.post('/push/subscriptions', async (request, reply) => {
    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return reply.code(400).send({ error: 'body must be an object' });
    }
    const res = addSubscription({
      endpoint: body.endpoint,
      p256dh: body.keys?.p256dh,
      auth: body.keys?.auth,
      label: body.label,
      // Recorded so the operator can tell their devices apart in the list.
      userAgent: request.headers['user-agent'],
    });
    if (!res.ok) return reply.code(400).send({ error: res.message });
    return { subscription: res.subscription, channelsAvailable: channelsAvailable() };
  });

  fastify.delete('/push/subscriptions/:id', async (request, reply) => {
    if (!removeSubscription(request.params.id)) {
      return reply.code(404).send({ error: 'subscription not found' });
    }
    return { ok: true, channelsAvailable: channelsAvailable() };
  });

  // "Does this actually work?" -- delivered through the real path (encryption,
  // VAPID, the push service) so a green result means the whole chain works,
  // not just that the row exists.
  //
  // Rate limited (attacker review F2): this route calls sendNotification
  // directly, so it bypasses the bridge's per-session dedupe/throttle/cap
  // entirely, and one request fans out to the Discord webhook, every
  // subscribed webhook, and up to MAX_SUBSCRIPTIONS devices. Authentication
  // bounds WHO can press it, not HOW OFTEN -- and an in-app XSS would inherit
  // that authentication. A human pressing a "send a test" button needs one
  // every few seconds at most.
  fastify.post('/notify-settings/test', async (request, reply) => {
    const now = Date.now();
    const waitMs = TEST_SEND_MIN_INTERVAL_MS - (now - lastTestSendAt);
    if (waitMs > 0) {
      return reply.code(429)
        .header('Retry-After', String(Math.ceil(waitMs / 1000)))
        .send({ error: `test notifications are limited to one every ${TEST_SEND_MIN_INTERVAL_MS / 1000}s; try again in ${Math.ceil(waitMs / 1000)}s` });
    }
    const settings = getBridgeSettings();
    const channels = Array.isArray(request.body?.channels) && request.body.channels.length > 0
      ? request.body.channels
      : settings.channels;
    const bad = channels.filter((c) => !BRIDGE_CHANNELS.includes(c));
    if (bad.length > 0) return reply.code(400).send({ error: `unknown channel(s): ${bad.join(', ')}` });
    // Claim the slot only once the request is known-good: rejecting a
    // malformed body used to burn the operator's next five seconds, so a
    // client looping on 400s could keep the "send a test" button unusable.
    lastTestSendAt = now;
    const res = await sendNotification({
      title: 'ccserver',
      body: 'Test notification from Settings. If you can read this, delivery works.',
      level: 'info',
      channels,
    }, null);
    return { delivered: res.delivered, channels };
  });

  fastify.put('/notify-settings', async (request, reply) => {
    const res = updateBridgeSettings(request.body);
    if (!res.ok) {
      const status = res.code === 'validation' ? 400 : 500;
      return reply.code(status).send({ error: res.message || res.code });
    }
    return { settings: res.settings, channelsAvailable: channelsAvailable() };
  });
}
