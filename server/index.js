import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { dirsRoute } from './routes/dirs.js';
import { sessionsRoute } from './routes/sessions.js';
import { filesRoute } from './routes/files.js';
import { systemRoute } from './routes/system.js';
import { usageRoute } from './routes/usage.js';
import { groupsRoute } from './routes/groups.js';
import { workerPresetsRoute } from './routes/workerPresets.js';
import { launchPresetsRoute } from './routes/launchPresets.js';
import { projectsRoute } from './routes/projects.js';
import { approvalsRoute } from './routes/approvals.js';
import { groupFilesRoute } from './routes/groupFiles.js';
import { groupDocsRoute } from './routes/groupDocs.js';
import { sandboxRoute } from './routes/sandbox.js';
import { sandboxesRoute } from './routes/sandboxes.js';
import { networkAllowlistRoute } from './routes/networkAllowlist.js';
import { federationRoute } from './routes/federation.js';
import { authRoute } from './routes/auth.js';
import { gpgVaultRoute } from './routes/gpgVault.js';
import { terminalWs } from './ws/terminal.js';
import { remoteTerminalWs } from './ws/remoteTerminal.js';
import { gracefulShutdown, restoreSchedules } from './ws/sessionManager.js';
import { restoreGroups, detectOrphanWorktrees } from './ws/groupManager.js';
import { restoreNotify, ensureNotifyBroker, stopNotifyBroker, notifyEnabled } from './ws/notify.js';
import { ensureUsageBroker, stopUsageBroker, usageEnabled } from './ws/usageMcp.js';
import { ensureMetaAgentBroker, stopMetaAgentBroker, metaAgentEnabled } from './ws/metaAgent.js';
import { ensureReviewerBroker, stopReviewerBroker, reviewerEnabled } from './ws/reviewer.js';
import { expireStalePendingApprovals } from './ws/approvals.js';
import { ensureFederationServer, stopFederationServer, federationEnabled } from './ws/federationServer.js';
import { sweepExpiredPending } from './ws/federationPairing.js';
import { establishAllLinks } from './ws/federationLink.js';
import { warmUsage } from './usage.js';
import { warmCodexUsage } from './codexUsage.js';
import { warmOpencodeUsage } from './opencodeUsage.js';
import { initDb, dbPath } from './db.js';
import { selectableAppIds, installedApps } from './ws/sandbox.js';
import { verifySessionCookie } from './authSessions.js';
import { resolveAuthMode } from './authMode.js';
import { lockVault, isLegacyVault } from './ws/gpgVaultAgent.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// trustProxy scoped to loopback only (Issue #141 Step2): the documented HTTPS
// deployment path (Tailscale Serve, docs-site deployment/tailscale.md) always
// reverse-proxies from 127.0.0.1 to this process, and passkey mode's session
// cookie decides its Secure attribute from request.protocol
// (authSessions.js/routes/auth.js) -- without this, request.protocol sees the
// plaintext hop from the proxy and never reports 'https', so Secure would
// never be set even for a genuinely HTTPS-fronted deployment. Scoping to
// loopback (rather than trustProxy: true) means a direct, non-proxied
// connection -- this server also binds 0.0.0.0, so one is reachable -- can't
// spoof X-Forwarded-Proto to influence its own response.
const fastify = Fastify({ logger: true, trustProxy: ['127.0.0.1', '::1'] });

// L5 fix (vuln_scan report): no security headers were set at all. The
// client build has no inline scripts and no external resources at all
// (verified: client/dist/index.html loads only same-origin /assets/*.js
// and /assets/*.css; PreviewDialog.jsx's markdown renderer already
// deliberately turns every <img> into a text placeholder and strips
// every auto-fetching attribute via DOMPurify rather than relying on CSP
// for that -- see its own header comment), so a same-origin-only CSP
// costs nothing functionally while closing off script injection as a
// no-op even if some other XSS-shaped bug ever put attacker HTML on the
// page. style-src keeps 'unsafe-inline' (a much narrower risk than
// script-src) since React/xterm.js set inline style attributes via the
// DOM API in the ordinary course of rendering. No @fastify/helmet
// dependency -- same "a few lines beats a plugin" reasoning as
// authSessions.js's own manual cookie handling.
const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
};
fastify.addHook('onSend', async (request, reply) => {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) reply.header(name, value);
});

