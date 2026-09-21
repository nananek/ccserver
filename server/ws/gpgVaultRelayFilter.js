// Protocol allowlist filters for gpgVaultRelay.js (security audit F1,
// remediation plan P0-1(b)). The relay used to be a dumb byte pipe onto the
// vault gpg-agent's MAIN socket, which let any gpgVault:true sandbox run
// `gpg --export-secret-keys` (KEYWRAP_KEY --export + EXPORT_KEY) and walk
// away with the whole vault secret key. The primary fix is that the relay now
// targets the agent's restricted EXTRA socket (gpgVaultRelay.js); these
// filters are the independent second layer, so the "no secret material ever
// leaves the host" invariant does not rest solely on which commands a given
// GnuPG version happens to forbid in restricted mode.
//
// Both filters only ever inspect the CLIENT -> agent direction (what a
// sandboxed process asks for). Agent -> client bytes pass through untouched;
// the Assuan filter merely scans them for INQUIRE so it knows when the client
// is allowed to send data lines.
//
// Pure (no sockets, no fs): the relay wires the three callbacks to real
// sockets, and gpgVaultRelayFilter.test.js drives them with plain Buffers.

// GPG_ERR_FORBIDDEN (251) with GPG_ERR_SOURCE_GPGAGENT (4) -- byte-identical
// to what gpg-agent itself answers in restricted mode, so a client treats a
// relay refusal exactly like an agent refusal.
export const ASSUAN_FORBIDDEN_LINE = 'ERR 67109115 Forbidden <ccserver gpg-vault relay>\n';

// Assuan's own line limit (ASSUAN_LINELENGTH, 1002 incl. CR/LF). Anything
// longer is not a well-formed Assuan line; drop the connection rather than
// guess where the command boundary is.
export const ASSUAN_MAX_LINE = 1002;

// Exactly what gpg 2.4 sends for `gpg --list-secret-keys`, git's
// `gpg --status-fd=2 -bsau <key>`, and `gpg --verify` (traced against GnuPG
// 2.4.9 while building this: RESET, OPTION, GETINFO, HAVEKEY, KEYINFO,
// SIGKEY, SETKEYDESC, SETHASH, PKSIGN), plus harmless protocol no-ops.
// Deliberately absent: KEYWRAP_KEY, EXPORT_KEY, IMPORT_KEY, GENKEY, PASSWD,
// DELETE_KEY, PRESET_PASSPHRASE, CLEAR_PASSPHRASE, GET_PASSPHRASE,
// PKDECRYPT, SETKEY, LEARN, SCD, KEYTOCARD, PUT_SECRET, GET_SECRET, ...
const ALLOWED_ASSUAN_COMMANDS = new Set([
  'RESET', 'OPTION', 'GETINFO', 'NOP', 'BYE',
  'HAVEKEY', 'KEYINFO', 'READKEY',
  'SIGKEY', 'SETKEYDESC', 'SETHASH', 'PKSIGN',
  'GETEVENTCOUNTER',
]);

// OPTION names gpg sends for ordinary operation (display/tty/locale
// plumbing and version negotiation). allow-pinentry-notify must stay allowed:
// it only makes the agent send a passive "S PINENTRY_LAUNCHED" status line
// before starting a pinentry (agent<->pinentry is a separate channel; this
// client<->agent one never gets an INQUIRE from it), so it grants no extra
// capability. Rejecting it looked harmless on GnuPG 2.4.9 (which tolerates
// the ERR and moves on), but GnuPG 2.4.4 (Ubuntu 24.04's default, and what
// CI runs) treats the failure as fatal to the whole agent handshake: every
// later command on that connection then fails with "no gpg-agent running in
// this session", which broke git-style signing through the relay.
const ALLOWED_OPTIONS = new Set([
  'agent-awareness', 'allow-pinentry-notify',
  'ttyname', 'ttytype', 'display', 'xauthority', 'lc-ctype', 'lc-messages',
  'putenv', 'pinentry-user-data', 'use-cache-for-signing', 'no-grab',
]);

// pinentry-mode values that keep passphrase entry away from the CLIENT.
// An allowlist, not "anything but loopback": loopback is the mode export
// flows rely on, and any spelling the agent might still map to it must not
// slip through.
const ALLOWED_PINENTRY_MODES = new Set(['ask', 'default', 'cancel', 'error']);

const isAssuanSpace = (c) => c === ' ' || c === '\t';

// Splits an OPTION argument exactly the way libassuan's std_handler_option
// does before gpg-agent sees it: leading/trailing blanks dropped, key ends
// at a blank or '=', then optional blanks, optional '=' with blanks around
// it, and an optional leading "--" on the key. Returns { name, value } or
// null for anything libassuan itself would reject. Mirroring the parser
// matters: a looser regex here once let "pinentry-mode = loopback" through.
function parseAssuanOption(arg) {
  let i = 0;
  while (i < arg.length && isAssuanSpace(arg[i])) i++;
  const keyStart = i;
  while (i < arg.length && !isAssuanSpace(arg[i]) && arg[i] !== '=') i++;
  let key = arg.slice(keyStart, i);
  while (i < arg.length && isAssuanSpace(arg[i])) i++;
  if (arg[i] === '=') {
    i++;
    while (i < arg.length && isAssuanSpace(arg[i])) i++;
  }
  let end = arg.length;
  while (end > i && isAssuanSpace(arg[end - 1])) end--;
  const value = arg.slice(i, end);
  if (key.startsWith('--') && key.length > 2) key = key.slice(2);
  if (!/^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(key)) return null;
  return { name: key.toLowerCase(), value };
}

