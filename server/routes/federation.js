// REST boundary for cross-instance federation (plan Phase 1): pairing
// lifecycle (propose/list/decide/revoke) plus thin proxies onto an already
// 'active' peer's sessions/groups/dirs. Registered under /api (server/index.js),
// so the existing CCSERVER_TOKEN hook covers it automatically -- this file
// never re-implements that check.
//
// GET /instances and GET /pending both opportunistically reconcile every
// still-pending row against its peer (federationClient.reconcilePending)
// before answering: a network call per pending row, but Phase 1 expects at
// most a handful of pairs in flight at once, and this is what lets the
// browser's existing "poll every few seconds" pattern (see ApprovalBanner.jsx
// / SettingsView.jsx) double as the pairing state machine's only clock --
// no server-side background timer to reason about (see federationPairing.js's
// header comment on the same sweepExpiredPending tradeoff).

import * as pairing from '../ws/federationPairing.js';
import * as client from '../ws/federationClient.js';
import { ensureIdentity, keyPermissionsAreSafe } from '../ws/federationIdentity.js';
import { federationEnabled } from '../ws/federationServer.js';
import { removeLink } from '../ws/federationLink.js';

async function reconcileBestEffort() {
  try {
    await client.reconcilePending();
  } catch {
    // best effort -- an unreachable peer must never break the listing
  }
}

// Calls `method` on an already-active peer. On success returns the RPC
// result object (always {ok:true, ...} at that point -- callInstanceRpc
// throws otherwise). On failure it has ALREADY sent the error reply (404 for
// "not an active pair", 502 for an unreachable/refusing peer) and returns
// null -- callers just check for null and return.
async function callActive(reply, id, method, params) {
  if (!pairing.getActiveInstance(id)) {
    reply.code(404).send({ error: 'instance not found or not an active pair' });
    return null;
  }
  try {
    return await client.callInstanceRpc(id, method, params);
  } catch (err) {
    reply.code(502).send({ error: err.message });
    return null;
  }
}

