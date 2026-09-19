// Orphaned git-broker cleanup (plan5 section 2.1's flagged risk).
//
// sandbox.js's startGitBroker() spawns a plain child_process (not attached to
// any pty's controlling terminal), so Step0's PoC finding -- a crashed
// parent's pty children die with it via the kernel's SIGHUP -- does NOT apply
// to it. If pty-host itself crashes/OOM-kills while a sandboxed session's
// git-broker is running, that broker survives as an orphan: nothing sends it
// a signal, and nothing ever removes its runtime dir (allow-list + socket).
//
// This module is pty-host's mitigation: every git-broker it spawns is
// recorded here (by the pty-host session id that owns it) and forgotten again
// on that session's normal teardown. On startup, before any session of the
// new generation is recorded, whatever is still listed here can only be
// left over from a previous generation that never got to clean up -- kill it
// and remove its dir.
//
// See brokerRegistry.js for the load/record/forget/reapOrphans logic itself
// (shared verbatim with networkBrokerRegistry.js's identical mitigation for
// the network broker).

import { createBrokerRegistry } from './brokerRegistry.js';

const { BrokerRegistry, defaultRegistryPath } = createBrokerRegistry({
  label: 'git-broker',
  envVar: 'CCSERVER_PTY_HOST_GITBROKER_REGISTRY',
  fileName: 'pty-host-git-brokers.json',
});

export { defaultRegistryPath };
export { BrokerRegistry as GitBrokerRegistry };
