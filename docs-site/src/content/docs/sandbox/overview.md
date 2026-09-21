---
title: 概要と永続 HOME
description: bwrap + rootless docker によるサンドボックスの仕組み、永続 HOME、設定ページ
---

「🔒 サンドボックスで起動」([起動ガイド](/ccserver/guides/launching/) 参照) を選ぶと、`bwrap` でファイルシステムを制限した状態で起動します。選択したプロジェクトと最小限の設定 (`~/.claude`, `~/.claude.json`, `~/.config/opencode`, `~/.local/share/opencode`, `~/.local/state/opencode`, `~/.config/github-copilot`, `~/.copilot` 等) だけが見え、**隣接する他プロジェクトは見えません**。

docker も安全に使えるよう、サンドボックス**内部**に rootless dockerd を起動します。`rootlesskit` (subuid マッピング) の内側で `bwrap` を動かす構成のため、`docker run -v ...` でもサンドボックス外へは到達できません (daemon 自身が制限された FS の中にいるため)。

macOS では `sandbox-exec` (Seatbelt) バックエンドでサンドボックスが動作します。deny-by-default のファイルポリシーによる隔離のため、bwrap のマウント隔離より弱い点に注意してください: ホストの `/tmp` は共有されます (bwrap の tmpfs 隔離なし)。ユーザーの `~/Library/Caches`・`~/Library/Application Support` 等は `CFFIXED_USER_HOME` をサンドボックス HOME に向けることで隔離されます (CoreFoundation は `~/Library` を `$HOME` ではなく `getpwuid` から解決するため、この上書きが無いと Objective-C/Swift 製ツールがホストのキャッシュを読み書きしてしまう。Xcode/SwiftPM 重めのワークフローでホストの DerivedData/パッケージキャッシュが必要な場合は operator の bind で明示的に足す)。さらに macOS では `/var` (`/private/var`) と `/Library` のシステムツリー全体が、実行ユーザーの権限で読める範囲で可視です (bwrap ではマウント隔離により sandbox 内に存在しません): admin が読める `/var/log`、同一 UID の他アプリの `/var/folders` 配下、`/Library/Application Support` 等が読めます。ネットワーク egress は開放されます (エージェント API・git・ツール取得のため)。プロセス実行自体はホストと同等に開放されていますが、エージェントに用途のない macOS 固有の GUI/IPC 経路 (osascript による AppleScript 自動化、pbcopy/pbpaste によるクリップボード経由の持ち出し、open によるアプリ起動、screencapture) は明示的に deny しています。`mach-lookup` は無制限のため、TCC 付与環境での Mach 経由の経路までは閉じていません。`sysctl-read` は**全面許可していません**。`(deny default)` + ツールチェインが読む非機微なノードだけの allow-list (macOS 自身の `container.sb` に倣った `hw.*` / `machdep.*` / `vm.*` / `kern.os*` / 各種上限値など) で、Seatbelt が実際に仲介する sysctl-read の情報漏洩は塞げます (macOS 14 実機で確認: `kern.bootargs` / `kern.osvariant_status` / `hw.ephemeral_storage` 等の読み取りは拒否)。`kern.proc*` も allow-list に含めないため **`ps`** (KERN_PROC を sysctl 経由で辿る) は拒否されます。ただしこれは**プロセス一覧の隔離ではありません**: `pgrep` や `proc_listpids()` / libproc を使うものは同一 UID の全 pid を列挙できます (macOS 14.8.5 で確認: `pgrep -l .` がサンドボックス内で全プロセステーブルを列挙)。

