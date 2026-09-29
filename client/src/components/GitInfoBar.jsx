import { useEffect, useState } from 'react';
import { authFetch } from '../auth.js';
import { displayPath } from '../displayPath.js';

// Read-only indicator for the directory the Files screen is showing (#278):
// the repository around it, its branch, and its remotes with the one git
// treats as the default. Data: GET /api/git/info (server/gitInfo.js).
//
// Everything here came out of a repository an agent may have written, so
// every value is rendered as a React text node -- never markup -- and the
// server has already dropped userinfo from URLs and control / bidi
// characters from names.
//
// It is supplementary: a failed request or a non-repository shows nothing at
// all rather than an error next to the directory list.

function defaultRemoteTitle(defaultRemote, head) {
  if (!defaultRemote) return '';
  if (defaultRemote.source === 'branch') {
    const branch = head?.kind === 'branch' ? head.name : '現在のブランチ';
    return `git の既定 remote: ${branch} の branch.<name>.remote`;
  }
  if (defaultRemote.source === 'pushDefault') return 'git の既定 remote: remote.pushDefault';
  return 'git の既定 remote: branch.<name>.remote も remote.pushDefault も無いため origin';
}

function branchLabel(head) {
  if (head?.kind === 'branch') return { text: head.name, detached: false, title: `ブランチ: ${head.name}` };
  if (head?.kind === 'detached') {
    return { text: `detached${head.commit ? ` @ ${head.commit}` : ''}`, detached: true, title: 'HEAD はブランチを指していません (detached)' };
  }
  return { text: 'ブランチ不明', detached: true, title: 'HEAD を読み取れませんでした' };
}

export default function GitInfoBar({ path, homeDir, reloadToken = 0 }) {
  // Keyed by the path it answers: switching directories hides the previous
  // repository at once, while a refresh (reloadToken) keeps showing the old
  // answer until the new one arrives instead of blinking.
  const [state, setState] = useState(null);

  useEffect(() => {
    if (!path) return undefined;
    let cancelled = false;
    const controller = new AbortController();
    (async () => {
      try {
        const res = await authFetch(`/api/git/info?path=${encodeURIComponent(path)}`, { signal: controller.signal });
        if (!res.ok) {
          if (!cancelled) setState({ path, data: null });
          return;
        }
        const data = await res.json();
        if (!cancelled) setState({ path, data });
      } catch {
        if (!cancelled) setState({ path, data: null });
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [path, reloadToken]);

  if (!state || state.path !== path || !state.data?.isRepo) return null;
  const info = state.data;
  const remotes = Array.isArray(info.remotes) ? info.remotes : [];
  const branch = branchLabel(info.head);
  const defaultMissing = info.defaultRemote && !remotes.some((r) => r.isDefault);

  return (
    <div className="git-info" data-testid="git-info" role="group" aria-label="Git repository">
      <div className="git-info-head">
        <span className="git-info-label">Git</span>
        <span className="git-info-root" data-testid="git-info-root" title={info.root}>{displayPath(info.root, homeDir)}</span>
        <span
          className={`git-info-branch${branch.detached ? ' is-detached' : ''}`}
          data-testid="git-info-branch"
          title={branch.title}
        >
          {branch.text}
        </span>
        {info.worktree && (
          <span className="git-info-badge" title="リンクされた worktree です (.git と remote は本体のリポジトリと共有)">worktree</span>
        )}
      </div>
      {remotes.length === 0 ? (
        <div className="git-info-note" data-testid="git-info-no-remote">remote はありません</div>
      ) : (
        <ul className="git-info-remotes" aria-label="Remotes">
          {remotes.map((r) => (
            <li
              key={r.name}
              className="git-info-remote"
              data-testid="git-info-remote"
              data-default={r.isDefault ? 'true' : 'false'}
            >
              <span className="git-info-remote-name">{r.name}</span>
              {r.isDefault && (
                <span className="git-info-default" title={defaultRemoteTitle(info.defaultRemote, info.head)}>既定</span>
              )}
              <span className="git-info-remote-url" title={r.url}>{r.url}</span>
              {r.pushUrl && (
                <span className="git-info-remote-push" title={r.pushUrl}>push: {r.pushUrl}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {defaultMissing && (
        <div className="git-info-note" data-testid="git-info-default-missing">
          git の既定 remote は「{info.defaultRemote.name}」ですが、その remote は設定されていません
        </div>
      )}
      {info.truncated && <div className="git-info-note">remote は先頭の 64 件だけ表示しています</div>}
      {info.configTooLarge && <div className="git-info-note">.git/config が大きすぎるため、remote を読み取っていません</div>}
      {info.configError && <div className="git-info-note">.git/config を読み取れませんでした</div>}
    </div>
  );
}
