import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
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
import { notificationsRoute } from './routes/notifications.js';
import { federationRoute } from './routes/federation.js';
import { authRoute } from './routes/auth.js';
import { gpgVaultRoute } from './routes/gpgVault.js';
import { setupRoute } from './routes/setup.js';
import { terminalWs } from './ws/terminal.js';
import { remoteTerminalWs } from './ws/remoteTerminal.js';
import { gracefulShutdown, restoreSchedules } from './ws/sessionManager.js';
import { restoreGroups, detectOrphanWorktrees } from './ws/groupManager.js';
import { restoreNotify, ensureNotifyBroker, stopNotifyBroker, notifyEnabled } from './ws/notify.js';
import { ensureVapidKeys, countSubscriptions } from './ws/pushSubscriptions.js';
import { setWebpushReachable } from './ws/notifyBridge.js';
import { ensureUsageBroker, stopUsageBroker, usageEnabled } from './ws/usageMcp.js';
import { ensureReviewerBroker, stopReviewerBroker, reviewerEnabled } from './ws/reviewer.js';
import { expireStalePendingApprovals } from './ws/approvals.js';
import { ensureFederationServer, stopFederationServer, federationEnabled } from './ws/federationServer.js';
import { sweepExpiredPending } from './ws/federationPairing.js';
import { establishAllLinks } from './ws/federationLink.js';
import { warmUsage } from './usage.js';
import { warmCodexUsage } from './codexUsage.js';
import { warmOpencodeUsage } from './opencodeUsage.js';
import { initDb, dbPath } from './db.js';
import { selectableAppIds, installedApps, loadSandboxConfig } from './ws/sandbox.js';
import { isCcserverScratchPath, isContained } from './pathPolicy.js';
import { guardedPaths, allPaths, configRoot, dataRoot, stateRoot, layoutVersion, CURRENT_LAYOUT_VERSION } from './paths.js';
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
// Setup gate (issue #201, decision D3). Registered after the auth hook and
// before the route plugins: authentication still works, but the operations
// that would CREATE new state do not, until `npm run setup` has run here.
//
// The server still STARTS, and nothing in this block ever calls
// process.exit() -- it is a different thing entirely from the boot refusals
// above. Three production hosts run this under `systemctl --user` with live
// sessions in them; "refuses to boot until migrated" would take them all
// down on the very upgrade that introduces the wizard.
//
// The guiding principle, because it decides every entry in the allowlist:
//
//     The gate's job is to stop the operator from creating NEW state in the
//     WRONG PLACE. It is not to stop the server from serving state it
//     already has.
//
// POST /api/sessions on an un-migrated host writes .saved-sessions.json to
// the repo root, and the wizard would then move it out from under the
// operator. GET does not. Hence: writes gated, reads and re-attach open.
//
// Not gated, and each for a reason that will bite if it is removed:
//   /ws/*              re-attaching to a RUNNING pty. Block this and nobody
//                      can reach their sessions, and DEFAULT_SESSION_TIMEOUT_MS
//                      (12h, timeoutEnv.js) silently reaps them. Blocking
//                      the UI would cause exactly the outage that not
//                      restarting the server was meant to avoid.
//   GET /api/sessions  the session list behind that re-attach.
//   GET /api/system    the header's system stats; a broken header makes the
//                      gate screen look like a crash.
//   /api/setup-status  how the UI learns why it is gated.
//   /api/auth/*        block this and you get a login loop with no way to
//                      read the instructions.
//   static assets      the SPA has to load to render the explanation.
if (layoutVersion() < CURRENT_LAYOUT_VERSION) {
  fastify.log.warn(
    `Setup is not complete (layout v${layoutVersion()}, expected v${CURRENT_LAYOUT_VERSION}): ccserver is still `
    + 'reading its config and state from the pre-#201 locations. Run `npm run setup` on this host '
    + '(dry run first, then `npm run setup -- --yes`) and restart. Write operations are refused with 503 '
    + 'until then; GET /api/setup-status lists what would move.'
  );
  fastify.addHook('onRequest', async (request, reply) => {
    if (isSetupExempt(request)) return;
    reply.code(503).send({
      error: 'Setup is not complete on this host',
      code: 'SETUP_REQUIRED',
      command: 'npm run setup',
    });
  });
}