**既知の限界 — `KERN_PROCARGS2`:** 数値 MIB `{CTL_KERN, KERN_PROCARGS2, pid}` 経由での**同一 UID プロセスの argv と環境変数の読み取りは、Seatbelt では塞げません**。macOS 14.8.5 arm64 で検証済み: `(deny default)` (sysctl-read) も `(deny sysctl-read (sysctl-name ...))` / `(deny sysctl*)` / `(deny system-info)` / `(deny process-info*)` も**この経路に一切効果がなく**、数値 MIB の procargs 読み取りは現行 macOS では Seatbelt の仲介対象そのものではありません (別 UID はカーネルが弾く)。つまりサンドボックス内エージェントは、ccserver 本体の環境 (`CCSERVER_TOKEN` / `ANTHROPIC_API_KEY` / cloud creds)、他エージェントセッションの環境 (その `CCSANDBOX_GIT_BROKER_TOKEN` / messaging・meta identity トークン)、git-broker の環境を**読めます**。bwrap の `--unshare-pid` はこれを完全に閉じますが、Seatbelt にはできません。**プロセス列挙も塞がっていない** (上記 `pgrep`) ため pid の推測すら不要で、`pgrep -x node` → 各 pid に `KERN_PROCARGS2` の 2 手で他セッションの `CCSANDBOX_GIT_BROKER_TOKEN` / `CCSANDBOX_BROKER_TOKEN` / 継承された `GITEA_TOKEN` 等が読めます (実機で確認)。したがって per-session の git-broker トークン (`f01099d`、env 配送) は macOS では**隔離を提供しません** — 実効的な境界は broker の repo スコープ allow-list のみ。セッション秘密を env に置く限りこの漏洩は避けられないため、本質的な対策は「秘密を env から外す」方向になります (下記 git-broker トークンの項を参照)。

docker (rootless dind)・rtk・code-review-graph のプロビジョニングは非対応です (起動時に警告し無効化)。グループファイル共有の受信も非対応です (`fetch_file` が返す `/ccserver-group-files/...` はマウントなしでは存在しません)。同一 UID の並行セッション間は tmpdir 経由でファイルシステム的に相互到達できるため、bwrap のようなセッション間隔離はありません (deny ルールは自 launch の bin/hooks/profile と sibling launch dir への到達を塞ぐ範囲に留まり、ランタイム dir 配下の他セッションの commit-guard config 等は deny 外です)。**git-broker への接続はセッション毎のトークン (`CCSANDBOX_GIT_BROKER_TOKEN`) で認証されます**: 他セッションの broker ソケットに `connect()` できても、そのセッションのトークンが無ければ `unauthorized` で拒否されます。ただしこのトークンは env 経由で渡されるため、上記の `KERN_PROCARGS2` の限界により**他の同一 UID セッションから読み取り可能**です — トークンは監査・偶発防止の層であって硬い境界ではありません。実効的な境界は broker 側の**リポジトリスコープの allow-list** (盗まれたトークンでも、そのセッションの cwd リポジトリ以外の資格情報は出ない) です。bwrap ではソケット自体がセッション毎マウントなので、そちらは二重の防御になっています。ただしホスト制御プレーンの meta ブローカーソケットは、全 seatbelt セッションで network-outbound deny pin されています (Unix ソケットへの connect() は file-write* では止まらないため。meta セッション自身のみ meta ソケットの pin を外します)。`~/.ssh` と `~/.config/gh` は引き続き直接公開されず、git-broker 経由でのみ利用できます。macOS では ssh ゲートが `GIT_SSH_COMMAND` と PATH shim (`ssh` コマンド名解決) 経由でのみ効き、`/usr/bin/ssh` を絶対パスで起動した場合は allowlist チェックを迂回できます (bwrap でも `/usr/bin/ssh` のパスがラッパーに置き換わるだけで、実バイナリは `CCSANDBOX_REAL_SSH` が指す `/ccserver-sandbox-real-ssh` としてサンドボックス内に露出しており、直接起動すれば同様に迂回できます)。同様に実 `gh` バイナリの絶対パス起動は deny ピンで塞いでいますが、この pin は best-effort です (bwrap のように実バイナリを隠すのではなく、コピー実行は止められません。実境界は broker の allowlist と `~/.config/gh` の不可視性です)。sshAgent 転送を有効にした場合は ssh の差分を踏まえて判断してください。また Seatbelt では `$HOME` がサンドボックス側ホームに差し替わるため、claude (`CLAUDE_CONFIG_DIR`) と codex (`CODEX_HOME`)、opencode (`XDG_CONFIG_HOME`・`XDG_DATA_HOME`・`XDG_STATE_HOME` をホストに向ける) 以外の CLI (copilot / commandcode) は実ホストの設定・認証・会話履歴を解決できず、ログイン状態や `--continue` はセッションをまたいで引き継がれません (bwrap は `$HOME` をホストホームのパスのまま保つため引き継がれます)。opencode の引き継ぎにはホスト側での事前ログインが必要です (存在しないホストディレクトリはリダイレクトされず、サンドボックス側ローカルのままになります)。claude / codex 用のホストディレクトリ (`~/.claude`・`~/.codex`) は起動時に自動作成され、`CLAUDE_CONFIG_DIR` / `CODEX_HOME` は常にそこを指します。**macOS のログインキーチェーンはこのプロファイルからは一切到達できない** (`~/Library/Keychains` は allow リストに無く、`security` は `errSecNoDefaultKeychain` / 認可拒否になる) ため、macOS では通常キーチェーンに認証情報を保存する Claude Code も、サンドボックス内ではホストの平文ファイル `~/.claude/.credentials.json` (`0600`) にフォールバックします。初回起動時にホストのログインキーチェーンから一度だけ種取り (`security find-generic-password -s "Claude Code-credentials"`) してこのファイルを生成するので、ホストで既に Claude Code にログイン済みなら再ログイン不要で引き継がれます (初回だけ「ccserver がキーチェーンにアクセスしようとしています」の GUI 許可ダイアログが出る場合があります。非対話で失敗してもサンドボックス内で一度ログインすれば以降は永続します)。サンドボックス内でトークンがリフレッシュされるとホストのキーチェーン側は古くなり得ます (ホストで直接 `claude` を使うと再ログインが要る場合があります)。詳細は [認証情報の受け渡し](/ccserver/sandbox/credentials/) を参照してください。Windows は非対応のままです。