// SQLite (worker presets today, more stores in later phases): open + migrate
// before anything that might touch it -- notably the CCSERVER_AUTH_MODE=passkey
// hook below, which queries auth_sessions on every request (Issue #141 Step1
// moved this above the auth hook registration; it used to sit right before
// fastify.listen()). A failed migration refuses boot with a clear log instead
// of a systemd Restart=on-failure loop -- fail fast by design (see db.js).
try {
  initDb();
  fastify.log.info(`SQLite database ready at ${dbPath()}`);
  // Approvals whose waiter died with a previous process can never be decided:
  // expire them (fail-safe -- nothing runs just because the server restarted).
  const swept = expireStalePendingApprovals();
  if (swept > 0) fastify.log.warn(`Expired ${swept} stale pending approval(s) left by a previous run`);
  // Federation pairing requests older than the 7-day window (see
  // federationPairing.js) never had a waiter to lose, so unlike the sweep
  // above this isn't a crash-recovery step -- just the same boot-time
  // opportunity to catch up before the first browser poll does.
  const expiredPairings = sweepExpiredPending();
  if (expiredPairings > 0) fastify.log.info(`Expired ${expiredPairings} stale federation pairing request(s)`);
  // Security audit F1.4: a GPG vault created before the relay fix may have
  // had its secret key exported from a sandbox, so it is disabled for good.
  // Nothing to actively do here -- the vault always boots locked, and every
  // unlock/add path re-checks isLegacyVault() -- but say so loudly once.
  if (isLegacyVault()) {
    fastify.log.warn(
      'GPG vault was created before the security fix (audit F1) and is DISABLED: its secret key may have leaked. '
      + 'Remove its GPG/SSH keys from GitHub, then delete the vault (Settings, or `node server/cli/gpg-vault-reset.js`) and recreate it.',
    );
  }
} catch (err) {
  fastify.log.error({ err }, `Failed to initialize SQLite database (${dbPath()}): ${err.message}`);
  process.exit(1);
}

// Auth mode (Issue #141): CCSERVER_AUTH_MODE exclusively picks one of
// none (default) / token (legacy CCSERVER_TOKEN, unchanged) / passkey (new
// session-cookie based auth). Never mixed -- passkey mode does not accept
// CCSERVER_TOKEN at all (plan decision 5).
//
// Defaulting when CCSERVER_AUTH_MODE is unset (matching the pre-#141 behavior
// where CCSERVER_TOKEN alone -- "Optional token auth (Jupyter-style): set
// CCSERVER_TOKEN to enable", per README -- turned auth on, so an existing
// deployment doesn't silently lose auth on upgrade) is resolveAuthMode()'s
// job, shared with server/cli/issue-login-token.js so both agree on the
// effective mode.
const AUTH_TOKEN = process.env.CCSERVER_TOKEN;
const AUTH_MODE = resolveAuthMode();

// L3 fix (vuln_scan report): `!==` short-circuits at the first differing
// byte, so its timing leaks how many leading characters of a guess matched
// the real token -- the same class of timing side-channel git-broker.js/
// network-broker.js/mcpBroker.js already guard their own tokens against
// (see each file's own tokenEq). Same fix here for CCSERVER_TOKEN, the
// shared secret gating the entire HTTP/WS API in 'token' auth mode.
function tokenEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  try { return timingSafeEqual(ab, bb); } catch { return false; }
}

// Endpoints under /api/auth that must work with NO session yet -- the ones
// that exist to *create* one (login-token; WebAuthn authentication
// options/verify) plus Step4's mode probe, which the client needs before it
// can know whether a session is even the right concept yet. This is an
// explicit allowlist, not a blanket '/api/auth' prefix exemption: Step3 also
// adds WebAuthn *registration* (register-options/register-verify, for
// adding a passkey while already logged in) under the same
// /api/auth/webauthn/* path, and that one must require an existing session
// like any other route -- a prefix exemption would silently bypass auth for
// it too. Likewise Step4's /api/auth/session (client.js's "am I still
// logged in" check) is deliberately absent so it falls through to the
// normal session check below -- that's the whole point of it.
const UNAUTHENTICATED_AUTH_ROUTES = new Set([
  '/api/auth/mode',
  '/api/auth/login-token',
  '/api/auth/webauthn/authenticate-options',
  '/api/auth/webauthn/authenticate-verify',
]);
const isAuthRoute = (url) => UNAUTHENTICATED_AUTH_ROUTES.has(url.split('?')[0]);

