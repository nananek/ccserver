#!/ccserver-sandbox-node
// Runs INSIDE the sandbox, bound OVER /usr/bin/ssh (and set as
// $GIT_SSH_COMMAND) so every ssh invocation passes through here first; see
// sandbox.js for how the binds/env are wired.
//
// Only gates git-smart-over-ssh invocations: parses the argv the way git's
// own ssh transport does (`ssh [options] [user@]host "git-upload-pack
// '<path>'"` etc.), extracts host+path, and checks it against a static,
// non-secret allow-list JSON file (ro-bound at session start, path from
// $CCSANDBOX_GIT_ALLOWLIST — see gitAllowlist.js for how it's computed).
// Plain interactive ssh/scp usage (no git-upload-pack/git-receive-pack/
// git-upload-archive command) is passed through unchanged — this wrapper
// scopes git credential use, not general ssh network access.
//
// Deliberately reads the allow-list directly from disk rather than asking
// the git-broker over its socket: the allow-list isn't secret, and this
// keeps SSH access to already-allowed repos working even if the broker
// process has crashed (only HTTPS credential vending depends on the
// broker being alive).
'use strict';

const fs = require('fs');
const { execFileSync } = require('child_process');

// SSH options that consume the following argv as a value (so we can skip
// past them to find the actual [user@]host argument). Combined short forms
// like `-p2222` are handled separately below.
const VALUE_OPTS = new Set([
  '-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l',
  '-m', '-O', '-o', '-p', '-Q', '-R', '-S', '-W', '-w', '-B',
]);

function parseSshArgv(argv) {
  let i = 0;
  let port = null;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--') { i += 1; break; }
    if (!a.startsWith('-') || a === '-') break;
    if (a === '-p' && argv[i + 1] !== undefined) { port = argv[i + 1]; i += 2; continue; }
    if (a.startsWith('-p') && a.length > 2) { port = a.slice(2); i += 1; continue; }
    if (VALUE_OPTS.has(a)) { i += 2; continue; }
    i += 1;
  }
  return { hostArg: argv[i], commandArg: argv[i + 1], port };
}

// git passes the remote command as a single string argument, e.g.
// "git-upload-pack 'owner/repo.git'". Returns the quoted path, or null if
// this isn't a git-smart-http-style command.
function extractRepoPath(commandArg) {
  if (!commandArg) return null;
  const m = commandArg.match(/^git-(?:upload-pack|receive-pack|upload-archive)\s+(.+)$/);
  if (!m) return null;
  let p = m[1].trim();
  if ((p.startsWith("'") && p.endsWith("'")) || (p.startsWith('"') && p.endsWith('"'))) {
    p = p.slice(1, -1);
  }
  return p;
}

// Same normalization rules as gitAllowlist.js's normalizeGitUrl (host
// lowercased, default ssh port 22 omitted, trailing slash/.git stripped) —
// intentionally re-implemented here rather than imported, so this wrapper
// only needs a single file bound into the sandbox, not a module graph.
function normalizeHostPortPath(host, port, path) {
  if (!host || !path) return null;
  const h = host.toLowerCase();
  const p = path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
  if (!p) return null;
  const portSuffix = (port && port !== '22') ? `:${port}` : '';
  return `${h}${portSuffix}/${p}`;
}

function isAllowed(norm) {
  const allowlistPath = process.env.CCSANDBOX_GIT_ALLOWLIST;
  if (!allowlistPath || !norm) return false;
  try {
    const list = JSON.parse(fs.readFileSync(allowlistPath, 'utf-8'));
    return Array.isArray(list) && list.includes(norm);
  } catch {
    return false; // fail closed: unreadable/corrupt allow-list denies all
  }
}

function main() {
  const argv = process.argv.slice(2);
  const realSsh = process.env.CCSANDBOX_REAL_SSH;
  if (!realSsh) {
    process.stderr.write('sandbox: real ssh binary not configured (CCSANDBOX_REAL_SSH unset)\n');
    process.exit(127);
  }

  const { hostArg, commandArg, port } = parseSshArgv(argv);
  const repoPath = extractRepoPath(commandArg);

  if (hostArg && repoPath) {
    const host = hostArg.includes('@') ? hostArg.slice(hostArg.lastIndexOf('@') + 1) : hostArg;
    const norm = normalizeHostPortPath(host, port, repoPath);
    if (!isAllowed(norm)) {
      process.stderr.write(
        `sandbox: ssh git access to ${norm || `${host}/${repoPath}`} is not allow-listed for this session\n`,
      );
      process.exit(1);
    }
  }
  // Either not a git-smart-over-ssh invocation, or it was allow-listed:
  // exec the real ssh unchanged (agent forwarding etc. work as before), but
  // pin -F to our own config (see sandbox-ssh-config): root-owned files
  // under /etc/ssh map to nobody in this user namespace, so OpenSSH's
  // Include of the real /etc/ssh/ssh_config would otherwise fail with "Bad
  // owner or permissions", and ~/.ssh/config isn't exposed to the sandbox
  // anyway. Placed first so an explicit -F from the caller (there isn't
  // one from git) would still win.
  const sshConfig = process.env.CCSANDBOX_SSH_CONFIG;
  const fullArgv = sshConfig ? ['-F', sshConfig, ...argv] : argv;
  try {
    execFileSync(realSsh, fullArgv, { stdio: 'inherit' });
    process.exit(0);
  } catch (err) {
    process.exit(typeof err.status === 'number' ? err.status : 1);
  }
}

main();
