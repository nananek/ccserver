---
title: プロジェクト構成
description: ccserver リポジトリのディレクトリ・主要ファイル一覧
---

```
ccserver/
├── package.json                    # npm workspaces ルート + playwright
├── playwright.config.js
├── docs/
│   └── ccserver.service
├── docs-site/                      # このドキュメントサイト (Astro + Starlight, 独立 package.json)
├── tests/
│   ├── close-confirm.spec.js       # Playwright E2E
│   ├── copilot-launch.spec.js      # copilot 起動 + コンボ拒否 (copilot 未インストール環境では skip)
│   ├── mobile-scroll.spec.js       # opencode TUI: タッチドラッグ→合成ホイールイベント (opencode 未インストール環境では skip)
│   └── scroll-buttons.spec.js      # opencode TUI: スクロールボタン→メッセージスクロールキー (同上)
├── server/
│   ├── package.json
│   ├── index.js                    # Fastify エントリポイント (トークン認証・静的配信含む)
│   ├── usage.js                    # `claude --ax-screen-reader` を叩いて /usage をパース・キャッシュ
│   ├── codexUsage.js               # `codex app-server` に JSON-RPC で account/rateLimits/read を投げてキャッシュ
│   ├── sandbox.config.example.json
│   ├── routes/
│   │   ├── dirs.js                 # GET/POST /api/dirs, GET /api/dirs/home
│   │   ├── sessions.js             # GET/POST/DELETE /api/sessions (POST は単発セッション新規起動)
│   │   ├── approvals.js            # GET /api/approvals, POST /api/approvals/:id/decision (メタエージェント承認)
│   │   ├── projects.js             # GET /api/projects, PUT /api/projects/:id/label
│   │   ├── launchPresets.js        # GET/POST/PUT/DELETE /api/launch-presets (コンボ起動プリセット)
│   │   ├── files.js                # GET/POST /api/files (アップロード/ダウンロード), GET /api/files/content (プレビュー)
│   │   ├── system.js               # GET /api/system-stats (CPU/メモリ/温度/GPU/IPMI/ストレージ)
│   │   └── usage.js                # GET /api/usage (?app=claude|codex)
│   └── ws/
│       ├── terminal.js             # WebSocket + node-pty ブリッジ (/ws/terminal)
│       ├── sessionManager.js       # セッション・予約プロンプトの状態管理/永続化
│       ├── appLaunch.js            # アプリ非依存の起動ロジック (resume引数・permission検出等)
│       ├── notify.js               # ccserver-notify: 購読レジストリ + Discord/webhook/Vikunja 配送 + MCP ソケット
│       ├── vikunjaClient.js        # notify.js から呼ばれる Vikunja タスク作成/更新クライアント
│       ├── usageMcp.js             # ccserver-usage: get_usage MCP ツール (server/usage.js の getUsage を直接呼ぶ)
│       ├── mcpConfig.js            # MCP 設定の生成 (ccserver / ccserver-notify / ccserver-usage / ccserver-meta、sandbox/host 両モード)
│       ├── mcpServer.js            # control / handoff / notify / usage / meta 各 MCP サーバー (SocketTransport 含む)
│       ├── mcpBroker.js            # Unix-socket MCP ブローカー (control/handoff はグループ毎、notify/usage/meta はプロセス毎 1 つ)
│       ├── mcpTools.js             # control/handoff ツールの実装 (deps 注入)
│       ├── metaTools.js            # メタエージェント用ツールの実装 (ワイヤ引数を信頼する、mcpTools とは別の信頼境界ファイル)
│       ├── metaAgent.js            # ccserver-meta: metaAgentMcp ゲーティング + プロセスグローバル MCP ソケット
│       ├── screenModel.js          # read_output 用の軽量仮想画面 (ANSI 解釈 + 変化検知)
│       ├── sandbox.js              # bwrap + rootless docker サンドボックス構築
│       ├── sandbox-entrypoint.sh
│       ├── sandbox-gh-wrapper.cjs         # サンドボックス内 gh をブローカー中継に差し替え
│       ├── sandbox-ssh-wrapper.cjs        # サンドボックス内 ssh を許可リストでゲート
│       ├── sandbox-git-credential-helper.cjs
│       ├── sandbox-mcp-wrapper.cjs        # MCP stdio ↔ Unix socket の中継 (argv 'notify'/'usage' でそれぞれのソケットへ)
│       ├── sandbox-gitconfig / sandbox-known-hosts / sandbox-ssh-config
│       ├── git-broker.js           # サンドボックス外で動く、リポジトリスコープの認証情報ブローカー
│       └── ghAllowlist.js / gitAllowlist.js  (+ 各 *.test.js, appLaunch.test.js, sandbox-resolve.test.js, notify.test.js, vikunjaClient.test.js)
└── client/
    ├── package.json
    ├── index.html
    ├── vite.config.js
    └── src/
        ├── main.jsx / App.jsx
        ├── auth.js                 # トークン認証 (CCSERVER_TOKEN)
        ├── themes.js
        ├── osc52.js                # OSC 52 クリップボード同期のパーサ (+ server/ws/osc52.test.js)
        ├── hooks/
        │   └── useNotifications.js
        ├── components/
        │   ├── DirectoryBrowser.jsx
        │   ├── TerminalView.jsx    # 遅延ロード (初期バンドル削減)
        │   ├── UsageButton.jsx
        │   ├── SystemMonitor.jsx
        │   └── ApprovalBanner.jsx  # メタエージェント承認待ちグローバルバナー (ポーリング)
        └── styles/
            └── app.css
```
