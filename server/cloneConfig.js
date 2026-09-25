// sandbox.config.json's "clone" block (#278): which hosts the Files screen's
// Clone may fetch from, and with which tool.
//
//   "clone": { "hosts": [ { "host": "github.com", "tool": "gh" },
//                         { "host": "gitea.example.org", "tool": "git" } ] }
//
// Absent (or `clone: null`) means the built-in default: github.com, cloned
// with `gh`. `hosts` is the COMPLETE list: it does not add to the default, so
// an operator can leave github.com out.
//
// Why it lives in the file and is read once (#230, docs-site
// reference/configuration-model): the list decides which servers this process
// will open a connection to, as the operator, with the operator's
// credentials. That is a value the safety of a running server depends on, so
// it comes from the operator's file, never from the client, and a change needs
// a restart (routes/git.js reads it once when the route is registered).
//
// Validation is strict and fails CLOSED. A present-but-unusable block does not
// fall back to the default and does not have its bad entries dropped:
//   - falling back to github.com would WIDEN a list that was meant to leave
//     github.com out;
//   - dropping one entry silently changes which tool a duplicate host gets and
//     hides the typo the operator most needs to see.
// Instead `error` says what is wrong and routes/git.js refuses to clone (503)
// until the file is fixed. Everything else about the server is unaffected.
//
// Host names: exact match, ASCII only, lower-cased. No port (a URL with a port
// is refused, so a listed host could never be used with one), no trailing dot
// (`gitea.example.org.` is a different string to credential helpers), no IDN
// (write the punycode `xn--` form: a Unicode host is never accepted from a URL,
// so no look-alike can match). `tool` is "gh" (GitHub / GitHub Enterprise
// Server: `gh repo clone`) or "git" (`git clone`, for Gitea and anything else).

export const CLONE_TOOLS = Object.freeze(['gh', 'git']);

export const DEFAULT_CLONE_HOSTS = Object.freeze([Object.freeze({ host: 'github.com', tool: 'gh' })]);

// RFC 1035 labels: 1-63 of [a-z0-9-], not starting or ending with '-'.
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOST_RE = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`);
const MAX_HOST_LENGTH = 253;

const HOST_HELP = 'must be a bare host name such as "git.example.org" (no scheme, port, path, userinfo or trailing dot)';

// -> { ok: true, host } | { ok: false, reason }
export function normalizeCloneHost(value) {
  if (typeof value !== 'string' || value === '') return { ok: false, reason: `must be a non-empty string; it ${HOST_HELP}` };
  if (/[^\x00-\x7f]/.test(value)) {
    return { ok: false, reason: 'must be ASCII; write an internationalized name in its punycode form (xn--...)' };
  }
  const host = value.toLowerCase();
  if (host.length > MAX_HOST_LENGTH || !HOST_RE.test(host)) return { ok: false, reason: HOST_HELP };
  return { ok: true, host };
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// raw: the parsed value of the file's "clone" key.
// -> { hosts: [{ host, tool }], error: string | null }
// On error, `hosts` is [] -- nothing is allowed -- and `error` is the reason.
export function normalizeCloneConfig(raw) {
  if (raw === undefined || raw === null) return { hosts: DEFAULT_CLONE_HOSTS, error: null };
  const bad = (reason) => ({ hosts: Object.freeze([]), error: `"clone" ${reason}` });

  if (!isPlainObject(raw)) return bad('must be an object such as { "hosts": [ { "host": "github.com", "tool": "gh" } ] }');
  for (const key of Object.keys(raw)) {
    if (key !== 'hosts') return bad(`has an unknown key "${key}" (the only key is "hosts")`);
  }
  if (raw.hosts === undefined) return { hosts: DEFAULT_CLONE_HOSTS, error: null };
  if (!Array.isArray(raw.hosts)) return bad('"hosts" must be an array');
  if (raw.hosts.length === 0) {
    return bad('"hosts" must list at least one host (omit "clone" to use the default, github.com)');
  }

  const seen = new Set();
  const hosts = [];
  for (const [i, entry] of raw.hosts.entries()) {
    const where = `"hosts"[${i}]`;
    if (!isPlainObject(entry)) return bad(`${where} must be an object { "host": ..., "tool": ... }`);
    for (const key of Object.keys(entry)) {
      if (key !== 'host' && key !== 'tool') return bad(`${where} has an unknown key "${key}" (the keys are "host" and "tool")`);
    }
    const host = normalizeCloneHost(entry.host);
    if (!host.ok) return bad(`${where}.host ${host.reason}`);
    if (!CLONE_TOOLS.includes(entry.tool)) return bad(`${where}.tool must be "gh" or "git"`);
    if (seen.has(host.host)) return bad(`${where}.host "${host.host}" is listed twice`);
    seen.add(host.host);
    hosts.push(Object.freeze({ host: host.host, tool: entry.tool }));
  }
  return { hosts: Object.freeze(hosts), error: null };
}