if (AUTH_MODE === 'token') {
  // Legacy Jupyter-style shared-secret auth, unmodified from before Issue #141.
  if (!AUTH_TOKEN) {
    fastify.log.error('CCSERVER_AUTH_MODE=token requires CCSERVER_TOKEN to be set');
    process.exit(1);
  }
  fastify.addHook('onRequest', async (request, reply) => {
    // Allow static assets through
    if (!request.url.startsWith('/api') && !request.url.startsWith('/ws')) return;
    const token =
      request.query.token ||
      request.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (!tokenEq(token, AUTH_TOKEN)) {
      reply.code(401).send({ error: 'Invalid or missing token' });
    }
  });
  fastify.log.info('Token authentication enabled');
} else if (AUTH_MODE === 'passkey') {
  if (AUTH_TOKEN) {
    fastify.log.warn('CCSERVER_TOKEN is set but ignored because CCSERVER_AUTH_MODE=passkey');
  }
  fastify.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api') && !request.url.startsWith('/ws')) return;
    if (isAuthRoute(request.url)) return;
    if (!verifySessionCookie(request)) {
      reply.code(401).send({ error: 'Not authenticated' });
    }
  });
  fastify.log.info('Passkey authentication enabled');
} else if (AUTH_MODE === 'none') {
  if (AUTH_TOKEN) {
    fastify.log.warn("CCSERVER_TOKEN is set but ignored because CCSERVER_AUTH_MODE is 'none' (set CCSERVER_AUTH_MODE=token to enable it)");
  }
} else {
  fastify.log.error(`Unknown CCSERVER_AUTH_MODE: ${AUTH_MODE} (expected none, token, or passkey)`);
  process.exit(1);
}

// H3 fix (vuln_scan report): AUTH_MODE=none (the default when neither
// CCSERVER_AUTH_MODE nor CCSERVER_TOKEN is set) plus the server's own
// 0.0.0.0 bind meant every file/dir/session API was reachable with zero
// authentication to anyone who could reach this host on the network --
// safePath() in routes/files.js is intentionally host-wide (see
// files.test.js), so this was full unauthenticated host file read/write,
// not just "someone browses your project". Cross-device session sharing
// (README's "複数端末からのセッション共有") genuinely needs a non-loopback
// bind, so the fix isn't to force loopback by default -- it's to refuse the
// specific none+non-loopback combination at boot unless an operator
// explicitly opts in (e.g. a trusted isolated LAN with no other feasible
// auth), rather than silently exposing it.
const HOST = process.env.CCSERVER_HOST || '0.0.0.0';
const isLoopbackHost = (h) => h === '127.0.0.1' || h === '::1' || h === 'localhost';
if (AUTH_MODE === 'none' && !isLoopbackHost(HOST) && process.env.CCSERVER_ALLOW_UNAUTHENTICATED_LAN !== '1') {
  fastify.log.error(
    `Refusing to start: CCSERVER_AUTH_MODE=none with a non-loopback bind (host=${HOST}) would expose every file/session `
    + 'API unauthenticated to anyone who can reach this host on the network. Set CCSERVER_AUTH_MODE=token '
    + '(with CCSERVER_TOKEN) or CCSERVER_AUTH_MODE=passkey, set CCSERVER_HOST=127.0.0.1 for loopback-only access, '
    + 'or set CCSERVER_ALLOW_UNAUTHENTICATED_LAN=1 to accept this risk explicitly.'
  );
  process.exit(1);
}

