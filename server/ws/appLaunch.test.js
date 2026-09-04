import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  APPS,
  isValidApp,
  appDisplayName,
  appResumeArgs,
  appModelArgs,
  appSupportsModelFlag,
  appSubmitKey,
  extractResumeSessionId,
  detectPermissionPrompt,
} from './appLaunch.js';

const noSpace = (s) => s.replace(/\s+/g, '');

// Same ANSI-stripping regex sessionManager.js applies to pty output chunks.
const stripAnsi = (s) => s.replace(
  /\x1b(?:\[[0-9;?]*[a-zA-Z]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[()][A-Z0-9]|[>=<]|#[0-9])/g,
  ''
);

// Accumulate stripped chunks the way sessionManager.js's autoYesBuf does
// (10KB cap, 5KB tail, then space-collapse) and report whether the prompt
// detector ever fires.
function accumulateDetect(app, chunks) {
  let buf = '';
  for (const c of chunks) {
    buf += stripAnsi(c);
    if (buf.length > 10000) buf = buf.slice(-5000);
    if (detectPermissionPrompt(app, noSpace(buf))) return true;
  }
  return false;
}

// Raw ANSI frame captured from a real opencode 1.18.15 TUI session via
// node-pty (Aug 2026): the "Permission required" box for `rm -f /tmp/...`
// (external directory access). Kept as a single literal so the regression
// tests exercise the detector against real renderer output, not hand-written
// approximations.
const OPENCODE_PERMISSION_BOX_RAW = '                                                                   \x1b[0m\x1b[30;3H\x1b[38;2;245;167;66m\x1b[48;2;20;20;20m┃\x1b[0m\x1b[30;4H\x1b[38;2;255;255;255m\x1b[48;2;20;20;20m  \x1b[0m\x1b[30;6H\x1b[38;2;245;167;66m\x1b[48;2;20;20;20m△\x1b[0m\x1b[30;7H\x1b[38;2;255;255;255m\x1b[48;2;20;20;20m \x1b[0m\x1b[30;8H\x1b[38;2;238;238;238m\x1b[48;2;20;20;20mPermission required\x1b[0m\x1b[30;27H\x1b[38;2;255;255;255m\x1b[48;2;20;20;20m                                                                                            \x1b[0m\x1b[31;3H\x1b[38;2;245;167;66m\x1b[48;2;20;20;20m┃\x1b[0m\x1b[31;4H\x1b[38;2;255;255;255m\x1b[48;2;20;20;20m    \x1b[0m\x1b[31;8H\x1b[38;2;128;128;128m\x1b[48;2;20;20;20m←\x1b[0m\x1b[31;9H\x1b[38;2;255;255;255m\x1b[48;2;20;20;20m \x1b[0m\x1b[31;10H\x1b[38;2;238;238;238m\x1b[48;2;20;20;20mAccess external directory /tmp\x1b[0m\x1b[31;40H\x1b[38;2;255;255;255m\x1b[48;2;20;20;20m                                                                               \x1b[0m\x1b[32;3H\x1b[38;2;245;167;66m\x1b[48;2;20;20;20m┃\x1b[0m\x1b[32;4H\x1b[38;2;255;255;255m\x1b[48;2;20;20;20m                                                                                                                   \x1b[0m\x1b[33;3H\x1b[38;2;245;167;66m\x1b[48;2;20;20;20m┃\x1b[0m\x1b[33;4H\x1b[38;2;255;255;255m\x1b[48;2;20;20;20m  \x1b[0m\x1b[33;6H\x1b[38;2;128;128;128m\x1b[48;2;20;20;20mPatterns\x1b[0m\x1b[33;14H\x1b[38;2;255;255;255m\x1b[48;2;20;20;20m                                                                                                         \x1b[0m\x1b[34;3H\x1b[38;2;245;167;66m\x1b[48;2;20;20;20m┃\x1b[0m\x1b[34;4H\x1b[38;2;255;255;255m\x1b[48;2;20;20;20m                                                                                                                   \x1b[0m\x1b[35;3H\x1b[38;2;245;167;66m\x1b[48;2;20;20;20m┃\x1b[0m\x1b[35;4H\x1b[38;2;255;255;255m\x1b[48;2;20;20;20m  \x1b[0m\x1b[35;6H\x1b[38;2;238;238;238m\x1b[48;2;20;20;20m- /tmp/*\x1b[0m\x1b[35;14H\x1b[38;2;255;255;255m\x1b[48;2;20;20;20m                                                                                                         \x1b[0m\x1b[36;3H\x1b[38;2;245;167;66m\x1b[48;2;20;20;20m┃\x1b[0m\x1b[36;4H\x1b[38;2;255;255;255m\x1b[48;2;20;20;20m                                                                                                                   \x1b[0m\x1b[37;3H\x1b[38;2;245;167;66m\x1b[48;2;20;20;20m┃\x1b[0m\x1b[37;6H\x1b[38;2;255;255;255m\x1b[48;2;30;30;30m     \x1b[0m\x1b[37;12H\x1b[38;2;255;255;255m\x1b[48;2;30;30;30m \x1b[0m\x1b[37;14H\x1b[38;2;255;255;255m\x1b[48;2;30;30;30m                            \x1b[0m\x1b[37;43H\x1b[38;2;255;255;255m\x1b[48;2;30;30;30m           \x1b[0m\x1b[37;55H\x1b[38;2;255;255;255m\x1b[48;2;30;30;30m \x1b[0m\x1b[37;57H\x1b[38;2;255;255;255m\x1b[48;2;30;30;30m   \x1b[0m\x1b[38;3H\x1b[38;2;245;167;66m\x1b[48;2;20;20;20m┃\x1b[0m\x1b[38;4H\x1b[38;2;255;255;255m\x1b[48;2;30;30;30m  \x1b[0m\x1b[38;6H\x1b[38;2;255;255;255m\x1b[48;2;245;167;66m \x1b[0m\x1b[38;7H\x1b[38;2;10;10;10m\x1b[48;2;245;167;66mAllow once\x1b[0m\x1b[38;17H\x1b[38;2;255;255;255m\x1b[48;2;245;167;66m \x1b[0m\x1b[38;18H\x1b[38;2;255;255;255m\x1b[48;2;30;30;30m  \x1b[0m\x1b[38;20H\x1b[38;2;128;128;128m\x1b[48;2;30;30;30mAllow always\x1b[0m\x1b[38;32H\x1b[38;2;255;255;255m\x1b[48;2;30;30;30m   \x1b[0m\x1b[38;35H\x1b[38;2;128;128;128m\x1b[48;2;30;30;30mReject\x1b[0m\x1b[38;41H\x1b[38;2;255;255;255m\x1b[48;2;30;30;30m             ';

test('APPS covers all supported agents', () => {
  assert.deepEqual(APPS, ['claude', 'opencode', 'copilot', 'codex', 'commandcode']);
});

test('isValidApp accepts only known apps', () => {
  assert.ok(isValidApp('claude'));
  assert.ok(isValidApp('opencode'));
  assert.ok(isValidApp('copilot'));
  assert.ok(isValidApp('codex'));
  assert.ok(isValidApp('commandcode'));
  assert.ok(!isValidApp('bogus'));
  assert.ok(!isValidApp(undefined));
  assert.ok(!isValidApp(null));
});

test('appDisplayName maps apps to labels', () => {
  assert.equal(appDisplayName('opencode'), 'opencode');
  assert.equal(appDisplayName('copilot'), 'GitHub Copilot');
  assert.equal(appDisplayName('claude'), 'Claude Code');
  assert.equal(appDisplayName('codex'), 'OpenAI Codex');
  assert.equal(appDisplayName('commandcode'), 'Command Code');
  assert.equal(appDisplayName('bogus'), 'Claude Code');
});

test('appResumeArgs: claude resumes by id or --continue', () => {
  assert.deepEqual(appResumeArgs('claude', null), []);
  assert.deepEqual(appResumeArgs('claude', 'abc123'), ['--resume', 'abc123']);
  assert.deepEqual(appResumeArgs('claude', 'abc123', { resumeLast: true }), ['--resume', 'abc123']);
  assert.deepEqual(appResumeArgs('claude', null, { resumeLast: true }), ['--continue']);
});

test('appResumeArgs: opencode resumes by id or -c', () => {
  assert.deepEqual(appResumeArgs('opencode', null), []);
  assert.deepEqual(appResumeArgs('opencode', 'ses_abc'), ['--session', 'ses_abc']);
  assert.deepEqual(appResumeArgs('opencode', null, { resumeLast: true }), ['-c']);
  assert.deepEqual(appResumeArgs('opencode', 'ses_abc', { resumeLast: true }), ['--session', 'ses_abc']);
});

test('appResumeArgs: copilot resumes only via --continue (no id-based resume)', () => {
  assert.deepEqual(appResumeArgs('copilot', null), []);
  // copilot exposes no conversation id in its byte stream, so an id is never
  // expected here; even if one slipped in, it must not become an argument.
  assert.deepEqual(appResumeArgs('copilot', 'abc123'), []);
  assert.deepEqual(appResumeArgs('copilot', null, { resumeLast: true }), ['--continue']);
  assert.deepEqual(appResumeArgs('copilot', 'abc123', { resumeLast: true }), ['--continue']);
});

test('appResumeArgs: codex resumes by id or --last', () => {
  assert.deepEqual(appResumeArgs('codex', null), []);
  assert.deepEqual(appResumeArgs('codex', 'session-1'), ['resume', 'session-1']);
  assert.deepEqual(appResumeArgs('codex', null, { resumeLast: true }), ['resume', '--last']);
  assert.deepEqual(appResumeArgs('codex', 'session-1', { resumeLast: true }), ['resume', 'session-1']);
});

test('appResumeArgs: commandcode resumes by id or -c', () => {
  assert.deepEqual(appResumeArgs('commandcode', null), []);
  assert.deepEqual(appResumeArgs('commandcode', 'abc123'), ['--resume', 'abc123']);
  assert.deepEqual(appResumeArgs('commandcode', null, { resumeLast: true }), ['-c']);
  assert.deepEqual(appResumeArgs('commandcode', 'abc123', { resumeLast: true }), ['--resume', 'abc123']);
});

test('codex resume argv keeps the global model flag after the resume selector', () => {
  const launchArgs = (resumeId, resumeLast, model) => [
    ...appResumeArgs('codex', resumeId, { resumeLast }),
    ...appModelArgs('codex', model),
  ];
  assert.deepEqual(launchArgs(null, false, 'gpt-5.6-terra'), ['--model', 'gpt-5.6-terra']);
  assert.deepEqual(launchArgs('session-1', false, 'gpt-5.6-terra'), ['resume', 'session-1', '--model', 'gpt-5.6-terra']);
  assert.deepEqual(launchArgs(null, true, 'gpt-5.6-terra'), ['resume', '--last', '--model', 'gpt-5.6-terra']);
});

test('appSupportsModelFlag: opencode verified, copilot verified, claude opt-in only', () => {
  assert.equal(appSupportsModelFlag('opencode'), true, 'opencode --help confirms -m/--model');
  assert.equal(appSupportsModelFlag('copilot'), true, 'copilot --help confirms --model (real binary, Aug 2026)');
  assert.equal(appSupportsModelFlag('codex'), true, 'Codex documents --model');
  assert.equal(appSupportsModelFlag('commandcode'), true, 'command-code accepts --model');
  // claude's --model support cannot be verified on this host (the local
  // wrapper resolves to a missing binary), so it must default to off and only
  // turn on via the documented opt-in env var.
  const before = process.env.CCSERVER_CLAUDE_MODEL;
  delete process.env.CCSERVER_CLAUDE_MODEL;
  try {
    assert.equal(appSupportsModelFlag('claude'), false);
  } finally {
    if (before === undefined) delete process.env.CCSERVER_CLAUDE_MODEL;
    else process.env.CCSERVER_CLAUDE_MODEL = before;
  }
  assert.equal(appSupportsModelFlag('claude'), false, 'unknown/bogus env must not enable it');
  assert.equal(appSupportsModelFlag('bogus'), false);
});

test('appSupportsModelFlag: claude opt-in via CCSERVER_CLAUDE_MODEL=1', () => {
  const before = process.env.CCSERVER_CLAUDE_MODEL;
  process.env.CCSERVER_CLAUDE_MODEL = '1';
  try {
    assert.equal(appSupportsModelFlag('claude'), true);
  } finally {
    if (before === undefined) delete process.env.CCSERVER_CLAUDE_MODEL;
    else process.env.CCSERVER_CLAUDE_MODEL = before;
  }
});

test('appModelArgs: opencode emits --model only for a non-empty string model', () => {
  assert.deepEqual(appModelArgs('opencode', 'anthropic/claude-sonnet-4'), ['--model', 'anthropic/claude-sonnet-4']);
  assert.deepEqual(appModelArgs('opencode', 'gpt-5'), ['--model', 'gpt-5']);
  assert.deepEqual(appModelArgs('opencode', ''), [], 'empty model must be omitted');
  assert.deepEqual(appModelArgs('opencode', null), [], 'null model must be omitted');
  assert.deepEqual(appModelArgs('opencode', undefined), [], 'absent model must be omitted');
  assert.deepEqual(appModelArgs('opencode', 42), [], 'non-string model must be omitted');
});

test('appModelArgs: copilot emits --model for a non-empty string model', () => {
  assert.deepEqual(appModelArgs('copilot', 'claude-sonnet-4-5'), ['--model', 'claude-sonnet-4-5']);
  assert.deepEqual(appModelArgs('copilot', 'gpt-5.4'), ['--model', 'gpt-5.4']);
  assert.deepEqual(appModelArgs('copilot', ''), [], 'empty model must be omitted');
  assert.deepEqual(appModelArgs('copilot', null), [], 'null model must be omitted');
  assert.deepEqual(appModelArgs('copilot', undefined), [], 'absent model must be omitted');
  assert.deepEqual(appModelArgs('copilot', 42), [], 'non-string model must be omitted');
});

test('appModelArgs: codex preserves arbitrary model names as one argv value', () => {
  assert.deepEqual(appModelArgs('codex', 'gpt-5.6 terra'), ['--model', 'gpt-5.6 terra']);
  assert.deepEqual(appModelArgs('codex', ''), []);
  assert.deepEqual(appModelArgs('codex', null), []);
  assert.deepEqual(appModelArgs('codex', 42), []);
});

test('appModelArgs: claude never emits --model unless the capability is enabled', () => {
  const before = process.env.CCSERVER_CLAUDE_MODEL;
  delete process.env.CCSERVER_CLAUDE_MODEL;
  try {
    assert.deepEqual(appModelArgs('claude', 'anthropic/claude-sonnet-4'), [],
      'an unverified Claude CLI must never receive an unsupported flag');
  } finally {
    if (before === undefined) delete process.env.CCSERVER_CLAUDE_MODEL;
    else process.env.CCSERVER_CLAUDE_MODEL = before;
  }
  process.env.CCSERVER_CLAUDE_MODEL = '1';
  try {
    assert.deepEqual(appModelArgs('claude', 'anthropic/claude-sonnet-4'), ['--model', 'anthropic/claude-sonnet-4']);
  } finally {
    if (before === undefined) delete process.env.CCSERVER_CLAUDE_MODEL;
    else process.env.CCSERVER_CLAUDE_MODEL = before;
  }
});

test('appSubmitKey: every agent CLI submits with CR, Codex included (regression lock)', () => {
  // The submit byte sent by sessionManager.writeToSession({ submit: true })
  // after the typed text. All four CLIs accept CR today; this pins the table
  // so a future edit that flips any app to LF (a soft newline in several
  // TUIs) is a deliberate, reviewed change rather than an accident.
  for (const app of APPS) {
    assert.equal(appSubmitKey(app), '\r', `${app} must submit with CR`);
    assert.notEqual(appSubmitKey(app), '\n', `${app} must never submit with LF`);
  }
});

test('appSubmitKey: unknown apps and plain shells fall back to CR', () => {
  assert.equal(appSubmitKey(undefined), '\r');
  assert.equal(appSubmitKey(null), '\r');
  assert.equal(appSubmitKey('bogus'), '\r');
});

test('extractResumeSessionId: claude extracts the last resume id', () => {
  assert.equal(extractResumeSessionId('claude', 'Use: claude --resume abc123'), 'abc123');
  assert.equal(extractResumeSessionId('claude', 'claude -r xyz789'), 'xyz789');
  assert.equal(extractResumeSessionId('claude', 'claude --resume abc123\nclaude --resume def456'), 'def456');
  assert.equal(extractResumeSessionId('claude', 'resume with: claude --resume !@# $%^'), null);
  assert.equal(extractResumeSessionId('claude', 'nothing to see here'), null);
});

test('extractResumeSessionId: strips ANSI before matching', () => {
  const raw = '\x1b[1m\x1b[32mclaude\x1b[0m --resume \x1b[33mabc123\x1b[0m';
  assert.equal(extractResumeSessionId('claude', raw), 'abc123');
});

test('extractResumeSessionId: opencode never exposes a stream id', () => {
  assert.equal(extractResumeSessionId('opencode', 'claude --resume abc123'), null);
  assert.equal(extractResumeSessionId('opencode', 'opencode --session ses_abc'), null);
  assert.equal(extractResumeSessionId('opencode', ''), null);
});

test('extractResumeSessionId: copilot never exposes a stream id', () => {
  assert.equal(extractResumeSessionId('copilot', 'claude --resume abc123'), null);
  assert.equal(extractResumeSessionId('copilot', 'copilot --continue'), null);
  assert.equal(extractResumeSessionId('copilot', 'copilot --resume=<session-id>'), null);
  assert.equal(extractResumeSessionId('copilot', ''), null);
});

test('extractResumeSessionId: codex is intentionally not inferred from TUI output', () => {
  assert.equal(extractResumeSessionId('codex', 'codex resume session-1'), null);
});

test('extractResumeSessionId: commandcode never exposes a stream id', () => {
  assert.equal(extractResumeSessionId('commandcode', 'command-code --resume abc123'), null);
  assert.equal(extractResumeSessionId('commandcode', ''), null);
});

test('detectPermissionPrompt: claude Ink prompts', () => {
  const buf = (s) => noSpace(s);
  assert.ok(detectPermissionPrompt('claude', buf('Do you want to proceed?')));
  assert.ok(detectPermissionPrompt('claude', buf('Do you want to make this edit?')));
  assert.ok(detectPermissionPrompt('claude', buf('Do you want to use the Bash tool?')));
  assert.ok(detectPermissionPrompt('claude', buf('Yes, allow')));
  assert.ok(detectPermissionPrompt('claude', buf('Claude wants to fetch content from example.com')));
  assert.ok(detectPermissionPrompt('claude', buf('Claude wants to search the web for: x')));
  assert.ok(detectPermissionPrompt('claude', buf('Claude wants to call a tool')));
  assert.ok(!detectPermissionPrompt('claude', buf('just some normal output')));
});

test('detectPermissionPrompt: copilot numbered choice prompt', () => {
  const buf = (s) => noSpace(s);
  // docs.github.com (Aug 2026) documents the numbered permission choices;
  // the space-collapsed buffer is what the detector sees.
  assert.ok(detectPermissionPrompt('copilot', buf('1. Yes')));
  assert.ok(detectPermissionPrompt('copilot', buf('1. Yes, approve')));
  assert.ok(detectPermissionPrompt('copilot', buf('2. Yes, and approve Read for the rest of the running session')));
  // The full prompt renders all three options; the reject line alone is not
  // an approvable prompt.
  assert.ok(detectPermissionPrompt('copilot', buf('1. Yes  2. Yes, and approve Bash for the rest of the running session  3. No, and tell Copilot what to do differently (Esc)')));
  assert.ok(!detectPermissionPrompt('copilot', buf('3. No, and tell Copilot what to do differently (Esc)')));
  // Numbered prose alone ("1. Yes" style lists a plan might emit) is a
  // possible false positive -- the "running session" clause is the
  // distinguishing phrase for the approve-all option.
  assert.ok(!detectPermissionPrompt('copilot', buf('just some normal output')));
  assert.ok(!detectPermissionPrompt('copilot', buf('No such option: 1.')));
});

test('detectPermissionPrompt: copilot model prose is not a prompt', () => {
  const buf = (s) => noSpace(s);
  const prose = [
    'Here is the plan: 1. Fix the bug 2. Run the tests 3. Ship it',
    'Yes, that approach works',
    'The session is still running, nothing to do',
    // Note: a literal "1. Yes" numbered list in prose would be a false
    // positive by design -- the heuristic is tuned against the real TUI
    // frame (plan §6.5), which is what adds the surrounding prompt chrome.
  ];
  for (const p of prose) {
    assert.ok(!detectPermissionPrompt('copilot', buf(p)), p);
  }
});

test('detectPermissionPrompt: Codex local-command approval menu', () => {
  const buf = (s) => noSpace(s);
  // Captured from Codex CLI 0.149.0 (Aug 2026). Enter selects the highlighted
  // first option: "Yes, proceed". The question and selected option can arrive
  // in different PTY chunks, so exercise the session-level accumulator too.
  const prompt = `
    Would you like to run the following command?
    Environment: local
    Reason: Do you want to allow checking the current GitHub Actions status?
    $ gh pr checks 69
    › 1. Yes, proceed (y)
      2. Yes, and don't ask again for commands that start with \`gh pr checks\` (p)
      3. No, and tell Codex what to do differently (esc)
  `;
  assert.ok(detectPermissionPrompt('codex', buf(prompt)));
  const cut = prompt.indexOf('1. Yes') + '1. Yes'.length;
  assert.ok(accumulateDetect('codex', [prompt.slice(0, cut), prompt.slice(cut)]));
});

test('detectPermissionPrompt: Codex MCP-tool approval menu', () => {
  const buf = (s) => noSpace(s);
  // MCP permissions use "Allow" rather than the local-command menu's
  // "Yes, proceed". Enter accepts the initially selected one-time Allow.
  const prompt = `
    Allow the ccserver MCP server to run tool "list_group_sessions"?
    › 1. Allow                   Run the tool and continue.
      2. Allow for this session  Run the tool and remember this choice for this session.
      3. Always allow            Run the tool and remember this choice for future tool calls.
      4. Cancel                  Cancel this tool call
    enter to submit | esc to cancel
  `;
  assert.ok(detectPermissionPrompt('codex', buf(prompt)));
  const cut = prompt.indexOf('run tool') + 'run tool'.length;
  assert.ok(accumulateDetect('codex', [prompt.slice(0, cut), prompt.slice(cut)]));
});

test('detectPermissionPrompt: Codex model prose is not a prompt', () => {
  const buf = (s) => noSpace(s);
  const prose = [
    'Would you like to run the following command? This is an example in the documentation.',
    '1. Yes, proceed (y) 2. No',
    'The command will run locally after you proceed.',
    'Allow the example MCP server to run tool "list_group_sessions" in this document.',
  ];
  for (const p of prose) {
    assert.ok(!detectPermissionPrompt('codex', buf(p)), p);
  }
});

test('detectPermissionPrompt: opencode permission box', () => {
  const buf = (s) => noSpace(s);
  assert.ok(detectPermissionPrompt('opencode', buf('┃  △ Permission required ┃')));
  assert.ok(detectPermissionPrompt('opencode', buf('Permission required')));
  // Option labels alone are not enough -- the real box always renders the
  // title first, and model prose can mention "allow once"/"allow always".
  assert.ok(!detectPermissionPrompt('opencode', buf('Allow once')));
  assert.ok(!detectPermissionPrompt('opencode', buf('Allow always')));
  assert.ok(!detectPermissionPrompt('opencode', buf('just some normal output')));
});

test('detectPermissionPrompt: opencode real captured permission box', () => {
  // Raw ANSI frame captured from a real opencode 1.18.15 TUI session via
  // node-pty (Aug 2026): the "Permission required" box shown for an
  // `rm -f /tmp/...` command (external directory access), cursor-positioned
  // with box-drawing glyphs and the amber-highlighted "Allow once" default.
  const box = OPENCODE_PERMISSION_BOX_RAW;
  assert.ok(box.includes('Permission required'));
  assert.ok(detectPermissionPrompt('opencode', noSpace(stripAnsi(box))));
  assert.ok(accumulateDetect('opencode', [box]));
});

test('detectPermissionPrompt: opencode box split across delivery chunks', () => {
  // The TUI can split a render across pty writes; the title must still be
  // recognized once accumulated (cut mid-word between "Permission"/"required"
  // and between the title and the option row).
  const clean = stripAnsi(OPENCODE_PERMISSION_BOX_RAW);
  const midTitle = clean.indexOf('Permission') + 'Permission'.length;
  assert.ok(accumulateDetect('opencode', [clean.slice(0, midTitle), clean.slice(midTitle)]));
  const cut = clean.indexOf('Permission required') + 'Permission required'.length;
  assert.ok(accumulateDetect('opencode', [clean.slice(0, cut), clean.slice(cut)]));
});

test('detectPermissionPrompt: opencode narrow-terminal wraps', () => {
  // A narrow terminal wraps "Permission required" across lines; the
  // space-collapse must still reconstruct the title.
  const clean = stripAnsi(OPENCODE_PERMISSION_BOX_RAW);
  const betweenWords = clean.replace('Permission required', 'Permission\nrequired');
  assert.ok(accumulateDetect('opencode', [betweenWords]));
  const midWord = clean.replace('Permission required', 'Permission requir\ned');
  assert.ok(accumulateDetect('opencode', [midWord]));
});

test('detectPermissionPrompt: opencode model prose is not a prompt', () => {
  // False-positive guards: "allow once"/"allow always"/"permission required"
  // appearing in ordinary model output must not trigger the Enter send.
  const prose = [
    'The plan will allow once and then allow always for external fetches',
    'Error: permission required.',
    'Permission required to write to the file',
    'You can grant access once',
    'permission required — try again later',
    'Please allow always; it speeds things up',
  ];
  for (const p of prose) {
    assert.ok(!detectPermissionPrompt('opencode', noSpace(p)), p);
    assert.ok(!accumulateDetect('opencode', [p]), p);
  }
});

test('detectPermissionPrompt: commandcode is never auto-approved (unverified frame)', () => {
  // Same policy as codex: the approval rendering is not verified on this
  // host, so the detector must stay silent and let the user answer in the
  // terminal -- even for claude-shaped prose that would match the generic
  // fallback.
  const buf = (s) => noSpace(s);
  assert.ok(!detectPermissionPrompt('commandcode', buf('Do you want to proceed?')));
  assert.ok(!detectPermissionPrompt('commandcode', buf('Yes, allow')));
  assert.ok(!detectPermissionPrompt('commandcode', buf('Permission required')));
  assert.ok(!accumulateDetect('commandcode', ['Do you want to ', 'proceed?']));
});
