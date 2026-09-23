---
title: 設定モデル (動的設定と静的設定)
description: ccserver の設定が「Web UI から変えられるもの」と「ファイルを編集して再起動が必要なもの」に分かれている理由と、設定・状態ファイルの置き場所の一覧。
---

ccserver の設定は 2 種類あります。どちらに属するかは好みではなく、**判定基準**で決まります。

## 原則

> Web UI から変更でき再起動なしで反映される設定は SQLite の `settings` テーブルに置く。
> プロセス起動時に一度だけ読まれ、変更に再起動を要する設定 — とくにセキュリティ境界
> (`browseRoots` / `forceSandbox` / `allowUnsandboxedAgents` / `hiddenApps`) — は
> `sandbox.config.json` に置く。
>
> **判定基準は「実行中のセッションの安全性がその値に依存するか」。依存するなら静的。**

最後の一文が実用的な部分です。たとえば `browseRoots` を動的にしてはいけない理由は「まだ実装していないから」ではありません。実行中サンドボックスの bind マウントは**起動時点の** `browseRoots` から計算済みなので、動的に変えられるようにすると、UI が表示している値と実際に動いているサンドボックスが守っている値が食い違います。

| | 動的設定 | 静的設定 |
|---|---|---|
| 置き場所 | SQLite の `settings` テーブル | `~/.config/ccserver/sandbox.config.json` |
| 変更方法 | Web UI の設定タブ | テキストエディタ |
| 反映 | 即時 | **ccserver の再起動が必要** |
| 例 | ワーカープリセット、起動プリセット、ペアリング済みインスタンス、パスキー、GPG Vault | `docker` / `persistentHome` / `gpg` / `sshAgent` / `gpgVault` / `browseRoots` / `hiddenApps` / `allowUnsandboxedAgents` / `reviewerMcp` / `usageMcp` |

### 現時点での既知の例外