await fastify.register(websocket);
await fastify.register(multipart, { limits: { fileSize: 500 * 1024 * 1024 } });
await fastify.register(dirsRoute, { prefix: '/api' });
await fastify.register(sessionsRoute, { prefix: '/api' });
await fastify.register(filesRoute, { prefix: '/api' });
await fastify.register(systemRoute, { prefix: '/api' });
await fastify.register(usageRoute, { prefix: '/api' });
await fastify.register(groupsRoute, { prefix: '/api' });
await fastify.register(workerPresetsRoute, { prefix: '/api' });
await fastify.register(launchPresetsRoute, { prefix: '/api' });
await fastify.register(projectsRoute, { prefix: '/api' });
await fastify.register(approvalsRoute, { prefix: '/api' });
await fastify.register(groupFilesRoute, { prefix: '/api' });
await fastify.register(groupDocsRoute, { prefix: '/api' });
await fastify.register(sandboxRoute, { prefix: '/api' });
await fastify.register(sandboxesRoute, { prefix: '/api' });
await fastify.register(networkAllowlistRoute, { prefix: '/api' });
await fastify.register(federationRoute, { prefix: '/api' });
await fastify.register(authRoute, { prefix: '/api' });
await fastify.register(gpgVaultRoute, { prefix: '/api' });
await fastify.register(terminalWs);
await fastify.register(remoteTerminalWs);

if (process.env.NODE_ENV === 'production') {
  await fastify.register(fastifyStatic, {
    root: join(__dirname, '..', 'client', 'dist'),
  });

  fastify.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api') || req.url.startsWith('/ws')) {
      reply.code(404).send({ error: 'Not found' });
    } else {
      reply.sendFile('index.html');
    }
  });
}

const cleanup = () => {
  stopNotifyBroker();
  stopUsageBroker();
  stopMetaAgentBroker();
  stopReviewerBroker();
  stopFederationServer();
  // GPG vault (plan: gpg-agent-vault): the in-memory Vault Key is this
  // feature's entire "cannot decrypt without logging in" guarantee, so a
  // graceful restart must not leave a stray gpg-agent process holding a
  // decrypted key in its tmpfs homedir. Best-effort like the brokers above
  // -- a failure here just means the next boot's homedir gets orphaned on
  // tmpfs (gone on unmount/reboot regardless), not a secret leak.
  try { lockVault(); } catch { /* best-effort */ }
  gracefulShutdown().then(() => process.exit(0));
};
process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

// Refuse to boot only if sandbox.config.json's hiddenApps (issue #105) has
// hidden every agent CLI actually installed on this host: every one of the 5
// launch screens would silently offer nothing to start. A host with nothing
// installed at all (shell-only use, CI) never had a boot-time check before
// this feature and must keep booting -- that's a separate, pre-existing
// situation hiddenApps did not create. Checked here -- after installedApps()
// filesystem detection, not at config-parse time -- because the emptiness
// only exists once "installed" and "not hidden" are intersected (see
// selectableAppIds()).
try {
  const anyInstalled = Object.values(installedApps()).some(Boolean);
  const selectable = selectableAppIds();
  if (anyInstalled && selectable.length === 0) {
    fastify.log.error(
      'Refusing to start: sandbox.config.json\'s "hiddenApps" hides every agent CLI installed on this host, '
      + 'leaving nothing launchable. Remove at least one entry from hiddenApps, or install one of the hidden CLIs.'
    );
    process.exit(1);
  }
  if (selectable.length > 0) {
    fastify.log.info(`Selectable agent CLIs: ${selectable.join(', ')}`);
  } else {
    fastify.log.warn('No agent CLI is installed on this host; only shell sessions will be launchable.');
  }
} catch (err) {
  fastify.log.error({ err }, 'Refusing to start: failed to determine selectable agent CLIs');
  process.exit(1);
}

const PORT = process.env.PORT || 3001;

// ccserver-notify: restore the subscription registry, then host the
// process-global MCP socket if the feature is enabled (Discord webhook or
// subscriptions). Started before the server accepts connections: bwrap's
// --bind-try snapshots the socket file at mount time, so it must exist
// before a notify-enabled session is created.
try {
  restoreNotify();
  if (notifyEnabled()) {
    await ensureNotifyBroker();
    fastify.log.info('ccserver-notify MCP broker started');
  }
} catch (err) {
  fastify.log.error({ err }, 'Failed to start ccserver-notify broker');
}

// ccserver-usage: host the process-global get_usage MCP socket when the
// feature is enabled (claude installed AND usageMcp explicitly enabled). Same
// bind-before-listen ordering requirement as notify above.
try {
  if (usageEnabled()) {
    await ensureUsageBroker();
    fastify.log.info('ccserver-usage MCP broker started');
  }
} catch (err) {
  fastify.log.error({ err }, 'Failed to start ccserver-usage broker');
}

