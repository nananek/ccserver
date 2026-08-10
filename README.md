# ccserver

> **Note:** このプロジェクトは Anthropic 非公式のサードパーティツールです。Anthropic による公式サポートの対象外です。

ディレクトリを指定して Claude Code (または [opencode](https://opencode.ai/)) を起動する Web フロントエンド。
VS Code のようにフォルダを選択し、ブラウザ内のターミナルで操作できます。

## アーキテクチャ

```
ブラウザ (xterm.js) <── WebSocket ──> Fastify <── node-pty ──> claude / opencode CLI
                    <── HTTP REST ──>         (ディレクトリ一覧 API)
```

| レイヤー | 技術スタック |
|----------|-------------|
| Frontend | React 19 + Vite + xterm.js |
| Backend  | Node.js + Fastify + @fastify/websocket + node-pty |

## 必要な環境

- Node.js >= 20 / npm >= 9
- C++ コンパイラ（node-pty のビルドに必要。Arch: `base-devel`、Ubuntu: `build-essential`）
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) — このプロジェクトの主対象。既定で起動するエージェント。
- [opencode](https://opencode.ai/) — 任意。入っていれば起動時にアプリとして選べます (下記「起動」参照)。入れずに opencode を選んだ場合、ターミナルに `execvp(3) failed` 等のエラーが表示され起動に失敗します。

## インストールと起動

```bash
git clone <repo-url> ccserver
cd ccserver
npm install
```

### 開発モード

ターミナルを 2 つ開いて実行:

```bash
# バックエンド (port 3001)
npm run dev:server

# フロントエンド (port 5173)
npm run dev:client
```

ブラウザで http://localhost:5173 を開く。

### 本番モード

```bash
npm run build --workspace=client
NODE_ENV=production node server/index.js
```

ブラウザで http://localhost:3001 を開く。ポートは環境変数 `PORT` で変更可能 (`PORT=8080 NODE_ENV=production node server/index.js`)。

常駐させたい場合は [systemd でバックグラウンド実行](#systemd-でバックグラウンド実行)、Tailnet 内から HTTPS で見たい場合は [Tailscale Serve で HTTPS 公開](#tailscale-serve-で-https-公開) を参照。

## 使い方

1. ディレクトリブラウザでフォルダを選択
   - **シングルクリック** → フォルダ内に移動
   - **ダブルクリック** → そのフォルダで (既定の設定のまま) 起動
   - **Back** ボタン → ディレクトリ選択に戻る
2. ブラウザ内ターミナルで操作

### 起動 (アプリ・サンドボックス)

「Claude Code」ボタン右の **▼** から開くモーダルで、起動方法を選べます:

| 項目 | 選択肢 | 記憶される場所 |
|------|--------|----------------|
| アプリ | Claude Code / opencode | ブラウザの `localStorage` (次回以降の既定) |
| 起動モード | 通常起動 / 🔒 サンドボックスで起動 | 同上 |
| GPG署名を使う | on/off (既定 off) | `localStorage` に**ディレクトリ単位**で |
| ssh-agentを転送する | on/off (既定 off) | 同上 |

サンドボックス・GPG・ssh-agent の詳細は [サンドボックス (bwrap + rootless docker)](#サンドボックス-bwrap--rootless-docker) を参照。「アプリ」と「起動モード」のどちらの項目をクリックしても、選んだ内容で即座に起動します。

新規セッションの既定アプリ・サンドボックス設定は `sandbox.config.json` (下記「設定ファイル」参照) でサーバー全体の初期値を決められますが、上記モーダルで一度でも明示的に選んだ後はブラウザ側の記憶が優先されます。

opencode を選んだ場合の挙動の違い:

- **クリップボード同期 (OSC 52)**: opencode がターミナルに書き込む OSC 52 シーケンスをブラウザが解釈し、システムクリップボードへ反映します (xterm.js は OSC 52 を無視するため、ccserver 側で処理)。
- **TUI ネイティブスクロール**: opencode は独自の代替画面バッファでスクロールするため (xterm.js 自体のスクロールバックは効きません)、マウスホイール/タッチドラッグは合成ホイールイベントとして、ターミナル下部のスクロールボタンは opencode のメッセージスクロールキー (PageUp/PageDown, Ctrl+G/Ctrl+Alt+G) として中継されます。
- **列数の確保**: 狭い画面 (スマホ等) では、opencode のプロンプト表示 (agent · model · provider 行) が折り返して画面の大半を占領しないよう、68 列を下限にフォントサイズを自動で縮小します。
- Usage ボタン (下記) は Claude Code の `/usage` 専用のため、opencode セッションでは非表示になります。

### 予約プロンプト (タイマー)

ターミナルヘッダの時計 (⏰) ボタンから、指定時刻に任意のプロンプトを自動投入できます。
5 時間の利用制限で停止したとき、解除時刻に「続けて」などを予約しておくと自動再開します。

- 時刻は **サーバーのタイムゾーン**で解釈されます (Claude Code が表示する制限解除時刻と一致)。パネルに現在のサーバー時刻とタイムゾーンを常時表示します。
- 過ぎている時刻は翌日として扱います。
- 予約はディスク (`.scheduled-prompts.json`) に永続化され、**ブラウザを閉じても、サーバーが再起動・クラッシュしても発火します**。発火時にセッションが生きていなければ、`claude --resume` (opencode は `opencode -c`) で会話を自動復帰させてからプロンプトを投入します (元の cwd / サンドボックス設定も復元)。サーバー停止中に発火時刻を過ぎた予約は、起動直後にまとめて発火します (12 時間以上前に過ぎた物は破棄)。

### 使用量 (Usage) ボタン

画面上部タブバー右端の **Usage** ボタンから、Claude Code の `/usage` (セッション / 週次の利用率・リセット時刻・プラン) をポップオーバーで確認できます。ボタンには現在セッションの使用率が常時表示されます (opencode セッションでは非表示)。

- 裏側では `claude --ax-screen-reader` を短時間起動して `/usage` の描画をパースし、結果を約 2 分キャッシュします (`/usage` の閲覧自体は API を消費しません)。「更新」ボタンで即時に再取得できます。
- bwrap がある環境では、**Claude の設定だけを見せる最小サンドボックス** (docker/gpg/ssh なし) で起動します。無ければ claude を直接起動します。
- API: `GET /api/usage` (`?force=1` で強制再取得)。サーバー起動時にキャッシュを 1 度ウォームします。

### コンボ起動: オーケストレーターが `send_input` でワーカーに指示するときの注意

コンボ起動 (2 ワーカー + オーケストレーター) では、オーケストレーターが MCP ツール `send_input` でワーカーのターミナルにテキストを流し込みます。実際に「ワーカーのタブが TUI ではなく素のシェルの `$` プロンプトに落ちていた」状態を見落として長文の指示を送り、トラブルになったことがあります (一度はシェルプロセスごと終了、一度は `eval` の構文エラー)。この種の事故を避けるため:

- ワーカータブ (opencode 等) は、直前に TUI が描画されていたように見えても、実際には素のシェルの `$` プロンプトに戻っていることがあります。`send_input` の `settled: true` や、直前の `read_output` で TUI が見えていたことは、**送った内容を実際に TUI が受け取った保証にはなりません**。
- 素のシェルにテキストが渡ると、バッククォート `` ` `` はコマンド置換として評価され、複数行テキストはシェルを継続入力待ち (`>` プロンプト) の状態にしてしまうことがあります。
- そのため `send_input` で送る指示は**短く 1 行にまとめ**、バッククォートや改行などの特殊文字を避けてください。詳細な指示をターミナルに直接貼り付けるのではなく、`./tmp/` 配下の plan ファイルなど既存ファイルへの**パス参照**に留めるのが安全です。
- 送信後は必ず `read_output` で、`command not found` / `許可がありません` / `unexpected token` / `eval` のようなシェルエラーが出ていないか確認してください。
- シェルエラーが出てしまった場合、それを収拾しようとして空入力や Ctrl+C 相当の入力を送ってはいけません。継続入力待ちのシェルに対しては EOF のように作用し、**シェルプロセスごと終了させてしまうことがあります** (実際に一度そうなりました)。`get_tab_status` で `exited: true` を確認したら、そのタブは諦めて `close_tab` → `open_tab` で作り直してください。
- 新規に開いたタブに何かを送る前には、`read_output` で実際にアプリの TUI が描画されていることを確認してから送ってください。

#### オーケストレーターからワーカーのプロジェクトが見える (読み取り専用)

オーケストレーターのサンドボックスには、各ワーカーの作業ディレクトリが **読み取り専用** で `/workers/workerA` `/workers/workerB` (role 名) にマウントされます。README やファイル構成、`git log` のような基本情報は `open_tab` で新規タブを作らずに直接読めます。ただし読み取り専用なので書き込みはできず、コマンド実行・コード修正・判断を伴う作業は従来どおり MCP ツール (`send_input` 等) 経由でワーカーに任せる必要があります。

この bind はサンドボックス起動時に一度だけ固定されます。`open_tab` でオーケストレーター起動後に追加したワーカー (例: workerC) は、オーケストレーターを再起動するまで `/workers/workerC` に見えません (MCP 経由での到達性は動的に効きますが、bwrap のマウント名前空間は起動時固定のため)。オーケストレーター自身の再起動 (`POST /api/groups/:id/orchestrator`、または予約プロンプトによるオートリジューム) 時には現在のメンバーで再計算されます。

## サンドボックス (bwrap + rootless docker)

「🔒 サンドボックスで起動」(上記「使い方 > 起動」参照) を選ぶと、`bwrap` でファイルシステムを制限した状態で起動します。選択したプロジェクトと最小限の設定 (`~/.claude`, `~/.claude.json`, `~/.config/opencode`, `~/.local/share/opencode`, `~/.local/state/opencode` 等) だけが見え、**隣接する他プロジェクトは見えません**。

docker も安全に使えるよう、サンドボックス**内部**に rootless dockerd を起動します。`rootlesskit` (subuid マッピング) の内側で `bwrap` を動かす構成のため、`docker run -v ...` でもサンドボックス外へは到達できません (daemon 自身が制限された FS の中にいるため)。

### 必要なもの (docker を使う場合)

```bash
# Debian/Ubuntu
sudo apt install uidmap slirp4netns
# rootlesskit / docker (rootless) が入っていること。/etc/subuid, /etc/subgid にエントリが必要。
```

`uidmap`/`slirp4netns` が無い場合は docker 無効のサンドボックス (bwrap のみ) として起動します。

### 認証情報の受け渡し

サンドボックス内から git/gh/ssh/gpg を安全に使うための仕組みです。オン/オフは「使い方 > 起動」のモーダル (ディレクトリ単位) か、下記「設定ファイル」の `gpg`/`sshAgent`/`gitBroker` (サーバー全体の既定値) で制御します。

#### git — HTTPS

`gitBroker` (既定 on) が有効なとき、サンドボックス内の git アクセスは**そのセッションの作業ディレクトリ自身のリモート + サブモジュール (再帰) から起動時に一度だけ算出した owner/repo にだけ**制限されます。設定不要、`~/.config/gh` や `~/.ssh` を binds に足す必要はありません (足してもブロックされ、警告が出るだけです)。

git の `credential.helper` がホスト側の git-broker プロセス (サンドボックスの外で動作、`gh auth token` を都度取得) に host+path を問い合わせ、許可されたリポジトリだけにトークンを渡します。トークン自体はサンドボックス内のファイルには一切現れません。

#### git — SSH / ssh-agent 転送

`/usr/bin/ssh` と `$GIT_SSH_COMMAND` を、起動時に読み取り専用で渡された許可リスト (`gitBroker` が算出したのと同じ owner/repo) と照合するラッパーに差し替えます。許可されなければネットワークに出る前に拒否されます。

ただし認証自体 (署名) は素通しなので、SSH の git remote を使うには別途 **ssh-agent 転送**を有効にしておく必要があります。これは HTTPS git (`gitBroker` で完結) にもコミット署名 (下記 gpg の領分) にも必須ではなく、必要なのは **SSH の git remote を使う場合**と**サンドボックス内から素の `ssh` コマンドを直接叩きたい場合**だけです。有効にすると、ccserver が起動時にユーザーの agent ソケット (`/tmp/ssh-*/agent.*` 等、鍵がロードされている物を優先) を探して `SSH_AUTH_SOCK` を設定します (`env.SSH_AUTH_SOCK` で上書き可)。

転送された agent はそのセッションの間、サンドボックス内の**あらゆるプロセスから無制限に使える生の鍵アクセス**になる点に注意してください (git 用途に絞られません) — 既定オフなのはこのためです。

#### gpg 署名

有効にすると、`~/.gnupg` と**ホストの生 gpg-agent / keyboxd ソケット**をサンドボックス内へ転送します。ホストの agent (鍵/トークンを保持) で署名するので、**docker 有効のままコミット署名が使えます**。ssh-agent 転送とは独立したフラグで、こちらだけ有効にしても ssh-agent は転送されません。

#### gh CLI

`gitBroker` が有効なとき、サンドボックス内の `gh` は素通しではなく、同じ git-broker プロセスへの中継に差し替わります。gh の API 呼び出しは TLS で `api.github.com` に直結するため通信内容を見て絞ることはできませんが、代わりに**決め打ちの安全なサブコマンドだけをブローカーが実 `gh` (ホスト側、実際の認証情報付き) で代行実行**し、対象リポジトリを git と同じ許可リストと照合します。トークンやCookieがサンドボックス内に渡ることはありません。

- 許可: `pr` (create/view/list/edit/comment/merge/close/reopen/ready/review/checks/diff/status/checkout)、`issue` (create/view/list/edit/comment/close/reopen/status)、`release` (create/view/list/edit/delete/upload/download/delete-asset)、`workflow` (run/view/list/enable/disable)、`repo view`。
- 対象リポジトリは `--repo`/`-R` フラグ (`OWNER/REPO`, `HOST/OWNER/REPO`, URL) があればそれを、無ければ作業ディレクトリの origin リモートを使い、いずれも許可リストと照合されます (`--repo` で許可リスト外のリポジトリを指定しても拒否されます)。
- `pr view`/`checkout`/`diff`/`merge`/`close`/`edit` 等は `<number>|<url>|<branch>` を、`repo view` は裸の `OWNER/REPO` も受け付けます。**PR/issue の URL をそのまま位置引数に渡した場合、そのURLが指すリポジトリも許可リストと照合されます** (`--repo`/cwd の判定をすり抜けて無関係なリポジトリを操作させることはできません)。
- **バンドルされた短縮フラグ (`-wR owner/repo` のような1トークンへの複数フラグの結合) は拒否されます**: gh (pflag/Cobra) はこの形を `-w -R owner/repo` と等価に解釈しますが、ブローカー側でこれを正しく再現するのは複雑で壊れやすいため、`-R` 単体または `-Rvalue` (値を直接くっつける形) 以外の複数文字の短縮フラグはまとめて拒否します。個別のフラグ (`-w` 単体等) はそのまま使えます。
- 拒否: `gh api` (任意のAPIエンドポイントに直結しリポジトリ単位に絞れない)、`gh auth`/`gh secret`/`gh variable`/`gh ssh-key`/`gh gpg-key` (認証情報自体の管理)、`gh repo clone`/`fork`/`create`/`delete`/`rename` (対象リポジトリが位置引数で来るため個別のパース対応が必要で未対応) など、上記に無いものは全て拒否されます。
- ブローカー越しの実行はホスト側で TTY なしの子プロセスとして動くため、**非対話的な呼び出し (必要な入力は全てフラグ/stdin で渡す) のみ**サポートします。エディタが開く対話フロー (`gh pr create` をフラグなしで叩く等) は動作しません。

`gitBroker: false` で git 側のゲート・gh ブローカーの両方を無効化できます (git は使えますが ssh-agent が有効なら無制限に、gh はそのまま実行されますが `~/.config/gh` が無いため無認証で失敗します)。

#### 既知の限界

これは「侵害/暴走したプロセスが無関係なリポジトリの認証情報を安易に使ってしまう」事故を防ぐ多層防御であり、意図的にバイパスを試みるコードへの完全な防壁ではありません。以下は主に ssh-agent 転送が有効なときに関係します (既定オフなら SSH 経由の抜け道はそもそも存在しません):

- 転送された ssh-agent ソケットに対し `ssh` バイナリを経由せず直接 ssh-agent プロトコルを話すコードは、宛先チェックをすり抜けて任意ホスト向けの署名を依頼できます。
- **`docker: true` (既定) と ssh-agent 転送を併用する場合、上記よりずっと簡単な迂回経路があります**: サンドボックス内から `docker run` されたコンテナはサンドボックス自身の `/usr/bin/ssh`・`gh` 差し替えを引き継がず、独自のイメージ内の素の `ssh`/`gh` を使えます。転送された `SSH_AUTH_SOCK` は固定の既知パスにバインドされているため、コンテナ側に `-v` でそのソケットを渡すだけで、ラッパーを一切経由しない無制限の ssh-agent アクセスになります。つまり **docker + ssh-agent 転送有効時は gitBroker のリポジトリ制限を強い境界として当てにしないでください**。厳密なスコープが必要なセッションでは ssh-agent 転送を無効 (既定) のままにするか `docker: false` にするか、サンドボックス起動時にコンソールへ出る警告を確認してください。
- サブモジュールの URL は、実際にチェックアウト済み (作業ディレクトリが存在する) のものだけを許可リストに加えます。`.gitmodules` はリポジトリのコンテンツそのものであり信頼できないため、宣言されているだけで未チェックアウトの「サブモジュール」は無視されます (信頼できないリポジトリがでっち上げの URL を許可リストへ紛れ込ませるのを防ぐため)。
- 許可リストはセッション起動時に一度だけ算出するため、セッション中に追加/チェックアウトしたサブモジュールや変更した gh の許可サブコマンドは次回起動まで反映されません。
- 同様に、オーケストレーターの `/workers/<role>` への読み取り専用マウントもセッション起動時に一度だけ固定されるため、起動後に `open_tab` で追加したワーカーはオーケストレーターの再起動まで見えません (上記「コンボ起動」参照)。

### 設定ファイル

サーバー全体の既定値です。各フラグは「使い方 > 起動」のモーダルでディレクトリ/ブラウザ単位に上書きできるものと (`gpg`/`sshAgent`/`defaultApp`)、この設定ファイルでしか変えられないものがあります。

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
  "defaultApp": "claude",
  "binds": [],
  "env": {}
}
```

| キー | 既定 | 説明 |
|------|------|------|
| `docker` | `true` | サンドボックス内部で rootless dockerd を起動。`false` で無効 (軽量・rootlesskit 不要)。 |
| `gpg` | `false` | コミット署名用に gpg-agent を転送 (上記参照)。UI で上書き可。 |
| `sshAgent` | `false` | ssh-agent を転送 (上記参照)。UI で上書き可。 |
| `gitBroker` | `true` | git/gh の認証情報スコープ制限 (上記参照)。 |
| `defaultApp` | `"claude"` | 新規セッションの既定エージェント (`"claude"` か `"opencode"`)。UI で一度明示的に選んだ後はブラウザの記憶が優先され、この値は初回表示時の見た目とサーバー側フォールバック (予約プロンプトの自動再開など、クライアントが `app` を指定しない経路) にのみ使われます。 |
| `binds` | `[]` | 追加で見せるホストパス。各要素 `{ src, mode?, dest? }`。`mode` は `ro` (既定) か `rw`。存在しないパスはスキップ。`~` はホームに展開。`~/.ssh` と `~/.config/gh` は `gitBroker` の設定に関わらず常にブロックされます。 |
| `env` | `{}` | サンドボックス内の追加環境変数 (適用順は最後 = 既定値を上書き)。例: `sshAgent: true` のときに `SSH_AUTH_SOCK` を明示指定して自動検出を上書き。 |
| `claudeBin` | 自動検出 | claude/opencode の起動方法。`claude` を PATH から解決し、ラッパー (例: `/usr/bin/claude` → `/opt/claude-code/bin/claude`) の場合は実体のインストール先を辿ってサンドボックスへ自動的に公開します。opencode は PATH に加えて `~/.opencode/bin` も自動探索。自動検出で外れる場所にある場合や特定ビルドに固定したい場合のみ絶対パスで指定 (環境変数 `CCSERVER_CLAUDE_BIN` が優先)。 |

サンドボックスは Linux 限定です。同じプロジェクトを 2 つのサンドボックスで同時に開いた場合、docker の data-root 競合を避けるため 2 つ目は docker 無しで起動します。

### 内部の仕組み (docker と gpg の両立)

```
ccserver → rootlesskit (subuid userns + slirp4netns) → bwrap (FS制限) → dockerd + claude/opencode
```

rootless docker には subuid マッピング付き userns が要るため、外側を `rootlesskit`、内側で `bwrap` が FS を制限します (この順序でないと `newuidmap` が使えずマルチ uid が壊れます)。`/run` は **bwrap が専用 tmpfs で用意**し (rootlesskit の `--copy-up=/run` は使わない)、ホストの生ソケットを bind ソースとして活かします。gpg は userns 内で uid 0 のため socketdir が `~/.gnupg` になる点を利用し、生ソケットをそこへ転送しています。`docker run -v ...` でもサンドボックス外へは到達できません (daemon 自身が制限 FS 内)。

## プロジェクト構成

```
ccserver/
├── package.json                    # npm workspaces ルート + playwright
├── playwright.config.js
├── docs/
│   └── ccserver.service
├── tests/
│   ├── close-confirm.spec.js       # Playwright E2E
│   ├── mobile-scroll.spec.js       # opencode TUI: タッチドラッグ→合成ホイールイベント (opencode 未インストール環境では skip)
│   └── scroll-buttons.spec.js      # opencode TUI: スクロールボタン→メッセージスクロールキー (同上)
├── server/
│   ├── package.json
│   ├── index.js                    # Fastify エントリポイント (トークン認証・静的配信含む)
│   ├── usage.js                    # `claude --ax-screen-reader` を叩いて /usage をパース・キャッシュ
│   ├── sandbox.config.example.json
│   ├── routes/
│   │   ├── dirs.js                 # GET/POST /api/dirs, GET /api/dirs/home
│   │   ├── sessions.js             # GET/DELETE /api/sessions...
│   │   ├── files.js                # GET/POST /api/files (アップロード/ダウンロード)
│   │   ├── system.js               # GET /api/system-stats (CPU/メモリ/温度/GPU/IPMI/ストレージ)
│   │   └── usage.js                # GET /api/usage
│   └── ws/
│       ├── terminal.js             # WebSocket + node-pty ブリッジ (/ws/terminal)
│       ├── sessionManager.js       # セッション・予約プロンプトの状態管理/永続化
│       ├── appLaunch.js            # アプリ非依存の起動ロジック (resume引数・permission検出等)
│       ├── sandbox.js              # bwrap + rootless docker サンドボックス構築
│       ├── sandbox-entrypoint.sh
│       ├── sandbox-gh-wrapper.cjs         # サンドボックス内 gh をブローカー中継に差し替え
│       ├── sandbox-ssh-wrapper.cjs        # サンドボックス内 ssh を許可リストでゲート
│       ├── sandbox-git-credential-helper.cjs
│       ├── sandbox-gitconfig / sandbox-known-hosts / sandbox-ssh-config
│       ├── git-broker.js           # サンドボックス外で動く、リポジトリスコープの認証情報ブローカー
│       └── ghAllowlist.js / gitAllowlist.js  (+ 各 *.test.js, appLaunch.test.js, sandbox-resolve.test.js)
└── client/
    ├── package.json
    ├── index.html
    ├── vite.config.js
    └── src/
        ├── main.jsx / App.jsx
        ├── auth.js                 # トークン認証 (CCSERVER_TOKEN)
        ├── themes.js
        ├── osc52.js                # OSC 52 クリップボード同期のパーサ (+ server/ws/osc52.test.js)
        ├── hooks/
        │   └── useNotifications.js
        ├── components/
        │   ├── DirectoryBrowser.jsx
        │   ├── TerminalView.jsx    # 遅延ロード (初期バンドル削減)
        │   ├── UsageButton.jsx
        │   └── SystemMonitor.jsx
        └── styles/
            └── app.css
```

## API

### 認証 (任意)

`CCSERVER_TOKEN` 環境変数を設定すると、`/api` と `/ws` 配下の全リクエストに Jupyter 風のトークン認証がかかります (未設定なら無効)。`?token=<TOKEN>` クエリか `Authorization: Bearer <TOKEN>` ヘッダのどちらかで通ります。クライアントは 401 を受けると `prompt()` でトークンを聞き、`localStorage` (`ccserver-token`) に保存して以降のリクエストへ自動付与します (`client/src/auth.js`)。

```bash
CCSERVER_TOKEN=some-secret NODE_ENV=production node server/index.js
```

### REST

| メソッド | パス | 説明 |
|---|---|---|
| GET | `/api/dirs?path=<path>&showHidden=1` | 指定パスのサブディレクトリ/ファイル一覧 |
| GET | `/api/dirs/home` | `{ home, defaultApp }` — サーバーのホームディレクトリと、設定ファイルの既定起動アプリ |
| POST | `/api/dirs` | `{ parent, name }` でフォルダ作成 |
| GET | `/api/sessions` | 実行中セッションの一覧 |
| DELETE | `/api/sessions/:id` | セッションを終了する (予約プロンプトも解除) |
| GET | `/api/files?path=<path>` | ファイルをダウンロード |
| POST | `/api/files` | multipart アップロード (`destination` フィールド + ファイルパート) |
| GET | `/api/system-stats?ipmi=1` | CPU/メモリ/温度/GPU (`nvidia-smi`)/IPMI (要 `ENABLE_IPMI=1`)・load average |
| GET | `/api/usage?force=1` | Claude Code `/usage` のキャッシュ済みスナップショット (`force=1` で即時再取得) |

`GET /api/dirs` のレスポンス例:

```json
{
  "current": "/home/user",
  "parent": "/home",
  "dirs": [
    { "name": "projects", "path": "/home/user/projects" }
  ],
  "files": [
    { "name": "notes.txt", "path": "/home/user/notes.txt", "size": 123, "mtime": 1730000000000 }
  ]
}
```

### `WebSocket /ws/terminal`

JSON メッセージでターミナル I/O とセッション管理 (アタッチ・予約プロンプト・自動承認) を中継。

| 方向 | type | フィールド | 説明 |
|------|------|-----------|------|
| → | `init` | `cwd`, `cols`, `rows`, `claudeSessionId?`, `shell?`, `sandbox?`, `sandboxOpts?`, `app?`, `resume?` | 新規セッションを起動 (`app`: `"claude"` (既定) か `"opencode"`、`shell: true` で素のシェル、`resume: true` で opencode の最終セッションに再開) |
| → | `attach` | `sessionId`, `cols?`, `rows?` | 既存セッションに再接続 (出力バッファを `replay` で再送) |
| → | `input` | `data` | キーボード入力 |
| → | `resize` | `cols`, `rows` | ターミナルリサイズ |
| → | `ping` | – | 疎通確認 (`pong` が返る) |
| → | `set_auto_yes` / `get_auto_yes` | `enabled?` | 確認プロンプトの自動承認 ON/OFF・状態取得 |
| → | `schedule_prompt` | `time` (`"HH:MM"`) か `at` (epoch ms), `text` | 予約プロンプトを設定 |
| → | `cancel_schedule` / `get_schedule` | – | 予約の解除・現在状態の取得 |
| ← | `session` | `sessionId`, `cwd`, `cols`, `rows`, `isReconnect` | スポーン/再接続完了 |
| ← | `output` | `data` | ターミナル出力 |
| ← | `replay` | `data` | `attach` 時、切断中に貯まった出力バッファを再送 (複数回届く) |
| ← | `exit` | `exitCode`, `signal`, `claudeSessionId` | プロセス終了 |
| ← | `auto_yes_state` | `enabled`, `log` | 自動承認の状態変化・ログ |
| ← | `schedule_state` | `scheduled`, `serverTz`, `serverNow`, `error?` | 予約プロンプトの現在状態 (サーバー時刻/TZ 付き) |
| ← | `error` | `message`, `code` | エラー通知 (`SESSION_NOT_FOUND` は自動再接続、それ以外はターミナルにメッセージを表示) |
| ← | `pong` | – | `ping` への応答 |

## systemd でバックグラウンド実行

### 1. クライアントをビルド

```bash
cd /path/to/ccserver
npm run build --workspace=client
```

### 2. サービスファイルを配置

```bash
cp docs/ccserver.service ~/.config/systemd/user/ccserver.service
```

または手動で `~/.config/systemd/user/ccserver.service` を作成:

```ini
[Unit]
Description=Claude Code Web Server
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/ccserver
Environment=NODE_ENV=production
Environment=PORT=3001
ExecStart=/usr/bin/node server/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

### 3. サービスを有効化・起動

```bash
# ユーザーサービスのデーモンをリロード
systemctl --user daemon-reload

# 起動
systemctl --user start ccserver

# 自動起動を有効化
systemctl --user enable ccserver

# ログイン中でなくてもサービスを維持（必要に応じて）
sudo loginctl enable-linger "$USER"
```

### 4. 動作確認

```bash
# ステータス確認
systemctl --user status ccserver

# ログ表示
journalctl --user -u ccserver -f

# 再起動
systemctl --user restart ccserver

# 停止
systemctl --user stop ccserver
```

## Tailscale Serve で HTTPS 公開

Tailscale Serve を使うと、Tailnet 内のデバイスから HTTPS でアクセスできます。

### 1. ccserver が起動していることを確認

```bash
systemctl --user status ccserver
```

### 2. Tailscale Serve を設定

```bash
# ポート 3001 を HTTPS で公開
sudo tailscale serve --bg 3001
```

これにより `https://<hostname>.<tailnet>.ts.net/` でアクセス可能になります。

### 3. 確認

```bash
# 現在の serve 設定を表示
tailscale serve status
```

### 4. 停止

```bash
tailscale serve --https=443 off
```

## ライセンス

MIT