**ネットワーク隔離 (network allowlist)** は Web UI に設定タブを持ちながら、保存先が `sandbox.config.json` です (`server/ws/networkAllowlist.js` が JSON を read-modify-write しています)。これは原則に反しており、[#205](https://github.com/nananek/ccserver/issues/205) で `settings` テーブルへ移す予定です。

### `gpg` という名前の紛らわしさ

名前が似ていますが**別の概念**です。混同しないでください。

- `sandbox.config.json` の `gpg` / `gpgVault` — ホストの gpg-agent や Vault をサンドボックスへ**転送するかどうか**の on/off。静的設定。
- Web UI の「GPG連携」タブ — **Vault 自体**のセットアップとロック管理 (鍵の生成、パスキーによるアンロック、削除)。動的。

## ファイルの置き場所

ccserver は [XDG Base Directory 仕様](https://specifications.freedesktop.org/basedir-spec/latest/) に従います。`$XDG_CONFIG_HOME` / `$XDG_DATA_HOME` / `$XDG_STATE_HOME` が設定されていればそれを、未設定なら `~/.config` / `~/.local/share` / `~/.local/state` を使います。

```
~/.config/ccserver/
  sandbox.config.json        静的設定
  layout.json                セットアップ完了マーカー (後述)
~/.local/share/ccserver/
  ccserver.sqlite3           アプリ全体のDB (+ -wal / -shm)
  federation/                拠点間接続の mTLS 鍵・証明書
  group-files/               グループ共有ファイルの実体
  orchestrator-generated/    生成されたオーケストレータ指示ファイル
  usage-cwd/                 使用量取得用の空ディレクトリ
  codex-usage-cwd/           同上 (Codex)
~/.local/state/ccserver/
  saved-sessions.json        セッション
  scheduled-prompts.json     予約プロンプト
  saved-groups.json          グループ
  saved-group-docs.json      グループ文書
  saved-group-files.json     グループファイルのマニフェスト
  saved-notifications.json   通知購読
  saved-vikunja-tasks.json   Vikunja タスク対応表
```

### 既定では移動しないもの

サンドボックスのスクラッチ領域は `~/.local/share/ccserver-sandbox/` に残ります。

```
~/.local/share/ccserver-sandbox/
  home/                      プロジェクトごとの永続 HOME
  worktrees/                 コンボワーカーの git worktree
  review-worktrees/          コードレビュー用の git worktree
  orchestrator/              オーケストレータの作業ディレクトリ
  dind/                      サンドボックス内 docker のデータルート
```

移動しない理由は、どれか一つで十分です。

1. **`git worktree` の gitdir ポインタは絶対パス**です。各 worktree の `.git` ファイルと、元リポジトリ側の `.git/worktrees/<name>/gitdir` が互いを絶対パスで参照しています。移動すると両方向が壊れ、修復には**リポジトリごとに** `git worktree repair` を走らせる必要があります。壊れた worktree は「ディスクから消えた」と判定されて作り直されるため、**コンボワーカーの未コミット作業が失われます**。
2. `dind/` は稼働中の rootless dockerd が flock を保持している docker データルートです。足元から動かすのは未定義動作で、しかも数 GB あります。
3. `home/` の永続 HOME には絶対パスが大量に埋まっています (`.mcp.json`、virtualenv、`node_modules/.bin` のシム、pip の RECORD、`~/.gitconfig` の `includeIf`)。
4. サイズ。`~/.local` が別マウントなら実コピーになります。

実際に移動したい場合は `npm run setup -- --yes --move-large` を使います。移動後、影響を受けた各リポジトリで `git worktree repair` が必要です。

### 環境変数による上書き

すべてのパスは環境変数で個別に上書きできます。**上書きが設定されているパスはセットアップウィザードの移行対象になりません** (設定した意図を尊重します)。

| 環境変数 | 対象 |
|---|---|
| `CCSERVER_SANDBOX_CONFIG` | `sandbox.config.json` |
| `CCSERVER_DB_PATH` | `ccserver.sqlite3` |
| `CCSERVER_FEDERATION_HOME` | `federation/` |
| `CCSERVER_GROUP_FILES_ROOT` | `group-files/` |
| `CCSERVER_ORCHESTRATOR_GENERATED_ROOT` | `orchestrator-generated/` |
| `CCSERVER_USAGE_CWD` | `usage-cwd/` |
| `CCSERVER_CODEX_USAGE_CWD` | `codex-usage-cwd/` |
| `CCSERVER_SAVED_SESSIONS_PATH` | `saved-sessions.json` |
| `CCSERVER_SCHEDULES_PATH` | `scheduled-prompts.json` |
| `CCSERVER_GROUPS_PATH` | `saved-groups.json` |
| `CCSERVER_GROUP_DOCS_PATH` | `saved-group-docs.json` |
| `CCSERVER_GROUP_FILES_PATH` | `saved-group-files.json` |
| `CCSERVER_NOTIFY_PATH` | `saved-notifications.json` |
| `CCSERVER_VIKUNJA_TASKS_PATH` | `saved-vikunja-tasks.json` |
| `CCSERVER_SANDBOX_HOME_ROOT` | `home/` |
| `CCSERVER_WORKTREE_ROOT` | `worktrees/` |
| `CCSERVER_REVIEW_WORKTREE_ROOT` | `review-worktrees/` |
| `CCSERVER_ORCHESTRATOR_ROOT` | `orchestrator/` |
| `CCSERVER_SANDBOX_DIND_ROOT` | `dind/` |

`browseRoots` を設定している場合、これらのパスが `browseRoots` の中に入っていると ccserver は**起動を拒否します** (`/api/files` や `/api/dirs` から DB や federation の秘密鍵がダウンロードできてしまうため)。エラーメッセージが該当するパスと上書き用の環境変数を示します。

## セットアップウィザード

配置の切り替えは `~/.config/ccserver/layout.json` というマーカーファイルで管理されています。**このファイルが無い間、ccserver は移行前とまったく同じパスを参照します。** コードを更新しただけでは何も動きません。

移行はオペレータが明示的に実行します。

```bash
npm run setup           # ドライラン: 何がどこへ移動するか表示 (何も変更しない)
npm run setup -- --yes  # 実行
```

| フラグ | 意味 |
|---|---|
| (なし) | ドライラン |
| `--yes` | 実行してマーカーを書き込む |
| `--move-large` | スクラッチ領域も移動する (前述の注意を読んでから) |
| `--seed-example` | `sandbox.config.json` を `sandbox.config.example.json` の全文から生成する |
| `--force` | サーバー稼働中でも実行する |
| `--json` | 機械可読なプランを出力する |

**サーバーを停止してから実行してください。** 稼働中のサーバーは DB を開いたまま状態ファイルを毎回パスから読み直すため、その下で移行するとどちらのレイアウトにも状態が半分ずつ残ります。ウィザードは稼働中のサーバーを検出して中断します (`--force` で無視可)。

ウィザードを一度実行するまで、Web UI は新しいセッションやグループの**作成**を拒否します (実行中セッションの閲覧と再アタッチは可能です)。

:::caution
移行後は、必ず新しいレイアウトに対応したコードで起動してください。古いブランチの checkout は旧パスを参照するため、**空の状態で起動します**。
:::

### 新規インストール

新規インストールでもウィザードの実行が必要です。サーバーが起動時に勝手に `layout.json` を書くことはしません — 配置の決定は不可逆であり、オペレータの明示的な操作であるべきだからです。

ウィザードが生成する `sandbox.config.json` は、コメント 1 行だけの**最小ファイル**です。`sandbox.config.example.json` をそのままコピーすると `"gpg": true` が含まれるため、ホストの gpg-agent と `~/.gnupg` のサンドボックスへの転送が**黙って有効になってしまう**ためです。全キーの解説が欲しい場合は `--seed-example` を使うか、`server/sandbox.config.example.json` を参照してください。

### 開発・テスト時の注意

`npm test` / `npm run test:e2e` はセットアップウィザードを実際に `--yes` で実行するテストを含みます。ウィザードが探す移行元 (`~/.local/share/ccserver-sandbox`) は `$XDG_DATA_HOME` ではなく **`$HOME` 基準**なので (旧コードがそうハードコードしていたため意図的にそうしています)、`$HOME` を隔離しないままテストを走らせると本物のデータが移動・削除されます。

- リポジトリのテストは `server/testIsolation.js` 経由で `$HOME` と XDG 3 本を一時ディレクトリへ向け、そうなっていなければ**テストを失敗させて中断**します。そのまま実行する分には安全です。
- ウィザードを手で叩いて動作確認する場合は、必ず `HOME` も一時ディレクトリへ向けてください。

```bash
T=$(mktemp -d)
env HOME=$T/home XDG_CONFIG_HOME=$T/config XDG_DATA_HOME=$T/data XDG_STATE_HOME=$T/state \
    node server/cli/setup.js
```

**本番ホストのチェックアウト上でテストスイートを実行しないでください。** ccserver は systemd 常駐での運用を想定しており、その前提の下ではテスト実行が移行操作と見分けがつきません。

### 複数インスタンス

同一ホストで 2 つの ccserver を動かす場合、`$XDG_CONFIG_HOME` を共有しているとマーカーも共有されます。環境変数による上書きはレイアウトより優先されるので実害はありませんが、2 つ目のインスタンスを旧解決に固定したい場合は `CCSERVER_LAYOUT=legacy` を指定してください (`CCSERVER_LAYOUT=xdg` で逆も可能です)。
