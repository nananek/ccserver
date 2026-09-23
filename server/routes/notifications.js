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
// settings route there is nothing to push to running sessions: `enabled` /
// `apps` / `injectConfig` are launch-time policy (a CLI only emits
// notifications because of a flag it was started with), and the delivery
// knobs are read per notification straight off the file. So a change takes
// effect on the next launch for capture, and immediately for delivery.
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
