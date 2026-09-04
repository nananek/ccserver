import { readdir, mkdir, stat } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadSandboxConfig, installedApps } from '../ws/sandbox.js';
import { metaAgentEnabled, metaAgentDir } from '../ws/metaAgent.js';
import { resolvedHostname } from '../ws/notify.js';

const execFileAsync = promisify(execFile);

// Directory listing shared by GET /api/dirs and the meta agent's
// browse_directory tool (plan section 4.3): one implementation so the HTTP
// surface and the MCP surface can never disagree. Returns
// { ok:true, data } or { ok:false, code:'not-found'|'forbidden', message }.
export async function browseDirectory(requestedPath = '/', showHidden = false) {
  const absPath = resolve('/', requestedPath || '/');
  try {
    const entries = await readdir(absPath, { withFileTypes: true });

    const dirs = entries
      .filter((entry) => {
        if (!entry.isDirectory()) return false;
        if (!showHidden && entry.name.startsWith('.')) return false;
        return true;
      })
      .map((entry) => ({
        name: entry.name,
        path: join(absPath, entry.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const fileEntries = entries.filter((entry) => {
      if (!entry.isFile()) return false;
      if (!showHidden && entry.name.startsWith('.')) return false;
      return true;
    });

    const files = await Promise.all(
      fileEntries.map(async (entry) => {
        const filePath = join(absPath, entry.name);
        try {
          const st = await stat(filePath);
          return { name: entry.name, path: filePath, size: st.size, mtime: st.mtimeMs };
        } catch {
          return { name: entry.name, path: filePath, size: 0, mtime: 0 };
        }
      })
    );
    files.sort((a, b) => a.name.localeCompare(b.name));

    return {
      ok: true,
      data: {
        current: absPath,
        parent: absPath === '/' ? null : resolve(absPath, '..'),
        dirs,
        files,
      },
    };
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { ok: false, code: 'not-found', message: 'Directory not found' };
    }
    if (err.code === 'EACCES') {
      return { ok: false, code: 'forbidden', message: 'Permission denied' };
    }
    throw err;
  }
}

// Directory creation shared by POST /api/dirs and the meta agent's
// create_directory tool. Returns { ok:true, data } or
// { ok:false, code, message } with codes 'validation' | 'conflict' |
// 'forbidden' | 'not-found' | 'git-init-failed' | 'internal'.
export async function createDirectory({ parent, name, gitInit }) {
  if (!parent || !name) {
    return { ok: false, code: 'validation', message: 'parent and name are required' };
  }

  if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    return { ok: false, code: 'validation', message: 'Invalid folder name' };
  }

  const absParent = resolve('/', parent);
  const newPath = join(absParent, name);

  try {
    await mkdir(newPath);
  } catch (err) {
    if (err.code === 'EEXIST') {
      return { ok: false, code: 'conflict', message: 'Directory already exists' };
    }
    if (err.code === 'EACCES') {
      return { ok: false, code: 'forbidden', message: 'Permission denied' };
    }
    if (err.code === 'ENOENT') {
      return { ok: false, code: 'not-found', message: 'Parent directory not found' };
    }
    return { ok: false, code: 'internal', message: err.message };
  }

  // Optional git init (opt-in): the directory itself was created above and
  // is kept even when this fails -- only the error is surfaced, so the user
  // can retry `git init` manually. Fixed argv (no shell, no user-controlled
  // arguments), cwd pinned to the freshly created directory.
  if (gitInit === true) {
    try {
      await execFileAsync('git', ['init'], { cwd: newPath, timeout: 10000 });
    } catch (err) {
      const detail = err.code === 'ENOENT'
        ? 'git is not installed on this server'
        : (err.stderr && err.stderr.trim()) || err.message;
      return { ok: false, code: 'git-init-failed', message: `Directory created but git init failed: ${detail}`, data: { path: newPath } };
    }
  }

  return { ok: true, data: { path: newPath } };
}

export async function dirsRoute(fastify, opts) {
  fastify.get('/dirs/home', async () => {
    const { defaultApp, forceSandbox, showUsage, hiddenApps } = loadSandboxConfig();
    // hostname for the browser tab title ("<host> ccserver"): the same
    // resolution the notify footer uses, so the tab matches _from: <host>.
    // Extra field, so existing clients are unaffected.
    // showUsage / availableApps: the client's Usage button visibility and the
    // launch modal's app picker both need server-side facts -- whether the
    // Usage button is enabled in config, and which agent CLIs are installed
    // here. Both are extra fields, so existing clients are unaffected.
    // hiddenApps (issue #105): apps the operator hasn't contracted for --
    // every launch picker removes them entirely, unlike availableApps=false
    // (not installed), which still shows greyed out with a tooltip.
    // metaAgentEnabled: the launch modal's メタエージェント mode is disabled
    // (with an explanation) unless the privileged ccserver-meta feature is
    // explicitly opted into via sandbox.config.json. Extra field as well.
    return { home: homedir(), defaultApp, forceSandbox, hostname: resolvedHostname(), showUsage, availableApps: installedApps(), hiddenApps, metaAgentEnabled: metaAgentEnabled(), metaAgentDir: metaAgentDir() };
  });

  fastify.get('/dirs', async (request, reply) => {
    const res = await browseDirectory(request.query.path || '/', !!request.query.showHidden);
    if (!res.ok) {
      const status = res.code === 'not-found' ? 404 : res.code === 'forbidden' ? 403 : 500;
      return reply.code(status).send({ error: res.message });
    }
    return res.data;
  });

  fastify.post('/dirs', async (request, reply) => {
    const res = await createDirectory(request.body || {});
    if (!res.ok) {
      const status = res.code === 'validation' ? 400
        : res.code === 'conflict' ? 409
        : res.code === 'forbidden' ? 403
        : res.code === 'not-found' ? 404
        : res.code === 'git-init-failed' ? 500
        : 500;
      const payload = { error: res.message };
      if (res.data?.path) payload.path = res.data.path;
      return reply.code(status).send(payload);
    }
    return res.data;
  });
}