function optionAllowed(arg) {
  const opt = parseAssuanOption(arg);
  if (!opt) return false;
  if (opt.name === 'pinentry-mode') return ALLOWED_PINENTRY_MODES.has(opt.value.toLowerCase());
  return ALLOWED_OPTIONS.has(opt.name);
}

// Decides one complete client line (without its trailing LF/CR). Returns
// 'forward' | 'reject' | 'abort'. Exported for direct unit testing.
export function classifyAssuanClientLine(line, { inquirePending }) {
  if (inquirePending) {
    // While the agent waits on an INQUIRE, the client may only send data
    // lines and terminate them. Anything else is a protocol violation.
    if (line.startsWith('D ') || line === 'D' || line === 'END' || line === 'CAN') return 'forward';
    return 'abort';
  }
  if (line.length === 0) return 'forward';
  // Data/END lines outside an INQUIRE have no legitimate use and are how a
  // client would smuggle bytes into a command that never asked for them.
  // libassuan ends the command word at a space OR a tab.
  const sp = line.search(/[ \t]/);
  const cmd = (sp === -1 ? line : line.slice(0, sp)).toUpperCase();
  if (!ALLOWED_ASSUAN_COMMANDS.has(cmd)) return 'reject';
  if (cmd === 'OPTION') return optionAllowed(sp === -1 ? '' : line.slice(sp + 1)) ? 'forward' : 'reject';
  return 'forward';
}

// Stateful Assuan filter for one relayed connection.
//   forward(buf) - send bytes on to the agent
//   reply(buf)   - answer the client directly (never reaches the agent)
//   abort(reason)- tear the whole connection down
// Returns { fromClient(chunk), fromServer(chunk) }; fromServer only scans
// (the caller still forwards those bytes to the client itself).
export function createAssuanFilter({ forward, reply, abort }) {
  let clientBuf = Buffer.alloc(0);
  let serverBuf = '';
  let inquirePending = false;
  let dead = false;

  function kill(reason) {
    if (dead) return;
    dead = true;
    abort(reason);
  }

  return {
    fromClient(chunk) {
      if (dead) return;
      clientBuf = clientBuf.length ? Buffer.concat([clientBuf, chunk]) : Buffer.from(chunk);
      for (;;) {
        const nl = clientBuf.indexOf(0x0a);
        if (nl === -1) {
          if (clientBuf.length > ASSUAN_MAX_LINE) kill('assuan line too long');
          return;
        }
        if (nl > ASSUAN_MAX_LINE) return kill('assuan line too long');
        const raw = clientBuf.subarray(0, nl + 1);
        clientBuf = clientBuf.subarray(nl + 1);
        let line = raw.subarray(0, nl).toString('latin1');
        if (line.endsWith('\r')) line = line.slice(0, -1);
        const verdict = classifyAssuanClientLine(line, { inquirePending });
        if (verdict === 'abort') return kill(`unexpected line during INQUIRE: ${line.slice(0, 40)}`);
        if (verdict === 'reject') {
          reply(Buffer.from(ASSUAN_FORBIDDEN_LINE, 'latin1'));
          continue;
        }
        if (inquirePending && (line === 'END' || line === 'CAN')) inquirePending = false;
        forward(Buffer.from(raw));
      }
    },
    fromServer(chunk) {
      if (dead) return;
      serverBuf += Buffer.from(chunk).toString('latin1');
      const lines = serverBuf.split('\n');
      serverBuf = lines.pop();
      // A server line longer than the limit is just carried over; cap the
      // carry so a misbehaving agent cannot grow it unbounded.
      if (serverBuf.length > ASSUAN_MAX_LINE * 4) serverBuf = serverBuf.slice(-ASSUAN_MAX_LINE);
      for (const l of lines) {
        if (l.startsWith('INQUIRE ') || l === 'INQUIRE') inquirePending = true;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// ssh-agent protocol (draft-miller-ssh-agent): uint32 length + byte type +
// payload. The vault only ever needs to list its one identity and sign with
// it; adding/removing/locking keys or talking to smartcards is refused.

export const SSH_AGENTC_REQUEST_IDENTITIES = 11;
export const SSH_AGENTC_SIGN_REQUEST = 13;
export const SSH_AGENTC_EXTENSION = 27;
export const SSH_AGENT_FAILURE = 5;
export const SSH_MAX_FRAME = 256 * 1024;

const ALLOWED_SSH_TYPES = new Set([
  SSH_AGENTC_REQUEST_IDENTITIES,
  SSH_AGENTC_SIGN_REQUEST,
  // session-bind@openssh.com and friends; gpg-agent answers FAILURE itself
  // for extensions it does not implement, so passing it through is harmless
  // and keeps modern OpenSSH clients from logging spurious errors.
  SSH_AGENTC_EXTENSION,
]);

export function sshFailureFrame() {
  return Buffer.from([0, 0, 0, 1, SSH_AGENT_FAILURE]);
}

export function createSshAgentFilter({ forward, reply, abort }) {
  let buf = Buffer.alloc(0);
  let dead = false;
  function kill(reason) {
    if (dead) return;
    dead = true;
    abort(reason);
  }
  return {
    fromClient(chunk) {
      if (dead) return;
      buf = buf.length ? Buffer.concat([buf, chunk]) : Buffer.from(chunk);
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (len === 0 || len > SSH_MAX_FRAME) return kill(`bad ssh-agent frame length ${len}`);
        if (buf.length < 4 + len) return;
        const frame = buf.subarray(0, 4 + len);
        buf = buf.subarray(4 + len);
        if (ALLOWED_SSH_TYPES.has(frame[4])) forward(Buffer.from(frame));
        else reply(sshFailureFrame());
      }
    },
    fromServer() { /* pass-through; nothing to track */ },
  };
}
