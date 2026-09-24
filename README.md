# ccserver

**Languages:** [日本語](README.md) | [English](README.en.md) | [Français](README.fr.md)

> **Context & Coordination Server** — AI CLIセッションのコンテキスト管理とエージェント間連携を行う Web サーバー。

> **Note:** このプロジェクトは対応するAI CLIの各ベンダー・プロジェクトとは無関係の非公式サードパーティツールです。各ベンダー・プロジェクトによる公式サポートの対象外です。

ディレクトリを指定して複数の AI CLI ([Claude Code](https://docs.anthropic.com/en/docs/claude-code)、[opencode](https://opencode.ai/)、[GitHub Copilot CLI](https://github.com/github/copilot-cli)、[OpenAI Codex CLI](https://developers.openai.com/codex/cli/)、Command Code) を起動・管理する Web フロントエンド。VS Code のようにフォルダを選択し、ブラウザ内のターミナルで操作できます。

📖 **詳しいドキュメントは [ドキュメントサイト](https://nananek.github.io/ccserver/) を参照してください。**

## 主な機能

- 複数 AI CLI の統一管理 (Claude Code / opencode / GitHub Copilot CLI / OpenAI Codex CLI / Command Code) — [起動ガイド](https://nananek.github.io/ccserver/guides/launching/)
- `bwrap` + rootless docker によるプロジェクト単位の隔離サンドボックス実行 — [サンドボックス](https://nananek.github.io/ccserver/sandbox/overview/)
- 予約プロンプト (指定時刻・利用制限解除時刻に自動でプロンプトを投入) — [詳細](https://nananek.github.io/ccserver/guides/scheduled-prompts/)
- `ccserver-notify` MCP による Discord / webhook / Vikunja 通知 — [詳細](https://nananek.github.io/ccserver/guides/notify/)
- 使用量 (Usage) 表示 (Claude Code `/usage` / Codex レート制限) — [詳細](https://nananek.github.io/ccserver/guides/usage/)
- 拠点間 (federation) ペアリングによる複数インスタンスのリモート操作 — [詳細](https://nananek.github.io/ccserver/guides/federation/)
- 複数端末からのセッション共有 (PC とスマートフォンで同じセッションを同時操作、オプトイン) — [詳細](https://nananek.github.io/ccserver/guides/session-sharing/)
- オーケストレーター + 複数ワーカーの「コンボ起動」(ロール別 git worktree で並行作業) — [詳細](https://nananek.github.io/ccserver/guides/combo-launch/)

## アーキテクチャ

```
ブラウザ (xterm.js) <── WebSocket ──> Fastify <── node-pty ──> claude / opencode / copilot / codex / command-code CLI
                    <── HTTP REST ──>         (ディレクトリ一覧 API)
```

| レイヤー | 技術スタック |
|----------|-------------|
| Frontend | React 19 + Vite + xterm.js |
| Backend  | Node.js + Fastify + @fastify/websocket + node-pty |

## 必要な環境

- Node.js >= 22.13 / npm >= 9
  - CI が実際に検証しているのは **Node 22 / 24 / 26** です (22 = Maintenance LTS、24 = Active LTS、26 = Current。26 は 2026-10-28 に Active LTS になります)。`engines` に上限を置いていないのは、より新しい Node で `npm install` が警告を出す/止まるのを避けるためで、未検証のバージョンが動く保証ではありません。
- C++ コンパイラ (node-pty のビルドに必要。Arch: `base-devel`、Ubuntu: `build-essential`)
- 対応する AI CLI のいずれか 1 つ以上 (Claude Code / opencode / GitHub Copilot CLI / OpenAI Codex CLI / Command Code)。サーバーにインストールされている CLI だけを起動時に選べます。

詳細 (各 CLI のインストール方法・docker 利用時の追加パッケージ等) は [必要な環境](https://nananek.github.io/ccserver/getting-started/requirements/) を参照してください。

## クイックスタート

```bash
git clone <repo-url> ccserver
cd ccserver
npm install
```

**開発モード** (ターミナルを 2 つ開いて実行):

```bash
npm run dev:server   # バックエンド (port 3001)
npm run dev:client   # フロントエンド (port 5173)
```

ブラウザで http://localhost:5173 を開きます。

**本番モード**:

```bash
npm run build --workspace=client
NODE_ENV=production node server/index.js
```

ブラウザで http://localhost:3001 を開きます (ポートは `PORT` 環境変数で変更可能)。

常駐運用 (systemd) や Tailnet 内への HTTPS 公開 (Tailscale Serve) は [デプロイガイド](https://nananek.github.io/ccserver/deployment/systemd/) を参照してください。

## ドキュメント

インストール・起動オプション・各種 MCP ツール (notify / usage / meta)・federation・コンボ起動・サンドボックスの内部構成・API リファレンス・デプロイ手順など、詳細は [ドキュメントサイト](https://nananek.github.io/ccserver/) にまとまっています。

## ライセンス

MIT
