---
title: 必要な環境
description: ccserver の実行に必要な環境と対応 AI CLI
---

- Node.js >= 22.13 / npm >= 9 (組み込みの `node:sqlite` を使用。サーバーは起動時に SQLite (`ccserver.sqlite3`) を open し、migration 失敗時は明示的なログとともに起動を拒否します)
- C++ コンパイラ (node-pty のビルドに必要。Arch: `base-devel`、Ubuntu: `build-essential`)
- 対応する AI CLI のいずれか 1 つ以上 — Claude Code、[opencode](https://opencode.ai/)、[GitHub Copilot CLI](https://github.com/github/copilot-cli) (`copilot`)、[OpenAI Codex CLI](https://developers.openai.com/codex/cli/) (`codex`) の各 CLI は個別に任意です。サーバーにインストールされている CLI だけを起動時に選べます。

## 各 CLI について

- **[Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)** — Usage 表示など、一部の機能で使用します。インストールされていない場合も、opencode や Copilot CLI だけで通常のセッションを利用できます。Usage ボタンは Codex CLI でも利用できます。
- **[opencode](https://opencode.ai/)** — インストール: [公式サイト](https://opencode.ai/)を参照。入れずに選んだ場合、ターミナルに `execvp(3) failed` 等のエラーが表示され起動に失敗します。
- **[GitHub Copilot CLI](https://github.com/github/copilot-cli)** (`copilot`) — インストール: `npm i -g @github/copilot` (またはインストールスクリプト / `brew install copilot-cli` / winget)。入れずに選んだ場合も同様に起動に失敗します。認証は初回 `/login` (OAuth) か環境変数 `GH_TOKEN` / `GITHUB_TOKEN` で行います。
- **[OpenAI Codex CLI](https://developers.openai.com/codex/cli/)** (`codex`) — OpenAI 公式手順でインストールします。新規起動は `codex`、モデルは `--model <model>`、再開は `codex resume <id>` または `codex resume --last` です。Usage 表示は `codex app-server` の JSON-RPC (`account/rateLimits/read`) を使用します。

docker を使うサンドボックス機能には追加のパッケージが必要です。詳細は [サンドボックス > 必要なもの](/ccserver/sandbox/overview/#必要なもの-docker-を使う場合) を参照してください。