## サンドボックスの再利用 (永続 HOME)

既定ではサンドボックスの `HOME` は**プロジェクト毎に永続化**されます (`persistentHome`、既定 `true`)。パスの実体は `~/.local/share/ccserver-sandbox/home/<プロジェクト>` で、セッション中に `pip install --user` や `npm i -g` などで入れたツール・キャッシュ・シェル設定が**次回以降のセッションに引き継がれます** (以前は毎回まっさらな tmpfs のため再構築が必要でした)。隣接する他プロジェクトは引き続き見えません (bind はこの 1 ディレクトリのみ)。

サンドボックス内の `/tmp` も、この永続 HOME 配下 (`.ccserver-tmp`) への**プロジェクト毎の永続 bind** です。fresh tmpfs ではないため、エージェントが `/tmp` に展開したツール・キャッシュ (例: opencode の抽出した Node ランタイム) がセッションを跨いで引き継がれます。`persistentHome: false` の場合は従来どおり `/tmp` も毎回まっさらな tmpfs です。

サンドボックスで起動するとき、そのプロジェクトに前回のサンドボックスが残っていれば**再利用ダイアログ**が表示されます。

- **使用する**: 前回の永続 HOME をそのまま引き継ぎます (ツール・キャッシュ・設定を保持)。
- **新規作成**: 前回の永続 HOME を**破棄**して空の状態から始めます (不可逆)。このプロジェクトのサンドボックスを利用中のセッションがある間は選択できません (`GET /api/sandbox/status` が `inUse` を返し、ダイアログ側で無効化。サーバー側でも起動時に拒否されます)。
- **キャンセル**: 何もせず閉じます。

