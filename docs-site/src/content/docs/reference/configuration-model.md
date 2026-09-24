---
title: 設定モデル (動的設定と静的設定)
description: ccserver の設定が「Web UI から変えられるもの」と「ファイルを編集して再起動が必要なもの」に分かれている理由と、設定・状態ファイルの置き場所の一覧。
---

ccserver の設定は 2 種類あります。どちらに属するかは好みではなく、**判定基準**で決まります。

## 原則

> Web UI から変更でき再起動なしで反映される設定は SQLite の `settings` テーブルに置く。
> プロセス起動時に一度だけ読まれ、変更に再起動を要する設定 — とくにセキュリティ境界
> (`browseRoots` / `forceSandbox` / `hiddenApps`) — は
> `sandbox.config.json` に置く。
>
> **判定基準は「実行中のセッションの安全性がその値に依存するか」。依存するなら静的。**

最後の一文が実用的な部分です。たとえば `browseRoots` を動的にしてはいけない理由は「まだ実装していないから」ではありません。実行中サンドボックスの bind マウントは**起動時点の** `browseRoots` から計算済みなので、動的に変えられるようにすると、UI が表示している値と実際に動いているサンドボックスが守っている値が食い違います。

| | 動的設定 | 静的設定 |
|---|---|---|
| 置き場所 | SQLite の `settings` テーブル | `~/.config/ccserver/sandbox.config.json` |
| 変更方法 | Web UI の設定タブ | テキストエディタ |
| 反映 | 即時 | **ccserver の再起動が必要** |
| 例 | ワーカープリセット、起動プリセット、ペアリング済みインスタンス、パスキー、GPG Vault | `docker` / `persistentHome` / `gpg` / `sshAgent` / `gpgVault` / `browseRoots` / `hiddenApps` / `reviewerMcp` / `usageMcp` |

### 現時点での既知の例外

