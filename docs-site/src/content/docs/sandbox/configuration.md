---
title: 設定ファイルと内部の仕組み
description: sandbox.config.json のキー一覧と、rootlesskit + bwrap + dockerd の内部構成
---

## 設定ファイル

サーバー全体の既定値です。各フラグは [起動ガイド](/ccserver/guides/launching/) のモーダルでディレクトリ/ブラウザ単位に上書きできるものと (`gpg`/`sshAgent`/`defaultApp`)、この設定ファイルでしか変えられないものがあります。

```bash
cp server/sandbox.config.example.json server/sandbox.config.json
# 場所を変える場合: CCSERVER_SANDBOX_CONFIG=/path/to/config.json
```

```json
{
  "docker": true,
  "gpg": true,
  "sshAgent": false,
  "gitBroker": true,
  "forceSandbox": false,
  "defaultApp": "claude",
  "showUsage": true,
  "usageMcp": false,
  "metaAgentMcp": false,
  "reviewerMcp": false,
  "notify": {
    "discordWebhook": "",
    "subscriptions": []
  },
  "binds": [],
  "env": {}
}
```

| キー | 既定 | 説明 |
|------|------|------|
| `docker` | `true` | サンドボックス内部で rootless dockerd を起動。`false` で無効 (軽量・rootlesskit 不要)。 |
| `persistentHome` | `true` | プロジェクト毎の永続 HOME を有効化 (詳細は [概要と永続 HOME](/ccserver/sandbox/overview/#サンドボックスの再利用-永続-home))。`false` で従来どおり毎回まっさらな tmpfs HOME。 |
| `gpg` | `false` | コミット署名用に gpg-agent を転送 ([認証情報の受け渡し](/ccserver/sandbox/credentials/) 参照)。UI で上書き可。 |
| `sshAgent` | `false` | ssh-agent を転送 (同上)。UI で上書き可。 |
| `gitBroker` | `true` | git/gh の認証情報スコープ制限 (同上)。 |
| `forceSandbox` | `false` | `true` でサンドボックス外の起動を全面禁止。エージェント・シェルを問わず全セッションがサンドボックス強制になり、UI のサンドボックス切替は無効化されます。bwrap が無い環境 (または Windows) では起動をエラーで拒否します (Claude の `/usage` / Codex のレート制限取得の直接起動フォールバックも同様に禁止)。ホストに bwrap (bubblewrap) のインストールが必須です。 |
| `defaultApp` | `"claude"` | 新規セッションの既定エージェント (`"claude"`、`"opencode"`、`"copilot"`)。UI で一度明示的に選んだ後はブラウザの記憶が優先され、この値は初回表示時の見た目とサーバー側フォールバック (予約プロンプトの自動再開など、クライアントが `app` を指定しない経路) にのみ使われます。**コンボ起動のメンバーには適用されません** (コンボのロール別選択は別途ブラウザの `localStorage` に記憶され、copilot はそもそも選択不可)。 |
| `showUsage` | `true` | タブバー右端の Usage ボタンを表示するか。`false` で非表示。**claude/codex のどちらもサーバーに無い場合は設定に関わらず自動的に非表示**になります (片方だけあればボタンは表示され、ポップオーバーはそのアプリのみ表示)。 |
| `usageMcp` | `false` | Claude セッションへ `ccserver-usage` MCP (`get_usage` ツール) を注入するか。安全のため既定はオフで、`true` の明示時だけ有効です。`showUsage` とは独立しています。 |
| `metaAgentMcp` | `false` | メタエージェント用 MCP (`ccserver-meta`) を有効化するか。`true` の明示時のみ、メタエージェントとして起動されたセッションへ注入されます ([メタエージェント](/ccserver/guides/meta-agent/) 参照)。全サーバーを操作できる特権ツールのため既定はオフです。 |
| `reviewerMcp` | `false` | コードレビュー用 MCP (`ccserver-reviewer`、`run_review`/`list_reviews`/`get_review`/`finish_review` ツール) を有効化するか。`true` の明示時、shell と copilot を除く全セッション (コンボのワーカーも含む、グループの有無は不問) へ注入されます。ローカルの任意 ref/ブランチ/PR/未コミット差分に対して使い捨ての git worktree 上でヘッドレスセッションを起動し `/code-review` を実行するため、既定はオフです。レビュージョブ自身のセッションには、このフラグの値に関わらず (ライブ編集で無効化された場合の完了検知破綻を防ぐため) `finish_review` を呼ぶための MCP が強制的に注入されます ([コードレビュー](/ccserver/guides/reviewer/) 参照)。 |
| `binds` | `[]` | 追加で見せるホストパス。各要素 `{ src, mode?, dest? }`。`mode` は `ro` (既定) か `rw`。存在しないパスはスキップ。`~/.ssh` と `~/.config/gh` は `gitBroker` の設定に関わらず常にブロックされます。 |
| `env` | `{}` | サンドボックス内の追加環境変数 (適用順は最後 = 既定値を上書き)。例: `sshAgent: true` のときに `SSH_AUTH_SOCK` を明示指定して自動検出を上書き。 |
| `claudeBin` | 自動検出 | claude/opencode/copilot の起動方法。`claude` を PATH から解決し、ラッパー (例: `/usr/bin/claude` → `/opt/claude-code/bin/claude`) の場合は実体のインストール先を辿ってサンドボックスへ自動的に公開します。opencode は PATH に加えて `~/.opencode/bin` も自動探索。copilot は PATH (SANDBOX_PATH) で自動解決されます (通常 `~/.local/bin/copilot`)。自動検出で外れる場所にある場合や特定ビルドに固定したい場合のみ絶対パスで指定 (環境変数 `CCSERVER_CLAUDE_BIN` が優先。copilot に個別の bin 設定はありません)。 |
| `notify` | `{}` | 通知用 MCP (ccserver-notify) の設定 ([通知と Vikunja 連携](/ccserver/guides/notify/) 参照)。`discordWebhook` は https のみ (非 https は無視)、`subscriptions` は初期購読 (https のみ)。`CCSERVER_DISCORD_WEBHOOK` 環境変数で discordWebhook を上書き可。`vikunja` は Vikunja タスク連携の設定 (`baseUrl`+`apiToken` で有効化)。 |
| `federation` | `{}` | 拠点間ペアリング ([federation](/ccserver/guides/federation/) 参照) の設定。`requireTokenForPairing: true` でペアリング開始リクエストに `CCSERVER_TOKEN` の提示を必須化 (既定 `false`)。機能自体の有効/無効は `CCSERVER_FEDERATION_PORT` 環境変数で制御し、ここでは切り替えられません。 |

## 内部の仕組み (docker と gpg の両立)

```
ccserver → rootlesskit (subuid userns + slirp4netns) → bwrap (FS制限) → dockerd + claude/opencode
```

rootless docker には subuid マッピング付き userns が要るため、外側を `rootlesskit`、内側で `bwrap` が FS を制限します (この順序でないと `newuidmap` が使えずマルチ uid が壊れます)。`/run` は **bwrap が専用 tmpfs で用意**し (rootlesskit の `--copy-up=/run` は使わない)、ホストの生ソケットを bind ソースとして活かします。gpg は userns 内で uid 0 のため socketdir が `~/.gnupg` になる点を利用し、生ソケットをそこへ転送しています。`docker run -v ...` でもサンドボックス外へは到達できません (daemon 自身が制限 FS 内)。
