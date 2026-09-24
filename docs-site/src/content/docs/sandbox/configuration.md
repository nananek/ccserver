---
title: 設定ファイルと内部の仕組み
description: sandbox.config.json のキー一覧と、rootlesskit + bwrap + dockerd の内部構成
---

## 動的設定と静的設定

ccserver の設定は 2 つに分かれており、どちらに属するかは**「実行中のセッションの安全性がその値に依存するか」**で決まります。依存するなら静的です。

- **動的** — Web UI から変更でき、再起動なしで反映される。SQLite の `settings` テーブルに入ります。
- **静的** — 起動時に一度だけ読まれ、変更には再起動が必要。とくにセキュリティ境界 (`browseRoots` / `forceSandbox` / `allowUnsandboxedAgents` / `hiddenApps`) が該当します。このページで説明する `sandbox.config.json` に入ります。

たとえば `browseRoots` を Web UI から変えられないのは実装をサボっているからではありません。実行中サンドボックスの bind マウントは**起動時点の** `browseRoots` から計算済みなので、動的にすると UI の表示と実際に動いているサンドボックスが守っている値が食い違います。

原則の全文、全パスの一覧、環境変数の一覧は [設定モデル](/ccserver/reference/configuration-model/) にあります。

## 設定ファイル

サーバー全体の既定値です。各フラグは [起動ガイド](/ccserver/guides/launching/) のモーダルでディレクトリ/ブラウザ単位に上書きできるものと (`gpg`/`sshAgent`/`defaultApp`)、この設定ファイルでしか変えられないものがあります。

置き場所は `~/.config/ccserver/sandbox.config.json` です (`$XDG_CONFIG_HOME` を尊重します)。セットアップウィザードが雛形を作ります。

```bash
npm run setup -- --yes
$EDITOR ~/.config/ccserver/sandbox.config.json
# 場所を変える場合: CCSERVER_SANDBOX_CONFIG=/path/to/config.json
```

:::caution
`server/sandbox.config.example.json` を**そのままコピーしないでください**。このファイルは全キーの既定値を解説するリファレンスであり、`"gpg": true` を含みます。実装は「ファイルが無ければ `false`」なので、丸ごとコピーするとホストの gpg-agent と `~/.gnupg` のサンドボックスへの転送が**黙って有効になります**。ウィザードが生成するのはコメント 1 行だけの最小ファイルです。どうしても全文が欲しい場合は `npm run setup -- --yes --seed-example` を使ってください。
:::

```json
{
  "docker": true,
  "gpg": true,
  "sshAgent": false,
  "gitBroker": true,
  "ghUsageRecording": {
    "enabled": false,
    "file": "/absolute/path/gh-usage-recording.json"
  },
  "commitMessageGuard": {
    "enabled": true,
    "blockedPatterns": []
  },
  "forceSandbox": false,
  "defaultApp": "claude",
  "showUsage": true,
  "opencodeGoUsage": true,
  "hiddenApps": [],
  "usageMcp": false,
  "browseRoots": [],
  "allowUnsandboxedAgents": false,
  "reviewerMcp": false,
  "notify": {
    "discordWebhook": "",
    "subscriptions": []
  },
  "binds": [],
  "env": {},
  "network": {
    "isolate": false,
    "initialState": "enforce",
    "mode": "enforce",
    "allowedHosts": [],
    "deniedHosts": []
  }
}
```

