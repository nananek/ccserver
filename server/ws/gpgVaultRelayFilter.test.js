// Unit tests for the GPG vault relay's protocol allowlists (security audit
// F1, remediation plan P0-1(b)). Pure Buffer-in/Buffer-out: no sockets, no
// gpg. The end-to-end "export really fails through a live relay" check lives
// in gpgVaultRelay.test.js / sandbox-gpgvault.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ASSUAN_FORBIDDEN_LINE,
  ASSUAN_MAX_LINE,
  classifyAssuanClientLine,
  createAssuanFilter,
  createSshAgentFilter,
  sshFailureFrame,
  SSH_MAX_FRAME,
} from './gpgVaultRelayFilter.js';

function harness(create) {
  const forwarded = [];
  const replied = [];
  const aborted = [];
  const filter = create({
    forward: (b) => forwarded.push(Buffer.from(b)),
    reply: (b) => replied.push(Buffer.from(b)),
    abort: (r) => aborted.push(r),
  });
  return {
    filter,
    forwarded: () => Buffer.concat(forwarded).toString('latin1'),
    replied: () => Buffer.concat(replied).toString('latin1'),
    aborted,
    forwardedFrames: forwarded,
    repliedFrames: replied,
  };
}

// Exactly what gpg 2.4.9 sent through the agent socket for
// `gpg --list-secret-keys` + git's `gpg --status-fd=2 -bsau <fpr>` (captured
// with a logging proxy while building this filter).
const REAL_SIGNING_TRACE = [
  'RESET',
  'OPTION ttytype=xterm-256color',
  'OPTION allow-pinentry-notify',
  'OPTION agent-awareness=2.1.0',
  'GETINFO version',
  'GETINFO restricted',
  'HAVEKEY --list=1000',
  'HAVEKEY C28A05520F3249EB41F80EB70DBB9F380A692BDC 202232515317E3340CEAE1AF2C0853F3915DE3D3',
  'KEYINFO C28A05520F3249EB41F80EB70DBB9F380A692BDC',
  'SIGKEY C28A05520F3249EB41F80EB70DBB9F380A692BDC',
  'SETKEYDESC Please+enter+the+passphrase+to+unlock+the+OpenPGP+secret+key:%0A%22Test+User%22',
  'SETHASH 10 EA49DC3BEDEC2C03C81EB71320CA1FCB72FB40878D2161A4F144D825045C9A17',
  'PKSIGN',
  'BYE',
];

test('assuan: the real git-signing trace is forwarded verbatim', () => {
  const h = harness(createAssuanFilter);
  const input = REAL_SIGNING_TRACE.map((l) => `${l}\n`).join('');
  h.filter.fromClient(Buffer.from(input, 'latin1'));
  // allow-pinentry-notify must reach the agent: it only makes the agent send
  // a passive "S PINENTRY_LAUNCHED" status line before starting a pinentry
  // (a separate agent<->pinentry channel; this client<->agent one never gets
  // an INQUIRE from it), so forwarding it grants no extra capability. GnuPG
  // 2.4.9 tolerates a refusal here, but 2.4.4 (Ubuntu 24.04) treats it as
  // fatal to the whole handshake -- every later command then fails with
  // "no gpg-agent running in this session".
  assert.equal(h.forwarded(), input);
  assert.equal(h.replied(), '');
  assert.deepEqual(h.aborted, []);
});

test('assuan: every export/import/keygen/passphrase command is refused and never reaches the agent', () => {
  const forbidden = [
    'KEYWRAP_KEY --export', // first step of `gpg --export-secret-keys`
    'EXPORT_KEY --openpgp C28A05520F3249EB41F80EB70DBB9F380A692BDC',
    'EXPORT_KEY C28A05520F3249EB41F80EB70DBB9F380A692BDC',
    'KEYWRAP_KEY --import',
    'IMPORT_KEY',
    'GENKEY',
    'PASSWD C28A05520F3249EB41F80EB70DBB9F380A692BDC',
    'DELETE_KEY --force C28A05520F3249EB41F80EB70DBB9F380A692BDC',
    'PRESET_PASSPHRASE C28A -1 414243',
    'CLEAR_PASSPHRASE C28A',
    'GET_PASSPHRASE --data x x x x',
    'PKDECRYPT',
    'SETKEY C28A',
    'LEARN --sendinfo',
    'SCD SERIALNO',
    'KEYTOCARD --force C28A 1 OPENPGP.1',
    'PUT_SECRET foo',
    'GET_SECRET foo',
    'OPTION pinentry-mode=loopback',
    'OPTION --pinentry-mode=loopback',
    'OPTION pinentry-mode loopback',
    'OPTION PINENTRY-MODE=LOOPBACK',
    // libassuan allows blanks around '=' and tabs as separators; each of
    // these reaches gpg-agent as pinentry-mode=loopback.
    'OPTION pinentry-mode = loopback',
    'OPTION pinentry-mode =loopback',
    'OPTION pinentry-mode= loopback',
    'OPTION pinentry-mode\tloopback',
    'OPTION\tpinentry-mode=loopback',
    'OPTION pinentry-mode=loopback  ',
    'OPTION pinentry-mode=loopback\t',
    'OPTION pinentry-mode=',
    'OPTION pinentry-mode=bogus',
    'OPTION -ttyname=/dev/pts/0', // single dash: libassuan rejects it anyway
    'OPTION cache-ttl-opt-preset=-1',
    'OPTION',
    'D 414243', // data line with no INQUIRE outstanding
    'END',
    '# comment',
    'keywrap_key --export', // command names are case-insensitive in Assuan
    '  KEYWRAP_KEY --export', // leading space is not a command name we allow
  ];
  for (const line of forbidden) {
    const h = harness(createAssuanFilter);
    h.filter.fromClient(Buffer.from(`${line}\n`, 'latin1'));
    assert.equal(h.forwarded(), '', `"${line}" must not reach the agent`);
    assert.equal(h.replied(), ASSUAN_FORBIDDEN_LINE, `"${line}" gets a Forbidden reply`);
  }
});

