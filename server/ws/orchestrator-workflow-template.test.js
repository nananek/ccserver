// Oracle test for the orchestrator injection template and the control MCP
// tool descriptions: the read_output discipline (wait_for_handoff-first,
// anomaly-gated single reads) and the once-per-task start report must be
// spelled out where the orchestrator actually sees them. Read-only on
// purpose: groupManager.test.js owns a runtime copy of the template and
// edits that, so this suite only asserts markers in the real repo-tracked
// files and never writes or env-swaps them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const template = readFileSync(join(import.meta.dirname, 'orchestrator-template.md'), 'utf-8');
const mcpServerSource = readFileSync(join(import.meta.dirname, 'mcpServer.js'), 'utf-8');

test('template: read_output is framed as not-a-progress-check with wait_for_handoff as the default', () => {
  assert.match(template, /read_output[^\n]*\n?[^\n]*NOT your progress check/);
  assert.match(template, /normal progress is confirmed by waiting\s*\n\s*on wait_for_handoff/);
  assert.match(template, /avoid polling it/);
});

test('template: turn pattern forbids peeking while a handoff is pending', () => {
  assert.match(template, /do not peek at the worker with read_output -- wait_for_handoff\s*\n\s+IS your progress check/);
});

test('template: handoff discipline gates read_output behind concrete anomaly signals', () => {
  assert.match(template, /anomaly-driven, single-shot confirmation justified only by a concrete\s*\n\s+signal/);
  // The three allowed triggers are all listed.
  assert.match(template, /repeated `wait_for_handoff` timeouts \(rough guide: 2-3 consecutive\)/);
  assert.match(template, /a specific anomaly from `list_group_sessions` \/ `get_tab_status`/);
  assert.match(template, /the worker itself reporting trouble\./);
  // Even when justified: one read, then act.
  assert.match(template, /When one of those fires, read ONCE:/);
  assert.match(template, /nudge it via\s*\n\s+`send_input` \("done\? call handoff_to_orchestrator"\)/);
  // The old opportunistic-read habit is explicitly retired.
  assert.match(template, /action opportunity \(a new user message, another worker's handoff, \.\.\.\)\s*\n\s+to judge whether a pending worker is idle is retired/);
  // An isolated timeout is normal and safe to retry; the trigger list (not
  // the retry advice itself) defines when a look is allowed.
  assert.match(template, /an isolated timeout is nothing\s*\n\s+to act on/);
  // Triggers stay independent alternatives -- no "timeout streak plus
  // status-tool anomaly" conjunction anywhere.
  assert.doesNotMatch(template, /streak plus/);
});

test('template: notification discipline requires exactly one start-of-task notify(info)', () => {
  assert.match(template, /- \*\*Starting\*\*: when you take on a NEW task from the human, open it with\s*\n\s+exactly ONE `notify` call BEFORE dispatching any work to the workers:/);
  assert.match(template, /level: 'info' ?\}\)/);
  assert.match(template, /once-per-task report,\s*\n\s+not a status update -- do not repeat it mid-task/);
  // Why it matters: with no channel configured the tool is not injected at
  // all, so the template has to say that rather than promise delivery.
  assert.match(template, /if no channel is\s*\n\s+configured at all the notify tool itself is absent from this session/);
  // The Vikunja channel was removed from ccserver-notify (it is being re-cut
  // as its own MCP server) -- the template must not promise task tracking.
  assert.doesNotMatch(template, /Vikunja/i);
});

test('mcpServer.js: read_output description states the discipline, status tools gate confirmation', () => {
  assert.match(mcpServerSource, /fallback for inspecting a possibly-stuck member, NOT a progress-check tool/);
  assert.match(mcpServerSource, /Justify every call with a concrete anomaly signal \(repeated wait_for_handoff timeouts/);
  assert.match(mcpServerSource, /never poll this for reassurance/);
  assert.match(mcpServerSource, /a concrete anomaly signal on its own: confirm with a single read_output/);
  assert.match(mcpServerSource, /a concrete anomaly signal on its own: confirm with at most a single read_output/);
  // Status-tool anomalies must not be gated behind timeout pile-ups either.
  assert.doesNotMatch(mcpServerSource, /piles up alongside|only once repeated wait_for_handoff timeouts/);
  // wait_for_handoff stays the once-per-turn default.
  assert.match(mcpServerSource, /Call this once per turn instead of polling read_output/);
});
