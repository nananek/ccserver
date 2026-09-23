import { useState, useEffect, useCallback } from 'react';
import { authFetch, onSetupRequired } from '../auth.js';

// Shown when the server answers 503 {"code":"SETUP_REQUIRED"} -- this host's
// config and state have not been migrated to the XDG layout yet, and the
// wizard has to run from a shell on the host itself (issue #201 Step5).
// There is deliberately no button: the migration moves a live SQLite DB and
// must happen with the server stopped, which is not something a web page
// should be able to start.
//
// Two presentations, and picking the wrong one causes a real outage:
//
//   liveSessions === 0  ->  block the whole screen.
//   liveSessions  >  0  ->  a banner above <App/>, nothing blocked.
//
// Because DEFAULT_SESSION_TIMEOUT_MS is twelve hours (server/timeoutEnv.js),
// a full-screen block with sessions running means nobody can attach to them
// and they are silently reaped half a day later. An operator who carefully
// avoided restarting the server to protect those sessions would lose them
// to the UI instead. Enforcement does not depend on this choice anyway --
// the server's own 503 already refuses everything that would create new
// state, whichever way the client renders.
//
// Modelled on AuthGate.jsx, including the mistake its header documents at
// length: an earlier AuthGate awaited a round trip before rendering
// anything, which delayed DirectoryBrowser's mount by one request and made
// several e2e specs flaky (PR #154). So this gate does NOT await
// /api/setup-status before showing children. They mount on the first render
// exactly as before this feature existed; the gate appears only once a real
// request has come back 503. On a healthy server that never happens and
// this component costs one boolean.
export default function SetupGate({ children }) {
  const [needsSetup, setNeedsSetup] = useState(false);
  const [status, setStatus] = useState(null);

  const showGate = useCallback(() => setNeedsSetup(true), []);

  useEffect(() => {
    onSetupRequired(showGate);
  }, [showGate]);

  // Fetched only once the gate is already up -- never on the happy path,
  // where it would be pure overhead.
  useEffect(() => {
    if (!needsSetup) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const res = await authFetch('/api/setup-status');
        if (cancelled || !res.ok) return;
        setStatus(await res.json());
      } catch { /* the instructions stand on their own without it */ }
    })();
    return () => { cancelled = true; };
  }, [needsSetup]);

  if (!needsSetup) return children;

  // Until /api/setup-status answers we do not know whether sessions are
  // running, and blocking the screen on a guess is the harmful direction.
  // So: banner first, escalate to the full block only once the server has
  // actually said there are no live sessions.
  const blocking = status !== null && status.liveSessions === 0;

  if (!blocking) {
    return (
      <>
        <SetupBanner status={status} />
        {children}
      </>
    );
  }

  return (
    <div className="login-view">
      <div className="login-card setup-gate-card">
        <h1 className="login-title">ccserver</h1>
        <p className="login-subtitle">セットアップが完了していません</p>
        <SetupInstructions status={status} />
      </div>
    </div>
  );
}

function SetupBanner({ status }) {
  const [open, setOpen] = useState(false);
  const count = status?.liveSessions;
  return (
    <div className="setup-banner">
      <div className="setup-banner-row">
        <span className="setup-banner-text">
          セットアップが完了していません。新しいセッションやグループの作成はできません
          {count ? ` (実行中のセッション ${count} 件は操作できます)` : ''}。
          ホスト上で <code>npm run setup</code> を実行してください。
        </span>
        <button type="button" className="btn btn-secondary setup-banner-btn" onClick={() => setOpen((v) => !v)}>
          {open ? '閉じる' : '詳細'}
        </button>
      </div>
      {open && (
        <div className="setup-banner-details">
          <SetupInstructions status={status} />
        </div>
      )}
    </div>
  );
}

function SetupInstructions({ status }) {
  const pending = status?.pending || [];
  const kept = status?.kept || [];
  const warnings = status?.warnings || [];

  return (
    <>
      <p className="settings-hint">
        設定・状態ファイルの置き場が新しいレイアウト (XDG準拠) に移行されていません。
        このホストのシェルで以下を実行してください。移行はサーバーを停止した状態で行い、
        実行後にサーバーを再起動してください。
      </p>

      <pre className="setup-gate-commands">
{`cd <ccserverのディレクトリ>
npm run setup           # まず内容を確認 (ドライラン)
npm run setup -- --yes  # 実行
systemctl --user restart ccserver`}
      </pre>

      {warnings.length > 0 && (
        <>
          <h2 className="setup-gate-heading">警告</h2>
          <ul className="setup-gate-list">
            {warnings.map((w) => (
              <li key={w.id}><span className="settings-error">{w.message}</span></li>
            ))}
          </ul>
        </>
      )}

      {pending.length > 0 && (
        <>
          <h2 className="setup-gate-heading">移動されるもの ({pending.length})</h2>
          <ul className="setup-gate-list">
            {pending.map((item) => (
              <li key={item.id}>
                <span className="setup-gate-label">
                  [{item.kind}] {item.label}
                  {item.mode === 'copy-delete' && <em className="setup-gate-note"> (別FS: コピー＋削除)</em>}
                </span>
                <code className="setup-gate-path">{item.from}</code>
                <code className="setup-gate-path setup-gate-path-to">→ {item.to}</code>
              </li>
            ))}
          </ul>
        </>
      )}

      {kept.length > 0 && (
        <>
          <h2 className="setup-gate-heading">その場に残すもの ({kept.length})</h2>
          <p className="settings-hint">
            巨大 / 実行中の可能性があり、git worktree や永続HOMEに絶対パスが埋まっているため、
            旧位置を使い続けます。
          </p>
          <ul className="setup-gate-list">
            {kept.map((item) => (
              <li key={item.id}>
                <span className="setup-gate-label">{item.label}</span>
                <code className="setup-gate-path">{item.at}</code>
              </li>
            ))}
          </ul>
        </>
      )}

      {status && pending.length === 0 && kept.length === 0 && (
        <p className="settings-hint">
          移動が必要なファイルはありません。ウィザードを一度実行して完了を記録してください。
        </p>
      )}
    </>
  );
}
