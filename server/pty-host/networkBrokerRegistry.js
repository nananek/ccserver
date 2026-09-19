// Orphaned network-broker cleanup (mirrors gitBrokerRegistry.js's mitigation
// for the same class of risk -- see its own header comment for the full
// rationale, kept as a separate registry/file on purpose so a bug in one
// can't cross-contaminate the other).
//
// sandbox.js's startNetworkBroker() spawns a plain child_process (not
// attached to any pty's controlling terminal). If pty-host itself
// crashes/OOM-kills while a sandboxed session's network broker is running,
// that broker survives as an orphan: nothing sends it a signal, and nothing
// ever removes its runtime dir (allow-list/deny-list + port file).
//
// This module is pty-host's mitigation: every network broker it spawns is
// recorded here (by the pty-host session id that owns it) and forgotten again
// on that session's normal teardown. On startup, before any session of the
// new generation is recorded, whatever is still listed here can only be
// left over from a previous generation that never got to clean up -- kill it
// and remove its dir.
//
// See brokerRegistry.js for the load/record/forget/reapOrphans logic itself
// (shared verbatim with gitBrokerRegistry.js's identical mitigation for the
// git broker).

import { createBrokerRegistry } from './brokerRegistry.js';

const { BrokerRegistry, defaultRegistryPath } = createBrokerRegistry({
  label: 'network-broker',
  envVar: 'CCSERVER_PTY_HOST_NETWORKBROKER_REGISTRY',
  fileName: 'pty-host-network-brokers.json',
});

export { defaultRegistryPath };
export { BrokerRegistry as NetworkBrokerRegistry };