コンボ起動のワーカー / オーケストレーターのサンドボックスにも永続 HOME の既定動作 (再利用) が適用されますが、ダイアログ・破棄操作の対象は**シングル起動のみ**です。workerA/workerB はそれぞれ別の git worktree (cwd) で起動するようになったため ([コンボ起動 > ロール別 git worktree](/ccserver/guides/combo-launch/#ロール別-git-worktree) 参照)、永続 HOME もロールごとに独立します — 以前はワーカー同士が同じ永続 HOME (同じ `~/.claude` 設定、npm キャッシュ等) を共有していました。

永続 HOME を無効にするには `sandbox.config.json` で `"persistentHome": false`。既存の永続状態をリセットするには `~/.local/share/ccserver-sandbox/home/` 配下の該当ディレクトリを削除してください (ディスク消費の整理も兼ねます)。

:::caution[セキュリティノート]
永続 HOME はサンドボックス内から書き込み可能な**ホスト上の永続ディレクトリ**です。侵害・暴走したセッションはこのディレクトリ内に `.bashrc` 等を仕込み、**同一プロジェクトの次回セッションで実行させる**ことができます (単発セッション内の挙動が次回以降に持ち越される点が tmpfs HOME との違いです)。対象はそのプロジェクトのディレクトリに閉じていますが、機密プロジェクトで `forceSandbox` を多層防御の一部として使う場合はこの点を考慮してください。
:::

## 同時使用時の docker data-root 競合

同じプロジェクトを 2 つのサンドボックスで同時に開いた場合、docker の data-root は1つしかないため、rootless dockerd が実際に起動できる (`sandbox-entrypoint.sh` の `flock` を取れる) のはどちらか一方だけです。**先に取れた方が勝つだけで、workerA/workerB のような役割やコンボの登録順とは無関係** — 起動順が入れ替われば逆転しえます。負けた方は docker 無しで (エラーにはならず) 起動します。

**コンボのワーカー同士については、この制約は実質解消されています**: workerA/workerB はそれぞれ独立した git worktree (cwd) で起動するようになったため、data-root もロールごとに分かれ、両方が同時に docker を使える可能性があります。この制約が引き続き残るのは、**同じプロジェクトを単発起動で 2 つ**開いた場合 (cwd が完全に同一) です。

コンボのオーケストレーターは、`list_group_sessions` / `get_tab_status` が返す `dockerAvailable` (`true`/`false`/`null`) と `dockerReason` でメンバーごとの実際の状態を確認できます。

| `dockerReason` | 意味 |
|---|---|
| `available` | このセッション自身の dockerd がロックを保持しており、docker タスクを振ってよい |
| `data-root-locked-by-another-session` | 同じプロジェクトの別セッションが保持中。このセッションに docker タスクを振っても失敗する |
| `starting` | サンドボックス起動直後で、`flock` の勝敗がまだ確定していない。数秒待って再確認する |
| `disabled-by-config` | `docker` ツール自体は使えるが、`sandbox.config.json` の `docker` 設定で無効化されている |
| `tooling-missing` | ホストに `bwrap`/`rootlesskit`/`slirp4netns`/`newuidmap` が揃っていない |
| `not-sandboxed`（`dockerAvailable: null`） | サンドボックス自体を使っていないセッション。docker は無関係 |

これにより、「workerA にしか docker タスクを振れない」という誤った思い込みで一悶着起きるのを避けられます — 実際には起動順のレースであり、確認すべきは `dockerAvailable` そのものです。

## 設定ページ (作成済みサンドボックス一覧)

ディレクトリブラウザの「Select a Directory」ヘッダー右端の **スパナ (🔧)** ボタンから設定タブを開けます。設定タブには**作成済みサンドボックス**が一覧表示されます。

- 各行はサンドボックスの**実プロジェクトパス** (SQLite の projects/sandboxes テーブルで管理、未知のものは slug)、プロジェクトの**表示ラベル** (設定されている場合) と **git remote**、**最終使用時刻**、**使用容量**、右端の **✕** 削除ボタンで構成されます (旧サイドカー JSON index は DB v2 マイグレーションで取り込まれ、`.index.json.migrated` として退避されます)。
- ✕ を押すと確認ダイアログを経て、そのサンドボックスの永続 HOME (`~/.local/share/ccserver-sandbox/home/<slug>`) と同名の **docker data-root** (`dind/<slug>`) を削除します。
- **利用中のサンドボックス** (生存セッションがマウント中) は「利用中」バッジが付き、✕ は無効化されます (サーバー側でも 409 で拒否)。
- API: `GET /api/sandboxes` (一覧: `name` / `cwd` / `projectLabel` / `gitRemote` / `lastUsedAt` / `size` / `inUse`)、`DELETE /api/sandboxes/:name` (削除)。

## 必要なもの (docker を使う場合)

```bash
# Debian/Ubuntu
sudo apt install uidmap slirp4netns
# rootlesskit / docker (rootless) が入っていること。/etc/subuid, /etc/subgid にエントリが必要。
```

`uidmap`/`slirp4netns` が無い場合は docker 無効のサンドボックス (bwrap のみ) として起動します。

続けて [認証情報の受け渡し](/ccserver/sandbox/credentials/) と [設定ファイルと内部の仕組み](/ccserver/sandbox/configuration/) を参照してください。
