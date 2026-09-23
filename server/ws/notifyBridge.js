// The policy layer between the pty notification detector and the delivery
// channels (plan: plan-notify-bridge, Step 3).
//
// agentNotifyDetect.js answers "did the agent emit a notification and what did
// it say". This module answers "should it go out, where, how often, and whose
// name is on it". Keeping them apart matters: the detector is pure and knows
// nothing about sessions, while everything here needs session identity.
//
// Delivery reuses notify.js's sendNotification() in-process -- the same
// function the `notify` MCP tool calls -- so the Discord webhook, every
// runtime subscription, the SSRF guards, the delivery timeout and the
// `_from:` attribution footer all come along unchanged. No new outbound path,
// no new socket, nothing new reachable from inside the sandbox.
//
// ---------------------------------------------------------------------------
// WHO WROTE WHAT (attacker review N6)
//
// The agent controls the bytes it writes to its pty, so the notification text
// is untrusted. Two structural properties keep it from impersonating another
// session or the server itself:
//
//   1. The TITLE is built here, from facts the agent cannot influence (its
//      app id and the session's project name, both assigned by ccserver at
//      launch). The agent's own title never becomes the notification's title
//      -- it is folded into the body with its text. So "which session is
//      asking for me" is always ccserver's answer, never the agent's.
//   2. The agent's text is ALWAYS A SINGLE LINE. agentNotifyDetect's
//      sanitizer maps every C0/C1 control -- newline included -- to a space,
//      and strips U+2028/U+2029 (which some clients render as line breaks).
//      An agent therefore cannot open a new line, which is what forging a
//      second "_from: ..." footer would require. The real footer is appended
//      by notify.js after a blank line, below the single body line.
//
// What this deliberately does NOT try to do is make agent text indistinguish-
// able from server text *within* one line. An agent can still write
// "_from: someone-else" inline. Making that impossible would mean escaping or
// quoting the body, which costs more legibility than the residual risk is
// worth -- the line it sits on is already labelled by a title the agent could
// not write.
//
// ---------------------------------------------------------------------------
// FLOW CONTROL, AND WHY IT IS NOISY ABOUT IT (attacker review N3)
//
// A 1MiB burst of `ESC]777;notify;;x BEL` parses into ~65,000 events. Handed
// straight to sendNotification that is ~65,000 POSTs to the Discord webhook
// and every subscribed webhook -- a 429, possibly a deleted webhook, and a
// push bill. Three bounds, all operator-configurable (see
// notifyBridgeSettings.js):
//
//   minIntervalMs   throttle: at most one delivery per session per interval
//   dedupeWindowMs  identical text within the window is dropped
//   maxPerHour      hard cap per session per rolling hour
//
// Suppression is never silent. The review that found the missing "notify is
// disabled" boot log (#1) was the same failure shape: a subsystem that stops
// working and says nothing turns into an unanswerable "why did I stop getting
// notifications?". So:
//   - the first suppression of each kind, per session per window, logs once
//     (once, not per event -- the flood must not become a log flood);
//   - hitting the hourly cap delivers ONE final notification saying so and
//     when it lifts, so the human learns from the channel they were watching
//     rather than from a server log they are not reading;
//   - bridgeStats() exposes the running totals.

import { loadSandboxConfig } from './sandbox.js';
import { sendNotification } from './notify.js';
import { createNotifyDetector } from './agentNotifyDetect.js';
import { basename } from 'node:path';
import { appDisplayName } from './appLaunch.js';

const HOUR_MS = 60 * 60 * 1000;

// Bounds the per-session dedupe memory: an agent that emits unique text every
// time must not be able to grow this map. Dropping the oldest entries only
// costs a missed dedupe, never a missed delivery.
const DEDUPE_MAX_KEYS = 64;

// Process-wide counters, for tests and for anyone asking "is it doing
// anything". Not persisted -- this is operational noise, not state.
const stats = {
  delivered: 0,
  throttled: 0,
  deduped: 0,
  capped: 0,
  failed: 0,
};

export function bridgeStats() {
  return { ...stats };
}

export function _resetBridgeStatsForTests() {
  for (const k of Object.keys(stats)) stats[k] = 0;
}

// Per-session flow-control state, hung off the session record so it dies with
// the session (no global map to leak).
function flowState(session, now) {
  let st = session.notifyFlow;
  if (!st || now - st.windowStart >= HOUR_MS) {
    st = {
      windowStart: now,
      count: 0,
      lastDeliveredAt: 0,
      recent: new Map(), // sanitized text -> last seen ms
      warned: { throttled: false, deduped: false, capped: false },
    };
    session.notifyFlow = st;
  }
  return st;
}

// A short, stable label for logs: the same session identification the human
// sees in the notification title.
function sessionLabel(session) {
  return `${session.app || 'agent'}/${String(session.id).slice(0, 8)}`;
}

// Log the first occurrence of each suppression kind per window. Deliberately
// once per window per session rather than per event: the whole point of the
// limit is that the event rate can be enormous.
function warnOnce(session, st, kind, message) {
  if (st.warned[kind]) return;
  st.warned[kind] = true;
  console.warn(`[notify-bridge] ${sessionLabel(session)}: ${message}`);
}