// ccserver-meta: host the privileged meta-agent MCP socket when explicitly
// enabled (metaAgentMcp in sandbox.config.json). Same bind-before-listen
// ordering requirement: the meta agent's sandbox snapshots this socket at
// launch, so it must exist before any isMetaAgent session can be created.
try {
  if (metaAgentEnabled()) {
    await ensureMetaAgentBroker();
    fastify.log.info('ccserver-meta MCP broker started');
  }
} catch (err) {
  fastify.log.error({ err }, 'Failed to start ccserver-meta broker');
}

// ccserver-reviewer: host the process-global run_review/list_reviews/
// get_review MCP socket when explicitly enabled (reviewerMcp in
// sandbox.config.json). Same bind-before-listen ordering requirement as
// notify/usage/meta above.
try {
  if (reviewerEnabled()) {
    await ensureReviewerBroker();
    fastify.log.info('ccserver-reviewer MCP broker started');
  }
} catch (err) {
  fastify.log.error({ err }, 'Failed to start ccserver-reviewer broker');
}

// Federation (plan Phase 1): a dedicated mTLS listener on
// CCSERVER_FEDERATION_PORT, separate from the Fastify port above -- see
// ws/federationServer.js's header comment. Opt-in via the env var; a failure
// here (missing openssl, port already in use) disables federation for this
// run rather than refusing to boot, matching the notify/usage/meta brokers.
try {
  if (federationEnabled()) {
    await ensureFederationServer({ log: fastify.log });
    fastify.log.info(`ccserver federation listener started on port ${process.env.CCSERVER_FEDERATION_PORT}`);
    // Issue #142 Step 3: kick every non-terminal pair's FederationLink into
    // dialing right away, in case this process never otherwise calls
    // connect() for it (no RPC/terminal call has happened yet, and this pair
    // never went through the TOFU bootstrap in this process's lifetime).
    // FederationLink.connect() is idempotent and keeps retrying forever on
    // its own backoff once called, so a single fire-and-forget sweep at
    // boot is enough -- not awaited, so an unreachable peer can never delay
    // fastify.listen() below.
    establishAllLinks({ log: fastify.log }).catch((err) => {
      fastify.log.error({ err }, 'Failed to kick off federation link establishment');
    });
  }
} catch (err) {
  fastify.log.error({ err }, 'Failed to start ccserver federation listener');
}

await fastify.listen({ port: PORT, host: HOST });

// Re-arm scheduled prompts persisted before the last shutdown/restart. Missed
// ones (server was down at their time) fire shortly after startup; live ones
// wait for their time. Sessions are auto-resumed lazily at fire time.
// Combo groups are restored next: every member's pty died with the old
// process, so only its .saved-sessions.json resume info is available (see
// restoreGroups()/listGroupMembers() in groupManager.js, which check
// sessionApi.getSession() before falling back to the saved info). This
// auto-resumes/re-creates MCP channels as needed, and the UI can offer to
// re-open groups that still need it.
try {
  const groupInfo = restoreGroups();
  if (groupInfo?.restored) {
    fastify.log.info(`Restored ${groupInfo.restored} combo group(s)`);
  }
} catch (err) {
  fastify.log.error({ err }, 'Failed to restore combo groups');
}

// Diagnostic-only scan (never deletes) for worktree directories left behind
// by a removal that failed, or a crash between creation and persistence --
// see groupManager.detectOrphanWorktrees / plan section 3.7-3.
try {
  const orphans = detectOrphanWorktrees();
  if (orphans.length) {
    fastify.log.warn(`Found ${orphans.length} orphaned worktree director${orphans.length === 1 ? 'y' : 'ies'} (see warnings above); not removed automatically`);
  }
} catch (err) {
  fastify.log.error({ err }, 'Failed to scan for orphaned worktrees');
}

try {
  const info = restoreSchedules();
  if (info?.restored) {
    fastify.log.info(
      `Restored ${info.restored} scheduled prompt(s)` +
      (info.missed ? ` (${info.missed} missed while down, firing now)` : '')
    );
  }
} catch (err) {
  fastify.log.error({ err }, 'Failed to restore scheduled prompts');
}

// Warm the Claude/Codex/OpenCode Go usage caches so the first click on the
// top-bar Usage button is instant (best effort — a failed capture just
// leaves the cache empty; Go skips warming entirely when disabled/keyless).
warmUsage();
warmCodexUsage();
warmOpencodeUsage();