**ネットワーク隔離 (network allowlist)** は Web UI に設定タブを持ちながら、保存先が `sandbox.config.json` です (`server/ws/networkAllowlist.js` が JSON を read-modify-write しています)。これは原則に反しており、[#205](https://github.com/nananek/ccserver/issues/205) で `settings` テーブルへ移す予定です。

### `gpg` という名前の紛らわしさ

名前が似ていますが**別の概念**です。混同しないでください。

- `sandbox.config.json` の `gpg` / `gpgVault` — ホストの gpg-agent や Vault をサンドボックスへ**転送するかどうか**の on/off。静的設定。
- Web UI の「GPG連携」タブ — **Vault 自体**のセットアップとロック管理 (鍵の生成、パスキーによるアンロック、削除)。動的。

## ファイルの置き場所

ccserver は [XDG Base Directory 仕様](https://specifications.freedesktop.org/basedir-spec/latest/) に従います。`$XDG_CONFIG_HOME` / `$XDG_DATA_HOME` / `$XDG_STATE_HOME` が設定されていればそれを、未設定なら `~/.config` / `~/.local/share` / `~/.local/state` を使います。

**macOS でも同じレイアウトを使います。** `~/Library/Application Support/ccserver` は使いません。理由は3つあります。

1. `$XDG_*` が設定されていればそちらを優先するため、設定している macOS ユーザーの意図を無視しないこと。ccserver 自身、サンドボックスへ opencode の設定を渡すのに `XDG_CONFIG_HOME` / `XDG_DATA_HOME` / `XDG_STATE_HOME` を使っています。
2. ccserver は端末から操作する常駐開発サービスで、`~/.config` は macOS でも git / gh / claude / codex といった近隣ツールが状態を置く場所です。`~/Library/Application Support` は GUI アプリの置き場です。
3. レイアウトが1つなら、移行手順もドキュメントもエラーメッセージ中のパスも1組で済みます。

プラットフォーム分岐が必要な箇所では ccserver も分岐しています (例: macOS には `/run/user` が無いため、git-broker のランタイムディレクトリは `/tmp` 配下へフォールバックします)。`~/.config` と `~/.local` にはそうした事情がありません。

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

### サーバーの停止・再起動

移行はサーバーを停止した状態で行ってください。ウィザードは移行前にポートへ接続して稼働中かどうかを確認し、応答があれば `--force` を要求します。

停止・起動の方法は常駐のさせ方によります。

| 起動方法 | 停止 | 起動 |
|---|---|---|
| systemd (user service) | `systemctl --user stop ccserver` | `systemctl --user start ccserver` |
| launchd (macOS) | `launchctl unload ~/Library/LaunchAgents/<plist>` | `launchctl load ~/Library/LaunchAgents/<plist>` |
| tmux / 手動 | そのプロセスで Ctrl-C | `NODE_ENV=production node server/index.js` |

どれか分からない場合は、待ち受けているプロセスを直接特定できます (macOS / Linux 共通)。

```bash
lsof -nP -iTCP:3001 -sTCP:LISTEN     # PORT を変えている場合はその番号
kill <PID>
```

ウィザードとセットアップ画面の案内も同じ表を出します。

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

## 移行を取り消す

移行は一方向ですが、**元に戻せます**。`layoutVersion()` は `<configRoot>/layout.json` (マーカー) の有無だけで決まり、マーカーが無ければ `resolvePath()` は移行前とバイト単位で同じ旧パスを返すためです。したがって「ファイルを旧位置へ戻す」＋「マーカーを消す」で移行前の状態に戻ります。

以下は使い捨ての HOME で実際に通した手順です (旧レイアウト作成 → 移行 → 取り消し → 起動確認)。

### 手順

1. **サーバーを停止します** (上表のとおり)。

2. **何が動いたかをマーカーで確認します。** `migrated[]` が移動したエントリ、`kept[]` が旧位置に残したもの、`skipped[]` が env var で触らなかったものです。

   ```bash
   cat ~/.config/ccserver/layout.json
   ```

3. **ファイルを旧位置へ戻します。** 移行先 → 旧位置の対応は「ファイルの置き場所」の表のとおりです。SQLite は `-wal` / `-shm` を**必ず一緒に**戻してください (本体だけ戻すと、WAL に残ったコミットが失われます)。

   ```bash
   LEG=~/.local/share/ccserver-sandbox
   CO=<ccserver のチェックアウト>

   mkdir -p "$LEG"
   mv ~/.local/share/ccserver/ccserver.sqlite3      "$LEG/"
   mv ~/.local/share/ccserver/ccserver.sqlite3-wal  "$LEG/"   # あれば
   mv ~/.local/share/ccserver/ccserver.sqlite3-shm  "$LEG/"   # あれば
   mv ~/.local/share/ccserver/federation            "$LEG/"
   mv ~/.local/share/ccserver/group-files           "$LEG/"
   mv ~/.config/ccserver/sandbox.config.json        "$CO/server/"
   for n in saved-sessions scheduled-prompts saved-groups saved-group-docs \
            saved-group-files saved-notifications saved-vikunja-tasks; do
     [ -f ~/.local/state/ccserver/$n.json ] && mv ~/.local/state/ccserver/$n.json "$CO/.$n.json"
   done
   ```

4. **マーカーを消します。** これで `layoutVersion()` が 1 に戻ります。

   ```bash
   rm ~/.config/ccserver/layout.json
   ```

5. **パンくずを消します。** 移行を取り消したのに「XDG へ移動しました」と書いたファイルが残っていると、次に探す人を誤らせます。

   ```bash
   rm -f "$LEG/MOVED-TO-XDG.txt" "$CO/.ccserver-state-moved.txt"
   ```

6. **起動します。** `npm run setup` (ドライラン) を実行すると、移行前と同じプランが再び表示されるはずです。

### 実測で確認したこと

使い捨て HOME + 使い捨てチェックアウトで一周させた結果:

- 対象 15 ファイルが**内容 (sha256) まで完全に一致**して旧位置へ戻った
- `layoutVersion()` が 1、`resolvePath('db')` が `~/.local/share/ccserver-sandbox/ccserver.sqlite3` に戻った
- サーバーが起動し、**戻した DB を開いた**。行データも `PRAGMA user_version` も保たれていた
- `/api/setup-status` が `setupRequired: true` に戻り、セットアップゲートが再び有効になった (`POST /api/sessions` → 503、`GET` → 200)
- `migrateLegacyDbFile()` の「旧々 → 旧」ホップは**再発火しません**。旧位置に DB がある場合は早期 return します (チェックアウトの親に古い `ccserver.sqlite3` を置いた状態でも、警告を出すだけで両方そのまま残ることを確認)

### 戻らないもの (重要)

**「全部元どおり」ではありません。** 以下は上の手順では戻りません。

1. **パーミッション。** ウィザードは移行時に設定・状態ファイルを `0600` に絞ります。`mv` はモードを保ったまま戻すので、**移行前に `0644` だったファイルは `0600` で戻ります** (実測)。より厳しい方向なので安全ですが、元のモードが必要なら `chmod` してください。
2. **移行後に書かれたデータ。** 移行は**コピーではなく移動**です。移行後にサーバーを動かしていれば、戻すのは「その時点の最新データ」であって「移行前のスナップショット」ではありません。移行前の状態が必要ならバックアップから復元してください。
3. **DB のスキーマ。** マイグレーションは前方向のみです (`migrate()` は `version <= current` をスキップします)。新しいコードで一度起動した DB はスキーマが上がったままで、パスを戻してもスキーマは戻りません。
4. **`--move-large` で動かした巨大ツリー。** `home/` `worktrees/` `review-worktrees/` `orchestrator/` `dind/` を `--move-large` で移動していた場合、戻すときも git worktree の絶対パスが壊れるため、各リポジトリで `git worktree repair` が再度必要です。既定ではこれらは移動しない (`kept[]` に記録される) ので、その場合は何もする必要はありません。
5. **空のディレクトリ。** `~/.config/ccserver` などは空のまま残ります。無害なので放置して構いません。

### なぜ `npm run setup --undo` が無いのか

自動化していないのは意図的です。逆方向の移動は前方向と同じ難しさ (サイドカー、both-present、sticky、マーカーの原子性、失敗時のロールバック) をすべて持ちますが、さらに**移行後に新旧どちらにもファイルがありうる**という前方向には無い問題が加わります (古いブランチで一度起動すると旧位置に `.saved-groups.json` が再生成されます)。どちらを採用するかは機械が決めてよい判断ではありません。マーカーの `migrated[]` に何が動いたかが記録されているので、上の手順は機械的に追えます。
