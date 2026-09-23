// Oracle test for the orchestrator injection template and the control MCP
// tool descriptions: the read_output discipline (wait_for_handoff-first,
// anomaly-gated single reads) and the Vikunja task start report must be
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
  // Why it matters: the first info notification creates the Vikunja tracking task.
  assert.match(template, /this first `info` notification automatically creates\s*\n\s+the group's Vikunja tracking task \(labeled `status-running`\)/);
  assert.match(template, /final Done\s*\n\s+notification \(`level: 'success'`\) closes it out as done/);
  assert.match(template, /skipping\s*\n\s+the start report means the whole task goes untracked in Vikunja/);
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

// The attacker-perspective review is a required gate before the final review
// -> push -> PR stage, not an optional extra. Every load-bearing instruction
// below has a failure mode if it silently disappears, so each is pinned:
// drop "actually run the attacks" and the review decays into a static
// read-through; drop the detached checkout and the reviewer hits git's
// same-branch-in-two-worktrees refusal; drop the separate-worker rule and the
// author reviews its own intent instead of its result.
test('template: the attacker-perspective review gate is mandatory and fully specified', () => {
  // The stage exists and is marked mandatory in the heading itself.
  assert.match(template, /^## Attacker-perspective review stage \(MANDATORY before the final review\)$/m);
  assert.match(template, /required gate, not\s*\n\s*an optional extra: no branch reaches `gh pr create` without it/);

  // The self-review stage routes into it rather than straight to workerA,
  // and workerA's own description knows the gate is a precondition.
  assert.match(template, /move on to the\s*\n\s+attacker-perspective review stage below/);
  assert.match(template, /After workerB's self-review stage AND the\s*\n\s+mandatory attacker-perspective review stage pass/);

  // A dedicated OpenCode worker -- never the implementer.
  assert.match(template, /open_tab\(\{ role: 'workerSec', app:\s*\n\s*'opencode'/);
  assert.match(template, /It MUST be a separate worker\. Never ask the worker that wrote the code\s*\n\s+to attack its own change/);
  assert.match(template, /It MUST be `app: 'opencode'`/);

  // Push first, then review the remote branch detached (git refuses a second
  // checkout of the same branch).
  assert.match(template, /push its branch first \(`git push -u origin/);
  assert.match(template, /git fetch origin && git checkout --detach origin\/<branch>/);
  assert.match(template, /git refuses to check the same branch out in a second worktree/);

  // The two instructions that keep this from degrading into a static review.
  assert.match(template, /\*\*Actually run the attacks\.\*\* Reading the diff is not the deliverable/);
  assert.match(template, /\*\*Separate what was reproduced from what was reasoned about\.\*\*/);
  assert.match(template, /a reproduced exploit \(with the exact\s*\n\s+steps and observed output\) or an unverified hypothesis/);

  // Findings go through the document board; re-running the gate is a judgment call.
  assert.match(template, /publish its findings with `publish_doc`/);
  assert.match(template, /run another attacker round afterwards is YOUR call/);

  // The two refusals: hardening is not proof, and nothing is exempt for
  // looking harmless -- this template is itself an injected prompt, so a
  // docs-only diff still carries attack surface.
  assert.match(template, /\*\*Existing hardening is not an answer\.\*\*/);
  assert.match(template, /whether the defense can be bypassed, and whether the defense itself opened\s*\n\s+something new/);
  assert.match(template, /\*\*No change is exempt for having "no attack surface"\.\*\* Documentation-only\s*\n\s*diffs are in scope too/);
  assert.match(template, /text IS an attack surface here/);
});
