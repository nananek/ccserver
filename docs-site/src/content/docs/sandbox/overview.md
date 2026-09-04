---
title: 概要と永続 HOME
description: bwrap + rootless docker によるサンドボックスの仕組み、永続 HOME、設定ページ
---

「🔒 サンドボックスで起動」([起動ガイド](/ccserver/guides/launching/) 参照) を選ぶと、`bwrap` でファイルシステムを制限した状態で起動します。選択したプロジェクトと最小限の設定 (`~/.claude`, `~/.claude.json`, `~/.config/opencode`, `~/.local/share/opencode`, `~/.local/state/opencode`, `~/.config/github-copilot`, `~/.copilot` 等) だけが見え、**隣接する他プロジェクトは見えません**。

docker も安全に使えるよう、サンドボックス**内部**に rootless dockerd を起動します。`rootlesskit` (subuid マッピング) の内側で `bwrap` を動かす構成のため、`docker run -v ...` でもサンドボックス外へは到達できません (daemon 自身が制限された FS の中にいるため)。

サンドボックスは Linux 限定です。

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
