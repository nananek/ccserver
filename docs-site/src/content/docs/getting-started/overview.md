---
title: 概要
description: ccserver のアーキテクチャ概要
---

:::note
このプロジェクトは対応する AI CLI の各ベンダー・プロジェクトとは無関係の非公式サードパーティツールです。各ベンダー・プロジェクトによる公式サポートの対象外です。
:::

ディレクトリを指定して複数の AI CLI ([Claude Code](https://docs.anthropic.com/en/docs/claude-code)、[opencode](https://opencode.ai/)、[GitHub Copilot CLI](https://github.com/github/copilot-cli)、[OpenAI Codex CLI](https://developers.openai.com/codex/cli/)) を起動・管理する Web フロントエンドです。VS Code のようにフォルダを選択し、ブラウザ内のターミナルで操作できます。

## アーキテクチャ

```
ブラウザ (xterm.js) <── WebSocket ──> Fastify <── node-pty ──> claude / opencode / copilot / codex CLI
                    <── HTTP REST ──>         (ディレクトリ一覧 API)
```

| レイヤー | 技術スタック |
|----------|-------------|
| Frontend | React 19 + Vite + xterm.js |
| Backend  | Node.js + Fastify + @fastify/websocket + node-pty |

## 主な機能

- **複数 CLI の統一管理**: Claude Code / opencode / GitHub Copilot CLI / OpenAI Codex CLI をブラウザから起動・再開。
- **サンドボックス起動**: `bwrap` + rootless docker によるプロジェクト単位の隔離実行環境 (詳細は [サンドボックス](/ccserver/sandbox/overview/))。
- **予約プロンプト**: 指定時刻や利用制限の解除時刻に自動でプロンプトを投入 (詳細は [予約プロンプト](/ccserver/guides/scheduled-prompts/))。
- **通知 MCP (`ccserver-notify`)**: エージェントが自分で Discord / webhook / Vikunja へ通知できる MCP ツール (詳細は [通知と Vikunja 連携](/ccserver/guides/notify/))。
- **使用量 (Usage) 表示**: Claude Code の `/usage` や Codex のレート制限をブラウザから確認 (詳細は [使用量](/ccserver/guides/usage/))。
- **拠点間 (federation) ペアリング**: 複数の ccserver インスタンスを mTLS でペアリングし、別インスタンスのセッションをリモート操作 (詳細は [federation](/ccserver/guides/federation/))。
- **コンボ起動**: オーケストレーター + 複数ワーカーをロール別 git worktree で並行起動し、MCP 経由で連携 (詳細は [コンボ起動](/ccserver/guides/combo-launch/))。

次は [必要な環境](/ccserver/getting-started/requirements/) と [インストールと起動](/ccserver/getting-started/installation/) を参照してください。