function isSetupExempt(request) {
  const url = request.url;
  if (!url.startsWith('/api') && !url.startsWith('/ws')) return true;
  if (url.startsWith('/ws/')) return true;
  const path = url.split('?')[0];
  if (path === '/api/setup-status') return true;
  if (path.startsWith('/api/auth/')) return true;
  if (request.method === 'GET' && (path.startsWith('/api/sessions') || path.startsWith('/api/system'))) return true;
  return false;
}

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
await fastify.register(notificationsRoute, { prefix: '/api' });
await fastify.register(federationRoute, { prefix: '/api' });
await fastify.register(authRoute, { prefix: '/api' });
await fastify.register(gpgVaultRoute, { prefix: '/api' });
await fastify.register(setupRoute, { prefix: '/api' });
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
// hidden every agent CLI actually installed on this host: every one of the 4
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

// browseRoots (issue #189): refuse to boot if ccserver's own internal state
// files -- most importantly the SQLite DB, which holds the GPG Vault's
// encrypted secret key material, and the federation mTLS private key --
// would fall inside the configured browseRoots. Without this guard, an
// operator narrowing /api/files and /api/dirs to browseRoots could still
// expose these files through those very same endpoints if browseRoots
// happens to contain them (e.g. pointing it at $XDG_STATE_HOME, where the
// saved-*.json state files live, or at $XDG_DATA_HOME, where the DB and the
// federation key do).
//
// Also refuses to boot on an unreadable/unparseable sandbox.config.json or a
// present-but-invalid browseRoots: falling back to defaults would silently
// downgrade a security setting (see loadSandboxConfig's configError /
// browseRootsInvalid), and a running server that keeps re-reading a broken
// config would fail open at runtime too.
{
  const { browseRoots, browseRootsInvalid, configError, configPath, ghUsageRecording } = loadSandboxConfig();
  if (configError) {
    fastify.log.error(
      `Refusing to start: sandbox.config.json (${configPath}) exists but could not be read/parsed: ${configError}. `
      + 'Fix or remove the file (a missing file is fine -- every setting has a default), then restart.',
    );
    process.exit(1);
  }
  if (browseRootsInvalid) {
    fastify.log.error(
      `Refusing to start: sandbox.config.json (${configPath}) sets "browseRoots" to an unusable value `
      + '(must be an array of directory paths). Refusing to fall back to host-wide access. Fix the setting, then restart.',
    );
    process.exit(1);
  }
  // The opt-in gh usage aggregate (issue #198) must not sit anywhere a
  // sandboxed session can write, and the ccserver scratch tree is exactly
  // that: pathPolicy exempts it from browseRoots precisely because combo
  // worktrees and each session's persistent HOME live there and are rw-bound
  // into the sandbox. So this check is unconditional -- unlike the
  // browseRoots block below, it holds even in the default configuration.
  if (ghUsageRecording.enabled && isCcserverScratchPath(resolve(ghUsageRecording.file))) {
    fastify.log.error(
      `Refusing to start: sandbox.config.json's ghUsageRecording.file (${ghUsageRecording.file}) is inside the `
      + 'ccserver sandbox scratch tree, which sessions can write (persistent HOME and combo worktrees are rw-bound '
      + 'from there). A session could forge or suppress its own usage counts. Move it outside that tree, then restart.',
    );
    process.exit(1);
  }
  if (browseRoots.length > 0) {
    // Registry-driven (decision D4). On a migrated host three roots cover
    // every internal file, which is the point of the whole issue: a unified
    // location makes this check nearly disappear (ten hardcoded entries ->
    // three roots plus whatever an operator has pulled out with an env var
    // or the wizard left behind). An un-migrated host keeps today's exact
    // behavior, entry by entry.
    const candidates = [
      ...(layoutVersion() >= CURRENT_LAYOUT_VERSION
        ? [
          { label: 'ccserver 設定ディレクトリ', envVar: 'XDG_CONFIG_HOME', path: configRoot() },
          { label: 'ccserver データディレクトリ', envVar: 'XDG_DATA_HOME', path: dataRoot() },
          { label: 'ccserver 状態ディレクトリ', envVar: 'XDG_STATE_HOME', path: stateRoot() },
          ...allPaths().filter((e) => e.overridden || e.keptLegacy),
        ]
        : guardedPaths()),
      // The gh usage aggregate (#198), checked against browseRoots: inside
      // it, the file is a session cwd away from being rewritten by the very
      // agents it counts. Appended OUTSIDE the layout ternary on purpose --
      // it is not a registry entry (the operator names an absolute path in
      // sandbox.config.json), so it is an outlier in BOTH layouts and would
      // be easy to add to one branch and forget in the other.
      //
      // Note this block is browseRoots-only: without browseRoots any
      // directory can be a session cwd, so there is nothing general to check
      // against and the operator has to place the file outside the checkout
      // themselves (the configuration guide says so). The scratch-tree check
      // above is the one case that can be checked unconditionally.
      ...(ghUsageRecording.enabled
        ? [{ label: "gh usage aggregate (sandbox.config.json's ghUsageRecording.file)", envVar: null, path: ghUsageRecording.file }]
        : []),
    ];
    const exposed = candidates.filter((e) => isContained(resolve(e.path), browseRoots));
    if (exposed.length > 0) {
      fastify.log.error(
        'Refusing to start: "browseRoots" is set, but the following ccserver-internal state files fall '
        + 'inside it and would become browsable/downloadable via /api/files, /api/dirs: '
        + exposed.map((e) => `${e.label}${e.envVar ? ` (${e.envVar})` : ''} = ${e.path}`).join(', ')
        + '. Move them outside browseRoots via their env var override (shown in parens above), or narrow browseRoots to exclude them.'
      );
      process.exit(1);
    }
    // The reverse containment (a browseRoot sitting INSIDE one of our own
    // trees, e.g. browseRoots: ["~/.local/share/ccserver/home/myproj"]) has
    // never been checked and is not being promoted to a boot refusal here:
    // someone may be deliberately browsing a sandbox home, and turning that
    // into a hard failure belongs in its own security review, not in a
    // path-layout change. Warn so it is at least visible.
    const inverted = [configRoot(), dataRoot(), stateRoot()]
      .filter((root) => browseRoots.some((b) => isContained(resolve(b), [root])));
    if (inverted.length > 0) {
      fastify.log.warn(
        `"browseRoots" points inside ccserver's own directories (${inverted.join(', ')}). `
        + 'Internal state may be reachable via /api/files and /api/dirs. Consider narrowing it.'
      );
    }
  }
}

