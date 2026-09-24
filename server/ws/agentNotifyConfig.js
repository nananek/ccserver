// Makes an agent CLI actually emit the desktop-notification escape sequences
// that agentNotifyDetect.js reads back out of the pty (plan: plan-notify-bridge,
// Step 3). Pure: returns { args, env } for sessionManager to splice into the
// spawn, exactly like mcpConfig.js's buildMcpConfigArgsAndEnv.
//
// Why this is needed at all: claude 2.1.278 resolves its default
// `preferredNotifChannel: "auto"` from TERM_PROGRAM, and ccserver's pty sets
// only TERM=xterm-256color (sessionManager). `auto` therefore lands on
// "no_method_available" and claude emits NOTHING. Verified on a real pty:
// without this injection, a 60s-idle session produced only OSC 0 (window
// title); with it, `ESC ] 777 ; notify ; Claude Code ; Claude is waiting for
// your input BEL`.
//
// Injection is process-scoped, never a file write: `--settings <json>` layers
// over the operator's own ~/.claude/settings.json without touching it. Two
// properties were verified against the real binary before relying on this:
//   - a CLI flag beats user settings (claude's own source order is
//     ["userSettings","projectSettings","localSettings","flagSettings",
//     "policySettings"], and a probe with a conflicting `model` confirmed the
//     flag wins), so the injected channel is not silently overridden;
//   - the operator's existing hooks keep running exactly once (a Stop hook was
//     observed firing a single time with the flag present). The injected JSON
//     carries no `hooks` key at all, so there is nothing to merge or clobber.
//
// COMMAND-LINE VISIBILITY: everything returned here lands in argv, which is
// world-readable via `ps`/procfs on most hosts. So the payload is deliberately
// the single key the feature needs and nothing else -- no tokens, no paths, no
// operator settings copied along for the ride. Adding a key here means adding
// it to every `ps` listing on the box; don't, unless it is as boring as this
// one. (The same is already true of mcpConfig.js's `--mcp-config` JSON, which
// is why socket paths there are fine but the MCP *token* is passed via env.)
//
// THE OFF INVARIANT: with the bridge disabled -- or for an app the operator
// did not select, or with injectConfig off -- this returns exactly
// { args: [], env: {} }. The launch command line is then byte-for-byte what it
// was before this feature existed. agentNotifyConfig.test.js pins that.

// claude's channel table is
//   ["auto","iterm2","terminal_bell","iterm2_with_bell","kitty","ghostty",
//    "notifications_disabled"]
// and `ghostty` is the only one that carries a title and a message as separate
// fields in a single sequence (OSC 777). `iterm2` folds them into one string
// ("<title>: <message>") that cannot be split apart again; `kitty` needs three
// ST-terminated sequences; `terminal_bell` carries no payload at all.
const CLAUDE_NOTIF_CHANNEL = 'ghostty';

// Codex exposes `-c <dotted.key>=<value>` process-scoped config overrides, the
// same mechanism mcpConfig.js already uses for `-c mcp_servers.*`. Its TUI
// notification switch is `tui.notifications`.
//
// UNVERIFIED: no codex binary existed on the development host, so unlike the
// claude line above this was never observed emitting anything. That is exactly
// why codex is not in the bridge's default `apps` list -- an operator has to
// opt in, and if the key turns out to be wrong the blast radius is one
// unrecognized `-c` override rather than every session. Re-check against a
// real `codex --help` before promoting codex to a default.
const CODEX_NOTIF_ARGS = ['-c', 'tui.notifications=true'];

/**
 * Build the launch args/env that make `app` emit notification escapes.
 * @param {string|null} app        the session's agent CLI id (null for shells)
 * @param {object} bridge          normalized notify.bridge settings
 * @returns {{ args: string[], env: Record<string, string> }}
 */
export function buildAgentNotifyArgsAndEnv(app, bridge) {
  const off = { args: [], env: {} };
  if (!app || !bridge || !bridge.enabled || !bridge.injectConfig) return off;
  if (!Array.isArray(bridge.apps) || !bridge.apps.includes(app)) return off;

  if (app === 'claude') {
    // Only this one key. See COMMAND-LINE VISIBILITY above.
    return { args: ['--settings', JSON.stringify({ preferredNotifChannel: CLAUDE_NOTIF_CHANNEL })], env: {} };
  }
  if (app === 'codex') {
    return { args: [...CODEX_NOTIF_ARGS], env: {} };
  }
  // opencode emits OSC 777 on its own (the literal is in its binary); which
  // config key would gate that is unverified, so nothing is injected and the
  // detector simply picks up whatever it emits.
  //
  // copilot and commandcode have no CLI-arg/env config injection at all (see
  // mcpConfig.js's header) -- the same reason they get no MCP server. They are
  // still selectable for capture: reading the pty costs nothing and works if
  // they turn out to emit something.
  return off;
}

/**
 * Whether a session should have a detector attached at all. Capture is decided
 * once, at launch, and never re-read per pty chunk: loadSandboxConfig() parses
 * the config file on every call, and onData is the hottest path in the server.
 *
 * Delivery-side settings are resolved per notification instead -- but through
 * getBridgeSettingsCached(), NOT loadSandboxConfig(). The first cut called the
 * latter and justified it as "rare"; it is not rare, because an agent chooses
 * how many notifications to emit, and two independent reviews measured the
 * resulting event-loop stall. See notifyBridge.js's classifyNotification.
 */
export function shouldCaptureNotifications({ shell, app, bridge }) {
  if (shell || !app || !bridge || !bridge.enabled) return false;
  if (!Array.isArray(bridge.apps) || !bridge.apps.includes(app)) return false;
  // Review finding F7: with no channel selected, every pty chunk was still
  // scanned and every event still built, only to be dropped at the very end.
  // `channels` is otherwise a delivery-time setting, so this makes an EMPTY
  // list (and only an empty list) launch-time as well -- adding the first
  // channel takes effect on the next launch. That asymmetry is worth it: the
  // alternative is scanning every byte of output for a feature that is
  // configured to go nowhere.
  return Array.isArray(bridge.channels) && bridge.channels.length > 0;
}