test('assuan: the reply is gpg-agent\'s own GPG_ERR_FORBIDDEN code', () => {
  assert.match(ASSUAN_FORBIDDEN_LINE, /^ERR 67109115 /);
  assert.ok(ASSUAN_FORBIDDEN_LINE.endsWith('\n'));
});

test('assuan: pinentry-mode is limited to the non-loopback values', () => {
  for (const v of ['ask', 'default', 'cancel', 'error']) {
    assert.equal(classifyAssuanClientLine(`OPTION pinentry-mode=${v}`, { inquirePending: false }), 'forward', v);
  }
  assert.equal(classifyAssuanClientLine('OPTION pinentry-mode = ask', { inquirePending: false }), 'forward');
  assert.equal(classifyAssuanClientLine('OPTION --pinentry-mode=ask', { inquirePending: false }), 'forward');
  assert.equal(classifyAssuanClientLine('OPTION\tttyname=/dev/pts/0', { inquirePending: false }), 'forward');
  assert.equal(classifyAssuanClientLine('OPTION pinentry-mode=loopback', { inquirePending: false }), 'reject');
});

test('assuan: CRLF line endings are handled like LF', () => {
  const h = harness(createAssuanFilter);
  h.filter.fromClient(Buffer.from('GETINFO version\r\nKEYWRAP_KEY --export\r\n', 'latin1'));
  assert.equal(h.forwarded(), 'GETINFO version\r\n');
  assert.equal(h.replied(), ASSUAN_FORBIDDEN_LINE);
});

test('assuan: a command split across many chunks (even byte-by-byte) is still judged as a whole', () => {
  const h = harness(createAssuanFilter);
  const input = 'GETINFO version\nKEYWRAP_KEY --export\nPKSIGN\n';
  for (const byte of Buffer.from(input, 'latin1')) h.filter.fromClient(Buffer.from([byte]));
  assert.equal(h.forwarded(), 'GETINFO version\nPKSIGN\n');
  assert.equal(h.replied(), ASSUAN_FORBIDDEN_LINE);
});

test('assuan: an incomplete line is held back, never forwarded early', () => {
  const h = harness(createAssuanFilter);
  h.filter.fromClient(Buffer.from('KEYWRAP_KEY', 'latin1'));
  assert.equal(h.forwarded(), '');
  h.filter.fromClient(Buffer.from(' --export\n', 'latin1'));
  assert.equal(h.forwarded(), '');
  assert.equal(h.replied(), ASSUAN_FORBIDDEN_LINE);
});

test('assuan: an over-long line aborts the connection (with or without a newline)', () => {
  const long = `GETINFO ${'A'.repeat(ASSUAN_MAX_LINE + 10)}`;
  const withNl = harness(createAssuanFilter);
  withNl.filter.fromClient(Buffer.from(`${long}\n`, 'latin1'));
  assert.equal(withNl.aborted.length, 1);
  assert.equal(withNl.forwarded(), '');

  const noNl = harness(createAssuanFilter);
  noNl.filter.fromClient(Buffer.from(long, 'latin1'));
  assert.equal(noNl.aborted.length, 1);
  // Once aborted, nothing more is ever forwarded.
  noNl.filter.fromClient(Buffer.from('\nGETINFO version\n', 'latin1'));
  assert.equal(noNl.forwarded(), '');
});

