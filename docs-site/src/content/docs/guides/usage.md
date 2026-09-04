---
title: 使用量 (Usage)
description: Usage ボタンと ccserver-usage MCP による利用率確認
---

## Usage ボタン

画面上部タブバー右端の **Usage** ボタンから、Claude Code の `/usage` または Codex の利用率 (セッション/週次相当の利用率・リセット時刻・プラン) をポップオーバーで確認できます。ボタンには現在セッションの使用率と、現在表示中のアプリを示すバッジ (`(claude)` / `(codex)`) が常時表示されます (opencode / copilot セッションでは非表示)。ポップオーバーは**前回ポップオーバー内で選択したアプリをブラウザに記憶して**開きます (OpenCode などのターミナルを開き直しても表示は元に戻りません)。記憶がない初回のみアクティブなタブのアプリ (claude / codex) を既定とし、両方インストールされている場合はポップオーバー内の **Claude / Codex タブ** でいつでも切り替えられます (バッジも切り替えに追従します。記憶したアプリがアンインストールされた場合は、もう片方へ自動的にフォールバックします)。

- **Claude**: 裏側で `claude --ax-screen-reader` を短時間起動して `/usage` の描画をパースします (`/usage` の閲覧自体は API を消費しません)。
- **Codex**: `codex app-server` を起動し、JSON-RPC (`account/rateLimits/read`) でレート制限のスナップショットを直接取得します。TUI 描画のスクレイピングではないため、起動待ちやプロジェクト信頼ダイアログのハンドリングは不要です。
- どちらも結果を約 1 分キャッシュします。「更新」ボタンで即時に再取得できます。
- bwrap がある環境では、**該当 CLI の設定だけを見せる最小サンドボックス** (docker/gpg/ssh なし) で起動します。無ければ CLI を直接起動します。
- API: `GET /api/usage?app=claude|codex` (`&force=1` で強制再取得、`app` 省略時は `claude`)。サーバー起動時に両方のキャッシュを 1 度ウォームします。
- ボタンは設定ファイルの `showUsage: false` で非表示にできます。さらに **claude/codex のどちらもサーバーにインストールされていない環境では、設定に関わらず自動的に非表示**になります (この場合 `GET /api/usage` は `claude is not installed on this server` / `codex is not installed on this server` を返します)。片方だけインストールされている場合はボタンは表示され、ポップオーバー内のタブ切替はそのインストール済みの 1 つだけになります。

## ccserver-usage (使用量参照用 MCP)

エージェントが**自分で**上記の Usage スナップショットを読める MCP ツール `get_usage` を提供します。`ccserver-notify` とは独立した別の MCP サーバーで、`server/usage.js` の `getUsage()` (上記ボタンが叩くのと同じキャッシュ/キャプチャロジック) を同一プロセス内で直接呼ぶだけです (HTTP 経由ではありません)。

- **ツール**: `get_usage({ force?: boolean })` — `{ usage, updatedAt, cached, sandboxed?, error? }` を返します (`GET /api/usage` と同じ形)。`force: true` で強制再取得 (最大 15 秒程度かかることがあります)。
- **注入条件**: **`claude` セッションのみ** (`/usage` は Claude Code CLI 固有の機能のため opencode/copilot には注入されません)。シェルセッションには注入されません。`ccserver-notify` と異なり、コンボのワーカー/オーケストレーター/スタンドアロンは区別せず、対象となる claude セッション全てに注入されます。
- **オプトイン**: デフォルトでは注入されません。サーバーに claude バイナリがインストールされ、設定ファイルで `usageMcp: true` を明示した場合のみ注入されます。Usage ボタンの `showUsage` 設定とは独立しています。
- サンドボックス内外どちらでも動作します (サンドボックス内はソケットを bind、外はホストの node でブリッジを実行) — 仕組みは `ccserver-notify` と同じパターンですが、`get_usage` は接続元によらず同じ結果を返すため識別情報 (identity) は一切やり取りしません。