| キー | 既定 | 説明 |
|------|------|------|
| `docker` | `true` | サンドボックス内部で rootless dockerd を起動。`false` で無効 (軽量・rootlesskit 不要)。 |
| `persistentHome` | `true` | プロジェクト毎の永続 HOME を有効化 (詳細は [概要と永続 HOME](/ccserver/sandbox/overview/#サンドボックスの再利用-永続-home))。`false` で従来どおり毎回まっさらな tmpfs HOME。 |
| `gpg` | `false` | コミット署名用に gpg-agent を転送 ([認証情報の受け渡し](/ccserver/sandbox/credentials/) 参照)。UI で上書き可。 |
| `sshAgent` | `false` | ssh-agent を転送 (同上)。UI で上書き可。 |
| `gitBroker` | `true` | git/gh の認証情報スコープ制限 (同上)。 |
| `ghUsageRecording` | 未設定（無効） | Issue #198 の任意・ローカル集計。`{ "enabled": true, "file": "/absolute/path/gh-usage-recording.json" }` を指定した新規サンドボックスセッションだけが、gh ブローカー経由の結果を固定カテゴリのカウンタとして保存する。コマンドライン・リポジトリ名・本文・パス・出力・認証情報・識別子は記録せず、ccserver が送信・アップロードすることもない。`node server/cli/gh-usage-report.js enable --file /absolute/path/gh-usage-recording.json`、`show`、`reset`、`disable` で管理できる。 |
| `commitMessageGuard` | `{ enabled: true, blockedPatterns: [] }` | サンドボックス内の `git commit` を、メッセージが禁止パターンに一致する場合ブロックする commit-msg フック ([認証情報の受け渡し](/ccserver/sandbox/credentials/) 参照)。組み込みパターン (常時有効、設定不要): `Claude-Session:` 行、`https://claude.ai/code/session_...` の裸URL。`gitBroker` とは独立のフラグで、`gitBroker: false` でも有効なまま。`blockedPatterns` に正規表現の文字列を追加すると (例: `Co-Authored-By: ... noreply@anthropic.com` の行)、組み込みパターンに加えてブロックできる。`gitBroker` も有効な場合は、同じ禁止パターンで `gh pr create`/`edit`/`comment`/`review` の title/body/body-file もチェックされる (gh はローカルの commit-msg フックを通らないため別経路が必要 — 詳細は [認証情報の受け渡し](/ccserver/sandbox/credentials/) の gh CLI 節)。 |
| `forceSandbox` | `false` | `true` でサンドボックス外の起動を全面禁止。エージェント・シェルを問わず全セッションがサンドボックス強制になり、UI のサンドボックス切替は無効化されます。bwrap が無い環境 (または Windows) では起動をエラーで拒否します (Claude の `/usage` / Codex のレート制限取得の直接起動フォールバックも同様に禁止)。ホストに bwrap (bubblewrap) のインストールが必須です。 |
| `defaultApp` | `"claude"` | 新規セッションの既定エージェント (`"claude"`、`"opencode"`、`"copilot"`)。UI で一度明示的に選んだ後はブラウザの記憶が優先され、この値は初回表示時の見た目とサーバー側フォールバック (予約プロンプトの自動再開など、クライアントが `app` を指定しない経路) にのみ使われます。**コンボ起動のメンバーには適用されません** (コンボのロール別選択は別途ブラウザの `localStorage` に記憶され、copilot はそもそも選択不可)。 |
| `showUsage` | `true` | タブバー右端の Usage ボタンを表示するか。`false` で非表示。**claude/codex のどちらもサーバーに無く、Go タブも利用不可の場合は設定に関わらず自動的に非表示**になります (利用可能なソースが 1 つだけならボタンは表示され、ポップオーバーはそのソースのみ表示)。 |
| `opencodeGoUsage` | `true` | Usage ポップオーバーの OpenCode Go タブを有効化するか。opencode CLI の有無とは独立 (Go 契約にバイナリは不要)。`false` でタブを強制非表示にし、キーの読み取りも外部リクエストもしません。`true` (既定) でも Go キーが無い間は自動で隠れ、キーがあるのに未契約 (403) の場合はタブ内にその旨を表示します。環境変数 `CCSERVER_OPENCODE_GO_USAGE` (`0/false/off/no` か `1/true/on/yes`) がこのファイルより優先されます。 |
| `hiddenApps` | `[]` | 起動ピッカーから完全に除外するエージェント CLI (`"claude"`・`"opencode"`・`"copilot"`・`"codex"` の配列)。契約していない (=使わせたくない) CLI をサーバーにインストールされているかどうかに関わらず隠すための設定です。単発起動モーダル・コンボ起動のロール別選択・Worker プリセット管理・Usage ボタンのアプリタブ、4画面すべてに適用されます。**未インストールのため grey out されて表示され続けるものとは別の挙動**で、`hiddenApps` に入れたアプリは常に完全に除去されます (grey out のまま残すモードはありません)。不明な値は無視されます。この設定によってこのホストに実際にインストール済みのアプリが1つも選択できなくなる場合、サーバーは起動を拒否します (何も起動できない UI をサイレントに立ち上げないため)。ピッカーからの除外は UI 上の利便性に過ぎず、実際の防御は `createSession()` 側にもあります: WS/REST を直接叩く、あるいは Worker/Launch プリセット経由であっても、隠されたアプリでの新規セッション作成 (予約プロンプトの自動再開を含む) はサーバー側で拒否されます。 |
| `usageMcp` | `false` | Claude セッションへ `ccserver-usage` MCP (`get_usage` ツール) を注入するか。安全のため既定はオフで、`true` の明示時だけ有効です。`showUsage` とは独立しています。 |
| `browseRoots` | `[]` | `/api/files`・`/api/dirs`・`/ws/terminal` のアクセス範囲をこれらのディレクトリ (とそのサブツリー) 配下に制限する許可ルートの配列。`[]` (既定) は従来どおりホスト全域アクセス可能。設定すると: ファイルのダウンロード/プレビュー/アップロード先とディレクトリ閲覧/作成がこの配下に制限され、シェルセッションは常時サンドボックス強制 (オプトアウト不可) になり、エージェントセッションも既定でサンドボックス強制されます (`allowUnsandboxedAgents` 参照)。起動時に、ccserver 自身の設定・データ・状態ディレクトリ (`~/.config/ccserver` / `~/.local/share/ccserver` / `~/.local/state/ccserver` — SQLite DB、この設定ファイル、federation の秘密鍵、`saved-*.json`) がこの配下に入っていないか検証し、入っている場合は起動を拒否します。3 つとも browseRoots の外に置いてください。`~` はホームディレクトリに展開されます。**コンボ起動 (グループ) について**: ワーカー/オーケストレーターの実際のセッション cwd は常に `~/.local/share/ccserver-sandbox/{worktrees,orchestrator}/...` というサーバー内部の固定スクラッチ領域になり (プロジェクトディレクトリ自体ではありません)、この領域は browseRoots のチェック対象外です。ただしコンボ起動作成時 (`POST /api/groups`) のプロジェクト cwd 自体は browseRoots 配下でなければ拒否されるため、browseRoots 外のプロジェクトに対してコンボグループを作成すること自体はできません。 |
| `allowUnsandboxedAgents` | `false` | `browseRoots` 設定時、エージェントセッション (shell ではない起動) がサンドボックスなしで起動することを明示的に許可するか。`true` にしても cwd は引き続き `browseRoots` 配下に制限されます。シェルセッションにはこのオプトアウトはありません。 |
| `reviewerMcp` | `false` | コードレビュー用 MCP (`ccserver-reviewer`、`run_review`/`list_reviews`/`get_review`/`finish_review` ツール) を有効化するか。`true` の明示時、shell と copilot を除く全セッション (コンボのワーカーも含む、グループの有無は不問) へ注入されます。ローカルの任意 ref/ブランチ/PR/未コミット差分に対して使い捨ての git worktree 上でヘッドレスセッションを起動し `/code-review` を実行するため、既定はオフです。レビュージョブ自身のセッションには、このフラグの値に関わらず (ライブ編集で無効化された場合の完了検知破綻を防ぐため) `finish_review` を呼ぶための MCP が強制的に注入されます ([コードレビュー](/ccserver/guides/reviewer/) 参照)。 |
| `binds` | `[]` | 追加で見せるホストパス。各要素 `{ src, mode?, dest? }`。`mode` は `ro` (既定) か `rw`。存在しないパスはスキップ。`~/.ssh` と `~/.config/gh` は `gitBroker` の設定に関わらず常にブロックされます。 |
| `env` | `{}` | サンドボックス内の追加環境変数 (適用順は最後 = 既定値を上書き)。例: `sshAgent: true` のときに `SSH_AUTH_SOCK` を明示指定して自動検出を上書き。 |
| `claudeBin` | 自動検出 | claude/opencode/copilot の起動方法。`claude` を PATH から解決し、ラッパー (例: `/usr/bin/claude` → `/opt/claude-code/bin/claude`) の場合は実体のインストール先を辿ってサンドボックスへ自動的に公開します。opencode は PATH に加えて `~/.opencode/bin` も自動探索。copilot は PATH (SANDBOX_PATH) で自動解決されます (通常 `~/.local/bin/copilot`)。自動検出で外れる場所にある場合や特定ビルドに固定したい場合のみ絶対パスで指定 (環境変数 `CCSERVER_CLAUDE_BIN` が優先。copilot に個別の bin 設定はありません)。 |
| `notify` | `{}` | 通知用 MCP (ccserver-notify) の設定 ([通知](/ccserver/guides/notify/) 参照)。`discordWebhook` は https のみ (非 https は無視)、`subscriptions` は初期購読 (https のみ)。`CCSERVER_DISCORD_WEBHOOK` 環境変数で discordWebhook を上書き可。`bridge` はエージェント通知ブリッジの設定 ([通知](/ccserver/guides/notify/) 参照、既定 `enabled: false`)。`vikunja` キーは廃止済み (残っていても無視され、起動時に警告が出るだけ)。 |
| `federation` | `{}` | 拠点間ペアリング ([federation](/ccserver/guides/federation/) 参照) の設定。`requireTokenForPairing: true` でペアリング開始リクエストに `CCSERVER_TOKEN` の提示を必須化 (既定 `false`)。機能自体の有効/無効は `CCSERVER_FEDERATION_PORT` 環境変数で制御し、ここでは切り替えられません。 |
| `network` | `{ isolate: false, initialState: "enforce", mode: "enforce", allowedHosts: [], deniedHosts: [] }` | ネットワーク隔離 ([下記](#ネットワーク隔離)参照)。`isolate` は機能全体の on/off (`true` で隔離が有効になる)。`initialState` は隔離を有効にして起動したセッションの開始state (`"enforce"`/`"open"`)、`mode` は `"enforce"`/`"audit"`、`allowedHosts`/`deniedHosts` は完全一致か先頭ドット (`.example.com`) のみの許可/拒否リスト (各最大200件)。設定 UI (設定 → ネットワーク隔離) からも編集可能で、`allowedHosts`/`deniedHosts` の保存は稼働中セッションへ自動反映されます。 |

## gh 利用記録（任意・ローカルのみ）

これは Issue #198 の検証用機能です。既定では完全に無効で、**有効化しても ccserver がネットワーク送信、アップロード、Issue コメント投稿を行うことはありません**。保存先は利用者が指定し、共有するか、編集するか、削除するかも利用者自身が決めます。

記録されるのは、**有効化後に新しく起動したサンドボックス**で `gitBroker` を通った `gh` の集計結果だけです。既に動いているセッション、サンドボックス外の `gh`、broker が起動しなかった操作は対象外です。生のイベント列は保存しません。

### 有効化

ccserver を起動しているホスト上で、保存したいローカル絶対パスを指定します。親ディレクトリは必要に応じて作られ、集計ファイルは初回の操作時に作成されます。

```bash
node server/cli/gh-usage-report.js enable \
  --file /absolute/path/gh-usage-recording.json
```

`--file` に指定できるのは、存在しないパスか通常ファイルだけです (ディレクトリ・シンボリックリンク・FIFO・デバイスは拒否されます)。**既にある集計ファイルを指した場合は、その件数と開始日を引き継いで記録を続けます** — `disable` したあと同じパスで `enable` し直しても計数は失われません。一方、集計として読めない通常ファイル (無関係なテキスト等) を指した場合は、最初の記録時にその中身が集計ファイルで置き換えられます。

このコマンドは `sandbox.config.json` の `ghUsageRecording` を次の形で更新します。反映されるのは新規セッションだけなので、記録を始める前に対象のサンドボックスセッションを起動し直してください。

```json
{
  "ghUsageRecording": {
    "enabled": true,
    "file": "/absolute/path/gh-usage-recording.json"
  }
}
```

**保存先はサンドボックスから書き換えられない場所にしてください。** セッションの cwd はサンドボックス内に rw で bind されるため、集計ファイルがセッションの cwd 配下にあると、エージェントが件数を改ざんしたり記録を止めたりできます。`file` は絶対パス必須です (相対パスは無効として無視されます)。

起動時チェックの適用範囲に注意してください。

- **`browseRoots` を設定している場合**: 有効な集計ファイルが browseRoots 配下にあると、ccserver は他の内部状態ファイル (SQLite DB、federation 鍵など) と同様に**起動を拒否します**。`gh-usage-report.js enable` も同じ条件を先に検査して拒否するので、起動不能な設定を書き込んでしまうことはありません。
- **`browseRoots` を設定していない場合 (既定)**: この browseRoots 判定は**何もしません**。browseRoots が無ければ任意のディレクトリをセッションの cwd にできるため、「サンドボックスから書き込めない場所」を機械的に判定する方法がないからです。とくに `--file` を省略した既定の保存先 (`sandbox.config.json` と同じディレクトリ = 通常は ccserver のチェックアウト内) は保護されません。**ccserver のチェックアウト外で、セッションを開くことのない絶対パスを明示的に指定してください。**
- **ccserver のサンドボックス作業ツリー (`~/.local/share/ccserver-sandbox` 配下) は browseRoots の設定に関わらず拒否されます。** ここには各セッションの永続 HOME やコンボ起動の worktree が置かれ、サンドボックスへ rw で bind されるため、browseRoots の例外として扱われる領域です。集計ファイルをここに置くとセッションから書き換えられるので、起動時チェックと `enable` の双方が無条件で拒否します。

### 記録が止まったときの検知

集計ファイル・lock ファイル・tmp ファイルの位置に通常ファイル以外 (ディレクトリ、FIFO、デバイス、シンボリックリンク) が置かれていたり、lock が異常な更新時刻を持っていたりすると、記録が進まないことがあります。ccserver が自動で取り除くのは **通常ファイル・シンボリックリンク・FIFO・デバイス、および空のディレクトリだけ**です。

**中身のあるディレクトリは決して削除しません。** ccserver がこの3つのパスに作るのは通常ファイルだけなので、そこにある中身入りのディレクトリは ccserver の成果物ではなく、削除すれば取り返しがつかないためです。この場合は記録を進めずに警告し、パスはそのまま残します — 手で退かしてください。

除去できなかった場合、ccserver のログに `[gh-usage] not recording (...)` が出ます。gh コマンド自体は成功し続け `show` も動き続けるため、集計が止まったことはこの警告でのみ分かります。同じ理由の警告は繰り返しを避けるため1時間に1回までに抑えられます。`show` の件数が伸びていないときも同じ原因を疑ってください。集計ファイルが読めない状態のときは `show` が標準エラーにその旨を出すので、「まだ何も記録されていない」との区別がつきます。

**集計ファイルには完全性保護 (署名・MAC) がありません。** 行の形式は固定カテゴリに正規化され、任意テキストがレポートに混入することはありませんが、ファイルに書ける者はその固定カテゴリの範囲内で件数や開始日を偽造でき、次回の書き込みでそのまま残ります。レポートの数値は「そのファイルに書ける全員を信頼できる」範囲でのみ意味を持ちます。

### 確認・共有

いつでも集計をプレーンテキストで確認できます。出力は表示するだけで、送信はしません。

```bash
node server/cli/gh-usage-report.js show
```

期間を出力したくない場合は `--no-period` を加えます。共有する場合も、まずこの出力を確認し、必要なら編集したコピーを Issue コメントなどへ手動で貼り付けてください。

```text
ccserver-gh-usage-report: 1
period: 2026-09-01..2026-09-30
recording: opted-in-local-aggregate

client=codex sandbox=sandboxed broker=on
  target=issue operation=create result=success count=3
  target=pr operation=edit result=broker-denied:not-allowlisted count=1
```

保存される値は、クライアント種別、固定の対象・操作分類、成功/CLI エラー/broker 拒否などの結果分類、および件数だけです。`gh` の引数、owner/repo、URL、Issue/PR 番号、本文、ファイルパス、標準出力/標準エラー、トークン、安定した利用者・端末・セッション ID は保存しません。

### リセット・停止

集計だけをゼロから始めるには、次を実行します。設定は有効のままです。

```bash
node server/cli/gh-usage-report.js reset
```

停止すると以後に起動するサンドボックスでは記録されません。すでにある集計ファイルは削除しないため、必要なら利用者自身が内容を確認して保持または削除できます。

```bash
node server/cli/gh-usage-report.js disable
```

## ネットワーク隔離

`network.isolate: true` で起動したセッションは、外向き通信がホスト側の CONNECT プロキシ (`network-broker.js`) 経由に限定されます。TLS はそのままパススルーするプレーンな HTTP CONNECT プロキシで、中身を復号しません。`isolate: false` (既定) で起動したセッションはブローカー自体が起動せず、従来通り通信は制限されません。

- **bwrap (Linux)**: `isolate: true` かつ rootlesskit/slirp4netns/newuidmap が揃っているホストでは、bwrap 起動が私有ネットワーク名前空間 + in-netns ファイアウォール (iptables 優先、nft フォールバック) でラップされ、ブローカーのポートと DNS 以外への通信を構造的に遮断します。開始stateは `initialState` (`enforce`既定・`open`可) に従います。起動後は、そのセッションのトグルでいつでも enforce (許可リストのみ) / open (一時的に全通信許可) を切り替えられます — ただし切り替えられるのは境界がある間だけで、`isolate: false` で起動したセッションには切り替え自体が現れません。rootlesskit 系ツールが1つでも欠けているホストでは、`isolate: true` を指定していても境界を作らず、従来どおりの非隔離 bwrap 起動にフォールバックします (起動は失敗せず、警告ログのみ)。
- **seatbelt (macOS)**: `isolate: true` で起動したセッションだけ、プロファイルが `(allow network*)` の代わりにブローカーのループバックポートのみを許可するルールに切り替わります (ツール依存はありません)。開始stateは `initialState` に従い、稼働中の 🌐 トグルで再起動なしにいつでも enforce/open を切り替えられます。ただし open でも直結 TCP/UDP は不可で proxy 経由のみとなるため、proxy を無視するツールは open でも直結できません。bwrap のようなカーネルレベルの境界ではなく、同一UIDのプロセスは `KERN_PROCARGS2` 経由でブローカーのトークンを読み取れてしまうため、あくまで defense-in-depth です。

**既知の制限:** enforce 状態のブローカーであっても、CONNECT (HTTP(S) プロキシ) を経由しない生の TCP/UDP 通信 (プロキシ環境変数を見ないツールが直接ソケットを開くケースなど) はそもそも境界の対象外です。bwrap の open 状態でも同様に、境界自体はブローカーのポート宛て以外への通信を落とすため、プロキシ非対応の通信は enforce/open どちらでも届きません。この設定ファイルの `gitBroker` (git/gh の認証情報) はホスト側でネットワーク I/O を行うため、ここには影響されません。

`docker: true` と `network.isolate: true` を併用した bwrap セッションでは、netns 内の in-netns ファイアウォールが `FORWARD` チェーンもデフォルト DROP にし、dockerd は `--iptables=false` で起動します (dockerd 自身に FORWARD/NAT ルールを挿入させず、ファイアウォールの保証を保つため)。そのため `docker run -p` によるコンテナのポート公開は機能しません。

## 内部の仕組み (docker と gpg の両立)

```
ccserver → rootlesskit (subuid userns + slirp4netns) → bwrap (FS制限) → dockerd + claude/opencode
```

rootless docker には subuid マッピング付き userns が要るため、外側を `rootlesskit`、内側で `bwrap` が FS を制限します (この順序でないと `newuidmap` が使えずマルチ uid が壊れます)。`/run` は **bwrap が専用 tmpfs で用意**し (rootlesskit の `--copy-up=/run` は使わない)、ホストの生ソケットを bind ソースとして活かします。gpg は userns 内で uid 0 のため socketdir が `~/.gnupg` になる点を利用し、生ソケットをそこへ転送しています。`docker run -v ...` でもサンドボックス外へは到達できません (daemon 自身が制限 FS 内)。
