import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  APPS,
  isValidApp,
  appDisplayName,
  appResumeArgs,
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

test('APPS covers both agents', () => {
  assert.deepEqual(APPS, ['claude', 'opencode']);
});

test('isValidApp accepts only known apps', () => {
  assert.ok(isValidApp('claude'));
  assert.ok(isValidApp('opencode'));
  assert.ok(!isValidApp('bogus'));
  assert.ok(!isValidApp(undefined));
  assert.ok(!isValidApp(null));
});

test('appDisplayName maps apps to labels', () => {
  assert.equal(appDisplayName('opencode'), 'opencode');
  assert.equal(appDisplayName('claude'), 'Claude Code');
  assert.equal(appDisplayName('bogus'), 'Claude Code');
});

test('appResumeArgs: claude resumes by id only', () => {
  assert.deepEqual(appResumeArgs('claude', null), []);
  assert.deepEqual(appResumeArgs('claude', 'abc123'), ['--resume', 'abc123']);
  assert.deepEqual(appResumeArgs('claude', 'abc123', { resumeLast: true }), ['--resume', 'abc123']);
  assert.deepEqual(appResumeArgs('claude', null, { resumeLast: true }), []);
});

test('appResumeArgs: opencode resumes by id or -c', () => {
  assert.deepEqual(appResumeArgs('opencode', null), []);
  assert.deepEqual(appResumeArgs('opencode', 'ses_abc'), ['--session', 'ses_abc']);
  assert.deepEqual(appResumeArgs('opencode', null, { resumeLast: true }), ['-c']);
  assert.deepEqual(appResumeArgs('opencode', 'ses_abc', { resumeLast: true }), ['--session', 'ses_abc']);
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
