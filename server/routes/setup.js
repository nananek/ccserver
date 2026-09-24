// GET /api/setup-status -- what the Web UI reads to explain the gate
// instead of showing a bare 503 (issue #201 Step5).
//
// Exempt from the gate, but NOT from authentication: it lists real paths on
// the host. index.js registers it after the auth hook like every other
// route.
//
// `pending` comes from planMigration(), the same source as the CLI's dry
// run, so the browser and the terminal never disagree about what is about
// to move.

import { allPaths, configRoot, dataRoot, stateRoot, layoutVersion, CURRENT_LAYOUT_VERSION } from '../paths.js';
import { planMigration } from '../pathMigration.js';
import { listSessions } from '../ws/sessionManager.js';

export async function setupRoute(fastify, opts) {
  fastify.get('/setup-status', async () => {
    const version = layoutVersion();
    const plan = planMigration({ entries: allPaths() });
    return {
      setupRequired: version < CURRENT_LAYOUT_VERSION,
      layoutVersion: version,
      targetLayoutVersion: CURRENT_LAYOUT_VERSION,
      command: 'npm run setup',
      roots: { config: configRoot(), data: dataRoot(), state: stateRoot() },
      // Decides whether the client blocks the whole screen or only shows a
      // banner -- see SetupGate.jsx. A full block with sessions running
      // would strand them until the 12h idle timeout reaps them.
      liveSessions: countLiveSessions(),
      pending: plan.steps.map((s) => ({ id: s.id, label: s.label, kind: s.kind, from: s.from, to: s.to, mode: s.mode })),
      kept: plan.kept.map(({ id, label, at }) => ({ id, label, at })),
      warnings: plan.warnings.map(({ id, label, message }) => ({ id, label, message })),
    };
  });
}

// Best-effort: this endpoint exists to explain a gate, and a failure to
// count sessions must not turn into a 500 that leaves the UI with nothing
// to render. Zero is the cautious answer -- it produces the full-screen
// block, which is the correct default when nothing is known to be running.
function countLiveSessions() {
  try {
    return listSessions().length;   // already excludes exited sessions
  } catch {
    return 0;
  }
}