const PORT = process.env.PORT || 3001;

// Web Push (plan-notify-bridge): mint the host's VAPID identity on first boot
// so the public key is ready before any browser asks to subscribe, and tell
// the notification bridge how to find out whether the webpush channel can
// actually reach anyone (a late binding, so notifyBridge does not have to
// depend on the push store existing).
try {
  ensureVapidKeys();
  setWebpushReachable(() => countSubscriptions() > 0);
} catch (err) {
  fastify.log.error({ err }, 'Failed to initialize Web Push VAPID keys; push notifications are unavailable');
}

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
  } else {
    // Review finding #1: staying silent here is how an upgrade turns into a
    // mystery. With no delivery target, shouldInjectNotify() is false and the
    // `notify` tool is not injected into ANY session -- agents lose their only
    // way to call a human, and nothing else in the process says so. That
    // matters most for a deployment upgrading past the Vikunja channel's
    // removal (issue #207): it may have had Vikunja as its ONLY real target,
    // and the docs/example-config notes about this are things you read after
    // you already suspect something is wrong. This log line is the one place
    // that reaches an existing install on the restart that changes its
    // behavior. (Symmetric with the info line above, which fires when it IS
    // enabled.)
    fastify.log.warn(
      'ccserver-notify is DISABLED: no delivery target is configured, so the notify MCP tool will not be '
      + 'injected into any session and agents have no way to call a human. Set notify.discordWebhook '
      + '(or CCSERVER_DISCORD_WEBHOOK), or seed notify.subscriptions, in sandbox.config.json. '
      + 'NOTE: the Vikunja channel was removed and no longer counts as a delivery target -- see '
      + 'https://github.com/nananek/ccserver/issues/207',
    );
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

// ccserver-reviewer: host the process-global run_review/list_reviews/
// get_review MCP socket when explicitly enabled (reviewerMcp in
// sandbox.config.json). Same bind-before-listen ordering requirement as
// notify/usage above.
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
// run rather than refusing to boot, matching the notify/usage brokers.
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