// The notification title, built entirely from server-side facts. See
// "WHO WROTE WHAT" above -- the agent never gets to set this.
//
// The project label falls back from the session's assigned projectName (only
// combo members get one) to the basename of its cwd, which is the same rule
// notify.js's own `_from:` footer uses -- so the title and the footer always
// name the same project rather than disagreeing for standalone sessions. The
// filesystem root has no meaningful name, so it is omitted.
export function buildBridgeTitle(session) {
  const app = appDisplayName(session.app);
  let project = session.projectName || null;
  if (!project && session.cwd && session.cwd !== '/') project = basename(session.cwd);
  return project ? `${app} · ${project}` : app;
}

// The agent's own title and body collapsed into one line. Both arrive already
// sanitized and length-capped from the detector; joining them here is purely
// presentational.
export function buildBridgeBody(event) {
  if (event.kind === 'bell') return 'Terminal bell';
  const title = event.title ? String(event.title) : '';
  const body = event.body ? String(event.body) : '';
  if (title && body) return `${title} — ${body}`;
  return title || body || '';
}

// Deliver, honoring the policy. Returns a small result object describing what
// happened, which is what the tests assert on (and what makes "it was
// suppressed" observable rather than a silent return).
export async function handleAgentNotification(session, event, deps = {}) {
  const now = deps.now ? deps.now() : Date.now();
  const send = deps.sendNotification || sendNotification;
  const bridge = (deps.settings || loadSandboxConfig().notify?.bridge) || null;

  if (!bridge || !bridge.enabled) return { delivered: false, reason: 'disabled' };
  if (event.kind === 'bell' && !bridge.captureBell) return { delivered: false, reason: 'bell-disabled' };
  if (!Array.isArray(bridge.channels) || bridge.channels.length === 0) {
    return { delivered: false, reason: 'no-channels' };
  }

  const body = buildBridgeBody(event);
  if (!body) return { delivered: false, reason: 'empty' };

  const st = flowState(session, now);

  // Dedupe first: a repeated identical line is the cheapest thing to drop, and
  // doing it before the throttle means a redraw loop cannot consume the
  // throttle's one-per-interval slot.
  const lastSeen = st.recent.get(body);
  if (lastSeen !== undefined && now - lastSeen < bridge.dedupeWindowMs) {
    stats.deduped += 1;
    warnOnce(session, st, 'deduped',
      `suppressing repeated notification "${body.slice(0, 60)}" (dedupeWindowMs=${bridge.dedupeWindowMs})`);
    return { delivered: false, reason: 'deduped' };
  }

  if (st.lastDeliveredAt && now - st.lastDeliveredAt < bridge.minIntervalMs) {
    stats.throttled += 1;
    warnOnce(session, st, 'throttled',
      `dropping notifications closer together than minIntervalMs=${bridge.minIntervalMs}ms`);
    return { delivered: false, reason: 'throttled' };
  }

  if (st.count >= bridge.maxPerHour) {
    stats.capped += 1;
    // The one-shot notice: the human finds out from the channel they were
    // watching, not from a log. Bounded to one per session per hour by the
    // warned flag, which resets with the window.
    if (!st.warned.capped) {
      const resumesAt = new Date(st.windowStart + HOUR_MS).toISOString();
      warnOnce(session, st, 'capped',
        `hit maxPerHour=${bridge.maxPerHour}; further notifications are suppressed until ${resumesAt}`);
      try {
        await send({
          title: buildBridgeTitle(session),
          body: `Notification rate limit reached (${bridge.maxPerHour}/hour). Further notifications from this session are suppressed until ${resumesAt}.`,
          level: 'warning',
          channels: bridge.channels,
        }, notifyIdentity(session));
      } catch {
        // The notice is best effort; never let it break the data path.
      }
    }
    return { delivered: false, reason: 'capped' };
  }

  st.count += 1;
  st.lastDeliveredAt = now;
  st.recent.set(body, now);
  while (st.recent.size > DEDUPE_MAX_KEYS) st.recent.delete(st.recent.keys().next().value);

  try {
    const res = await send({
      title: buildBridgeTitle(session),
      body,
      level: bridge.level,
      channels: bridge.channels,
    }, notifyIdentity(session));
    stats.delivered += 1;
    return { delivered: true, result: res };
  } catch (err) {
    // sendNotification is documented never to throw, but a bug there must not
    // take down a pty data handler.
    stats.failed += 1;
    console.warn(`[notify-bridge] ${sessionLabel(session)}: delivery failed: ${err?.message || err}`);
    return { delivered: false, reason: 'error' };
  }
}

// The per-connection attribution notify.js appends as "_from: host · project ·
// group · session". Same shape sessionManager builds for the MCP path.
function notifyIdentity(session) {
  return {
    sessionId: session.id,
    groupId: session.groupId ?? null,
    groupRole: session.groupRole ?? null,
    cwd: session.cwd,
    projectName: session.projectName ?? null,
    app: session.app ?? null,
  };
}

// Attach a detector to a session. Called once at launch by sessionManager,
// only for sessions the bridge is actually armed for -- so a session with the
// feature off carries no detector and onData pays nothing at all.
export function attachNotifyDetector(session, bridge, deps = {}) {
  session.notifyDetector = createNotifyDetector({
    allowBell: !!bridge.captureBell,
    onNotification: (event) => {
      // Fire-and-forget: the pty data handler must never await delivery.
      Promise.resolve()
        .then(() => handleAgentNotification(session, event, deps))
        .catch(() => { /* handleAgentNotification already swallows its own */ });
    },
  });
  return session.notifyDetector;
}