test('assuan: D/END are accepted only while an INQUIRE is outstanding', () => {
  const h = harness(createAssuanFilter);
  h.filter.fromClient(Buffer.from('PKSIGN\n', 'latin1'));
  h.filter.fromServer(Buffer.from('INQUIRE PINENTRY_LAUNCHED 1234 curses\n', 'latin1'));
  h.filter.fromClient(Buffer.from('END\n', 'latin1'));
  // After END the inquiry is closed again; a stray D line is refused.
  h.filter.fromClient(Buffer.from('D 00\n', 'latin1'));
  assert.equal(h.forwarded(), 'PKSIGN\nEND\n');
  assert.equal(h.replied(), ASSUAN_FORBIDDEN_LINE);
});

test('assuan: an INQUIRE split across server chunks is still detected', () => {
  const h = harness(createAssuanFilter);
  h.filter.fromServer(Buffer.from('S PROGRESS x\nINQU', 'latin1'));
  h.filter.fromServer(Buffer.from('IRE KEYPARAM\n', 'latin1'));
  h.filter.fromClient(Buffer.from('D abc\nD def\nEND\n', 'latin1'));
  assert.equal(h.forwarded(), 'D abc\nD def\nEND\n');
});

test('assuan: a command while an INQUIRE is outstanding aborts (no smuggling a new command mid-inquiry)', () => {
  const h = harness(createAssuanFilter);
  h.filter.fromServer(Buffer.from('INQUIRE NEEDPIN\n', 'latin1'));
  h.filter.fromClient(Buffer.from('KEYWRAP_KEY --export\n', 'latin1'));
  assert.equal(h.aborted.length, 1);
  assert.equal(h.forwarded(), '');
});

test('assuan: a server D line that merely contains "INQUIRE" does not open an inquiry', () => {
  const h = harness(createAssuanFilter);
  h.filter.fromServer(Buffer.from('D INQUIRE fake\nOK\n', 'latin1'));
  h.filter.fromClient(Buffer.from('D 00\n', 'latin1'));
  assert.equal(h.forwarded(), '');
  assert.equal(h.replied(), ASSUAN_FORBIDDEN_LINE);
});

// ---------------------------------------------------------------------------
// ssh-agent

function sshFrame(type, payload = Buffer.alloc(0)) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(1 + payload.length, 0);
  return Buffer.concat([len, Buffer.from([type]), payload]);
}

test('ssh: list identities, sign, and extension are forwarded', () => {
  for (const type of [11, 13, 27]) {
    const h = harness(createSshAgentFilter);
    const frame = sshFrame(type, Buffer.from('payload'));
    h.filter.fromClient(frame);
    assert.deepEqual(Buffer.concat(h.forwardedFrames), frame, `type ${type} forwarded`);
    assert.equal(h.repliedFrames.length, 0);
  }
});

test('ssh: add/remove/lock/unlock/smartcard requests get SSH_AGENT_FAILURE and never reach the agent', () => {
  // 17 ADD_IDENTITY, 18 REMOVE_IDENTITY, 19 REMOVE_ALL, 20 ADD_SMARTCARD,
  // 21 REMOVE_SMARTCARD, 22 LOCK, 23 UNLOCK, 25 ADD_ID_CONSTRAINED,
  // 26 ADD_SMARTCARD_CONSTRAINED, plus legacy v1 opcodes and garbage.
  for (const type of [1, 2, 3, 7, 8, 9, 17, 18, 19, 20, 21, 22, 23, 25, 26, 0, 255]) {
    const h = harness(createSshAgentFilter);
    h.filter.fromClient(sshFrame(type, Buffer.from('x')));
    assert.equal(h.forwardedFrames.length, 0, `type ${type} not forwarded`);
    assert.deepEqual(Buffer.concat(h.repliedFrames), sshFailureFrame());
  }
});

test('ssh: frames split across chunks, and several frames in one chunk, are each judged', () => {
  const h = harness(createSshAgentFilter);
  const all = Buffer.concat([sshFrame(11), sshFrame(17, Buffer.from('secret')), sshFrame(13, Buffer.from('sig'))]);
  for (let i = 0; i < all.length; i += 3) h.filter.fromClient(all.subarray(i, i + 3));
  assert.deepEqual(Buffer.concat(h.forwardedFrames), Buffer.concat([sshFrame(11), sshFrame(13, Buffer.from('sig'))]));
  assert.deepEqual(Buffer.concat(h.repliedFrames), sshFailureFrame());
});

test('ssh: zero-length or oversized frames abort the connection', () => {
  const zero = harness(createSshAgentFilter);
  zero.filter.fromClient(Buffer.from([0, 0, 0, 0]));
  assert.equal(zero.aborted.length, 1);

  const huge = harness(createSshAgentFilter);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(SSH_MAX_FRAME + 1, 0);
  huge.filter.fromClient(len);
  assert.equal(huge.aborted.length, 1);
  assert.equal(huge.forwardedFrames.length, 0);
});
