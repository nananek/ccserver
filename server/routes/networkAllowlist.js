// REST boundary for the network-isolation settings in sandbox.config.json
// (network.isolate / network.initialState / network.mode /
// network.allowedHosts / network.deniedHosts), backing the Settings GUI tab.
// Registered under /api (server/index.js), so the optional token auth hook
// applies automatically.
//
// GET returns the effective settings. PUT takes a partial patch, writes it to
// the file (governing the next launch), then auto-applies the allow/deny
// lists to every live isolation-enabled session's broker and reports the live counts --
// running sessions need no restart for the lists themselves.
// isolate/initialState/mode changes are launch-time policy and intentionally
// never pushed live (the live enforce/open state belongs to each session's
// own toggle).
//
// Status mapping: validation -> 400, internal -> 500.

import { getNetworkSettings, updateNetworkSettings } from '../ws/networkAllowlist.js';
import { pushAllowlistToArmedSessions } from '../ws/sessionManager.js';

export async function networkAllowlistRoute(fastify) {
  fastify.get('/network-settings', async () => {
    return { settings: getNetworkSettings() };
  });

  fastify.put('/network-settings', async (request, reply) => {
    const res = updateNetworkSettings(request.body);
    if (!res.ok) {
      const status = res.code === 'validation' ? 400 : 500;
      return reply.code(status).send({ error: res.message || res.code });
    }
    // Auto-apply to running sessions (fail-soft per session -- a dying
    // broker just counts as failed, the file save itself already succeeded).
    let liveApplied = { ok: 0, failed: 0 };
    try {
      liveApplied = await pushAllowlistToArmedSessions({
        allowedHosts: res.settings.allowedHosts,
        deniedHosts: res.settings.deniedHosts,
      });
    } catch {
      // Total push failure (not per-session): report zero applied rather
      // than failing the save the user just confirmed.
      liveApplied = { ok: 0, failed: 0 };
    }
    return { settings: res.settings, liveApplied };
  });
}