export async function federationRoute(fastify, opts) {
  fastify.get('/federation/identity', async (_request, reply) => {
    if (!federationEnabled()) {
      return { enabled: false };
    }
    try {
      // ensureIdentity() (idempotent: generates only if missing, otherwise
      // just reads) rather than loadIdentity(), which assumes the files
      // already exist. CCSERVER_FEDERATION_PORT being set is not proof that
      // ensureFederationServer() has already run (or that it succeeded) --
      // this is the same identity generation index.js triggers at boot,
      // just lazily, so the very first poll after a slow/failed listener
      // startup still gets a real fingerprint instead of a 500.
      const id = await ensureIdentity();
      return { enabled: true, fingerprint: id.fingerprint, keyPermissionsSafe: keyPermissionsAreSafe() };
    } catch (err) {
      return reply.code(500).send({ error: `federation identity unavailable: ${err.message}` });
    }
  });

  fastify.get('/federation/instances', async () => {
    await reconcileBestEffort();
    return { instances: pairing.listInstances() };
  });

  fastify.post('/federation/instances', async (request, reply) => {
    if (!federationEnabled()) {
      return reply.code(400).send({ error: 'federation is disabled on this instance (CCSERVER_FEDERATION_PORT is not set)' });
    }
    const body = request.body || {};
    if (typeof body.remoteAddr !== 'string' || !body.remoteAddr) {
      return reply.code(400).send({ error: 'remoteAddr (host:port) is required' });
    }
    try {
      const row = await client.initiatePairing({
        remoteAddr: body.remoteAddr,
        remoteToken: typeof body.remoteToken === 'string' ? body.remoteToken : null,
        label: typeof body.label === 'string' ? body.label : null,
      });
      return { instance: row };
    } catch (err) {
      return reply.code(502).send({ error: err.message });
    }
  });

  fastify.patch('/federation/instances/:id', async (request, reply) => {
    if (!pairing.getInstance(request.params.id)) {
      return reply.code(404).send({ error: 'instance not found' });
    }
    const label = (request.body || {}).label;
    return { instance: pairing.setLabel(request.params.id, typeof label === 'string' ? label : null) };
  });

  fastify.delete('/federation/instances/:id', async (request, reply) => {
    if (!pairing.getInstance(request.params.id)) {
      return reply.code(404).send({ error: 'instance not found' });
    }
    const instance = pairing.revoke(request.params.id);
    // Issue #142 Step 2: a revoked pair's FederationLink (if one was ever
    // created for it -- getOrCreateLink is keyed by fingerprint, from any
    // prior callInstanceRpc/reconcilePending/openTerminalChannel/
    // initiatePairing call) must stop trying to reach that peer right away.
    // Without this, a link that is currently LIVE would still self-close
    // via its own revokeCheckTimer within 30s (see federationLink.js), but
    // one that is still dialing or backed off after a failed attempt has no
    // other way to learn about the revocation and would keep redialing this
    // address forever.
    removeLink(instance.fingerprint);
    return { instance };
  });

  fastify.get('/federation/pending', async () => {
    await reconcileBestEffort();
    return { pending: pairing.listPending() };
  });

  fastify.post('/federation/pending/:id/decide', async (request, reply) => {
    const decision = (request.body || {}).decision;
    if (decision !== 'approved' && decision !== 'rejected') {
      return reply.code(400).send({ error: "decision must be 'approved' or 'rejected'" });
    }
    const updated = pairing.recordLocalDecision(request.params.id, decision);
    if (!updated) {
      return reply.code(404).send({ error: 'pairing request not found, or already revoked/expired' });
    }
    // Best-effort immediate reconcile of this row (and every other pending
    // one -- reconcilePending has no per-row entry point, and the extra
    // calls are cheap at Phase 1's expected pending-row counts), so an
    // approval that completes a pair the peer already approved shows
    // 'active' right away instead of waiting for the next GET /instances poll.
    if (updated.status === 'pending_remote_approval') {
      await reconcileBestEffort();
      return { instance: pairing.getInstance(request.params.id) };
    }
    return { instance: updated };
  });

  // ---- Thin proxies onto an active peer -----------------------------

  fastify.get('/federation/instances/:id/dirs', async (request, reply) => {
    const resp = await callActive(reply, request.params.id, 'dirs.list', {
      path: request.query.path || '/',
      showHidden: request.query.showHidden === 'true' || request.query.showHidden === '1',
    });
    if (!resp) return;
    return resp.listing;
  });

  fastify.get('/federation/instances/:id/sessions', async (request, reply) => {
    const resp = await callActive(reply, request.params.id, 'sessions.list', {});
    if (!resp) return;
    return { sessions: resp.sessions };
  });

  fastify.post('/federation/instances/:id/sessions', async (request, reply) => {
    const resp = await callActive(reply, request.params.id, 'sessions.create', request.body || {});
    if (!resp) return;
    return resp.session;
  });

  fastify.delete('/federation/instances/:id/sessions/:sid', async (request, reply) => {
    const resp = await callActive(reply, request.params.id, 'sessions.destroy', { id: request.params.sid });
    if (!resp) return;
    return { success: true, id: request.params.sid };
  });

  fastify.get('/federation/instances/:id/groups', async (request, reply) => {
    const resp = await callActive(reply, request.params.id, 'groups.list', {});
    if (!resp) return;
    return { groups: resp.groups };
  });

  fastify.get('/federation/instances/:id/groups/:groupId/members', async (request, reply) => {
    const resp = await callActive(reply, request.params.id, 'groups.members', { groupId: request.params.groupId });
    if (!resp) return;
    return { members: resp.members };
  });

  fastify.post('/federation/instances/:id/groups', async (request, reply) => {
    const resp = await callActive(reply, request.params.id, 'groups.create', request.body || {});
    if (!resp) return;
    return resp.group;
  });

  fastify.delete('/federation/instances/:id/groups/:groupId', async (request, reply) => {
    const resp = await callActive(reply, request.params.id, 'groups.destroy', { groupId: request.params.groupId });
    if (!resp) return;
    return { success: true, groupId: request.params.groupId };
  });
}
