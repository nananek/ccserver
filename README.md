# ccserver

**Languages:** [日本語](README.md) | [English](README.en.md) | [Français](README.fr.md)

> **Context & Coordination Server** — AI CLIセッションのコンテキスト管理とエージェント間連携を行う Web サーバー。

> **Note:** このプロジェクトは対応するAI CLIの各ベンダー・プロジェクトとは無関係の非公式サードパーティツールです。各ベンダー・プロジェクトによる公式サポートの対象外です。

ディレクトリを指定して複数の AI CLI ([Claude Code](https://docs.anthropic.com/en/docs/claude-code)、[opencode](https://opencode.ai/)、[GitHub Copilot CLI](https://github.com/github/copilot-cli)、[OpenAI Codex CLI](https://developers.openai.com/codex/cli/)) を起動・管理する Web フロントエンド。
VS Code のようにフォルダを選択し、ブラウザ内のターミナルで操作できます。

## アーキテクチャ

```
ブラウザ (xterm.js) <── WebSocket ──> Fastify <── node-pty ──> claude / opencode / copilot / codex CLI
                    <── HTTP REST ──>         (ディレクトリ一覧 API)
```

| レイヤー | 技術スタック |
|----------|-------------|
| Frontend | React 19 + Vite + xterm.js |
| Backend  | Node.js + Fastify + @fastify/websocket + node-pty |

## 必要な環境

- Node.js >= 22.13 / npm >= 9（組み込みの `node:sqlite` を使用。サーバーは起動時に SQLite (`ccserver.sqlite3`) を open し、migration 失敗時は明示的なログとともに起動を拒否します）
- C++ コンパイラ（node-pty のビルドに必要。Arch: `base-devel`、Ubuntu: `build-essential`）
- 対応する AI CLI のいずれか 1 つ以上 — Claude Code、[opencode](https://opencode.ai/)、[GitHub Copilot CLI](https://github.com/github/copilot-cli) (`copilot`)、[OpenAI Codex CLI](https://developers.openai.com/codex/cli/) (`codex`) の各CLIは個別に任意です。サーバーにインストールされているCLIだけを起動時に選べます。
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) — Usage表示など、一部の機能で使用します。インストールされていない場合も、opencodeやCopilot CLIだけで通常のセッションを利用できます。Usageボタンは Codex CLI (下記) でも利用できます。
- [opencode](https://opencode.ai/) — インストール: [公式サイト](https://opencode.ai/)を参照。入れずに選んだ場合、ターミナルに `execvp(3) failed` 等のエラーが表示され起動に失敗します。
- [GitHub Copilot CLI](https://github.com/github/copilot-cli) (`copilot`) — インストール: `npm i -g @github/copilot` (またはインストールスクリプト / `brew install copilot-cli` / winget)。入れずに選んだ場合も同様に起動に失敗します。認証は初回 `/login` (OAuth) か環境変数 `GH_TOKEN` / `GITHUB_TOKEN` で行います。
- [OpenAI Codex CLI](https://developers.openai.com/codex/cli/) (`codex`) — OpenAI公式手順でインストールします。新規起動は `codex`、モデルは `--model <model>`、再開は `codex resume <id>` または `codex resume --last` です。Usage表示は `codex app-server` のJSON-RPC (`account/rateLimits/read`) を使用します。

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

> **Note:** シェルに `NODE_ENV=production` が設定されていると、`npm install` / `npm ci` は devDependencies (vite 等) を省略するため `npm run build --workspace=client` が `vite: not found` で失敗します。その場合は `npm install --include=dev` でインストールしてください。なお ccserver が起動するセッションには `NODE_ENV` / `PORT` / `CCSERVER_*` は引き継がれません (サーバー専用の変数として除外されます)。

ブラウザで http://localhost:3001 を開く。ポートは環境変数 `PORT` で変更可能 (`PORT=8080 NODE_ENV=production node server/index.js`)。

常駐させたい場合は [systemd でバックグラウンド実行](#systemd-でバックグラウンド実行)、Tailnet 内から HTTPS で見たい場合は [Tailscale Serve で HTTPS 公開](#tailscale-serve-で-https-公開) を参照。

## 使い方

1. ディレクトリブラウザでフォルダを選択
   - **シングルクリック** → フォルダ内に移動
   - **ダブルクリック** → そのフォルダで (既定の設定のまま) 起動
   - **Back** ボタン → ディレクトリ選択に戻る
   - **`.md` / `.txt` のファイル名クリック** → その場でプレビュー (ダウンロード不要)。Markdown はレンダリング表示と Source 表示を切替可。先頭 1 MiB まで表示、中身がバイナリならエラー表示。他の拡張子は右端の ↓ でダウンロードのみ。Markdown 内の画像・動画・iframe 等は読み込まれず (プレビューを開くだけでは外部へ通信しない)、画像は `[image: alt]` の代替表示になります
2. ブラウザ内ターミナルで操作

### 起動 (アプリ・サンドボックス)

起動ボタン右の **▼** から開くモーダルで、起動方法を選べます:

| 項目 | 選択肢 | 記憶される場所 |
|------|--------|----------------|
| アプリ | Claude Code / opencode / GitHub Copilot / OpenAI Codex | ブラウザの `localStorage` (次回以降の既定) |
| 起動モード | 通常起動 / 🔒 サンドボックスで起動 | 同上 |
| GPG署名を使う | on/off (既定 off) | `localStorage` に**ディレクトリ単位**で |
| ssh-agentを転送する | on/off (既定 off) | 同上 |

サンドボックス・GPG・ssh-agent の詳細は [サンドボックス (bwrap + rootless docker)](#サンドボックス-bwrap--rootless-docker) を参照。「アプリ」と「起動モード」のどちらの項目をクリックしても、選んだ内容で即座に起動します。

コンボ起動のロール別アプリ選択 (ワーカーA / ワーカーB / オーケストレーター) もブラウザの `localStorage` に記憶され、次回のコンボ起動の既定になります (初期値: ワーカーA・オーケストレーターが Claude Code、ワーカーB が opencode)。各ロールで Claude Code / opencode / OpenAI Codex を選択可能です（copilot のみ不可）。単発起動の「アプリ」記憶とは独立しており、コンボ起動には `defaultApp` は適用されません。

**Worker プリセット**: 表示名・ロール・CLI・モデルを1組み合わせにした起動テンプレートをサーバー共有で保存でき (SQLite `ccserver.sqlite3`、`CCSERVER_DB_PATH` で変更可)、コンボモーダルの「Worker プリセット」から複数選択して起動できます。ロール (`workerImplement` 等) は MCP handoff・git worktree・セッション識別子として使われる技術識別子で、表示名とは独立です。プリセットの追加・編集・削除は「プリセット管理」ダイアログから行え、選択済みの行や起動済みグループには影響しません (起動時にスナップショットとして展開されるため)。プリセット一覧の取得に失敗した場合も、従来どおりワーカーA/Bのドラフトで起動できます。起動済みグループのタブでは、表示名があるメンバーは「実装担当（workerImplement）」のように表示されます。

新規セッションの既定アプリ・サンドボックス設定は `sandbox.config.json` (下記「設定ファイル」参照) でサーバー全体の初期値を決められますが、上記モーダルで一度でも明示的に選んだ後はブラウザ側の記憶が優先されます。

**サーバーにインストールされていない CLI は選択できません**: ccserver は起動モーダル表示時にサーバー側の実行ファイル解決 (PATH・サーバーの node バイナリディレクトリ・`~/.local/bin`・アプリ別ディレクトリ) を確認し、見つからないアプリはグレーアウトされます (ツールチップ「サーバーに未インストール」)。既定アプリが未インストールの場合も、利用可能なアプリへ自動で切り替えます。何らかの経路で未インストールのアプリが指定された場合 (例: 予約プロンプトの自動再開)、サーバーは `Cannot launch: <app> is not installed on this server (searched ...)` という明示エラーを返します。インストール/アンインストールした場合はブラウザを再読込すれば反映されます。

opencode を選んだ場合の挙動の違い:

- **クリップボード同期 (OSC 52)**: opencode がターミナルに書き込む OSC 52 シーケンスをブラウザが解釈し、システムクリップボードへ反映します (xterm.js は OSC 52 を無視するため、ccserver 側で処理)。
- **TUI ネイティブスクロール**: opencode は独自の代替画面バッファでスクロールするため (xterm.js 自体のスクロールバックは効きません)、マウスホイール/タッチドラッグは合成ホイールイベントとして、ターミナル下部のスクロールボタンは opencode のメッセージスクロールキー (PageUp/PageDown, Ctrl+G/Ctrl+Alt+G) として中継されます。
- **列数の確保**: 狭い画面 (スマホ等) では、opencode のプロンプト表示 (agent · model · provider 行) が折り返して画面の大半を占領しないよう、68 列を下限にフォントサイズを自動で縮小します。
- Usage ボタン (下記) は Claude Code の `/usage` 専用のため、opencode セッションでは非表示になります。

GitHub Copilot を選んだ場合:

- コマンドは `copilot`。認証情報 (`~/.config/github-copilot` の `hosts.json`) と設定 (`~/.copilot`) はサンドボックスにも rw で見えるため、ログイン状態・モデル選択・セッション履歴はサンドボックス起動でも維持されます。
- **再開は `copilot --continue`** (最後のセッションへの再開) のみです。会話 ID を指定しての再開はできません (copilot の TUI は ID を出力しないため)。exit 後のセッション一覧からの再開や、予約プロンプト発火時の自動復帰も `--continue` で行われます。
- モデル入力欄に入れたモデル名は `--model <model>` として渡されます。
- Usage ボタンは Claude Code 専用のため非表示になります。
- **コンボ起動 (下記) では選択できません**: copilot には MCP を CLI 引数/環境変数で注入する仕組みが無い (設定ファイル経由のため) ので、グループメンバーにしても ccserver の MCP broker ツールが使えません。コンボのメンバーには claude / opencode / OpenAI Codex が選べます（copilot のみ不可）。Codex は `-c mcp_servers...` でプロセススコープに注入されるため `~/.codex/config.toml` を変更せずに利用できます。

OpenAI Codexについて:

- 単体起動でモデル入力と `codex resume` / `codex resume --last` を利用できます。CodexのTUI出力からセッションIDは推測しません。
- Codexの永続 `codex mcp add` は自動実行しません。ccserverは起動単位の `-c mcp_servers.<name>=...` でMCPを注入するため、`~/.codex/config.toml`を変更せずにコンボ起動でも利用できます。
- サンドボックスではプロジェクト単位の永続HOME内に `~/.codex` を保持します。Codex自身のsandbox/approval policyはccserver側から無条件に緩和しません。

### 予約プロンプト (タイマー)

ターミナルヘッダの時計 (⏰) ボタンから、指定時刻に任意のプロンプトを自動投入できます。
5 時間の利用制限で停止したとき、解除時刻に「続けて」などを予約しておくと自動再開します。

- 時刻は **サーバーのタイムゾーン**で解釈されます (Claude Code が表示する制限解除時刻と一致)。パネルに現在のサーバー時刻とタイムゾーンを常時表示します。
- 過ぎている時刻は翌日として扱います。
- 予約はディスク (`.scheduled-prompts.json`) に永続化され、**ブラウザを閉じても、サーバーが再起動・クラッシュしても発火します**。発火時にセッションが生きていなければ、`claude --resume` (opencode は `opencode -c`、copilot は `copilot --continue`) で会話を自動復帰させてからプロンプトを投入します (元の cwd / サンドボックス設定も復元)。サーバー停止中に発火時刻を過ぎた予約は、起動直後にまとめて発火します (12 時間以上前に過ぎた物は破棄)。
- **セッション制限ヒットの自動予約**: role/app を問わず、出力に `"You've hit your session limit · resets HH:MM(am/pm) (Timezone)"` が現れると自動検知し、そのメッセージが示すタイムゾーンで解釈した解除時刻の **1 分後**に「セッション制限がリセットされました。作業を続けてください。」を自動予約します (手動予約とは違い、こちらは表示中のメッセージのタイムゾーンをそのまま使うので、サーバーのタイムゾーンと一致していなくても正しく発火します)。ユーザーが⏰パネルで既に予約を入れている場合はそちらを優先し、自動予約は上書きしません。
- **時刻欄の自動初期値**: ⏰パネルを開くと、直近に判明しているセッション制限の解除時刻 (上記の自動検知、または Usage ボタンの `/usage` 取得のいずれか新しい方) があれば時刻欄に自動でセットされます。何も分かっていない場合は空のままです。手入力すれば上書きされ、既に予約が有効な場合はセットされません。Claude Code セッションのみが対象で、opencode / copilot セッションでは自動セットされません。

### ccserver-notify (通知用 MCP)

エージェントが**自分で呼べる**通知ツール `notify` を提供する MCP サーバーです。旧来の「一定時間アイドル → ブラウザに `input_needed` 通知」というヒューリスティックは実質機能していなかった (アイドル判定が主観的・非フォーカス時のみ等) ため**廃止**され、この MCP に置き換わりました。

- 配信先は最大 3 種類で、設定されているものすべてに**並行**配信されます:
  1. **Discord webhook** — `sandbox.config.json` の `notify.discordWebhook` (https のみ) または環境変数 `CCSERVER_DISCORD_WEBHOOK` (こちらが優先)。webhook URL は `.gitignore` 済みの `sandbox.config.json` に入れるため、リポジトリに混入しません。
  2. **ランタイム購読 (webhook URL)** — MCP ツール `subscribe` で登録した任意の webhook (`unsubscribe` で解除、`list_subscriptions` で一覧)。購読は `.saved-notifications.json` に永続化され、サーバー再起動後も生き残ります。
  3. **Vikunja タスク** — `notify.vikunja` (`baseUrl` + `apiToken`) を設定すると、`notify` 呼び出しごとに Vikunja タスクを作成/更新します。Discord は見逃されがちですが、Vikunja はタスクとして残るため「人間の対応待ち」を TODO として拾えます。詳細は次項。
- **設定例** (`server/sandbox.config.json` に追記):

  ```json
  {
    "notify": {
      "discordWebhook": "https://discord.com/api/webhooks/...",
      "subscriptions": [
        { "url": "https://hooks.example.com/slack", "name": "slack" }
      ],
      "vikunja": {
        "baseUrl": "https://vikunja.example.com",
        "apiToken": "",
        "projectId": 3
      }
    }
  }
  ```

  `subscriptions` は**初期購読のシード**です。購読ゼロ + Discord 未設定 + Vikunja 未設定だと MCP 自体が注入されないため、購読だけから始めたい場合はここで seed します (MCP が無いと `subscribe` を呼べないため)。Vikunja だけ設定した場合 (Discord 未設定・購読ゼロ) も MCP は注入されます。
- **発信元属性 (自動付与)**: 各通知のペイロード末尾に、どのセッションから送られたかを示すフッターが自動で付与されます (`notify.hostname` 未設定なら OS の hostname、`CCSERVER_HOSTNAME` 環境変数が最優先):

  ```
  🚨 Build failed
  details here

  _from: myhost · myproject · group abc12345 · session 01234567
  ```

  - `<host>` は常に付与 (複数ホストで同じ webhook を共有する場合は `notify.hostname` で固定できます)。
  - `<project>` はセッションの cwd の basename、`group <…>` はコンボのグループ ID 先頭 8 文字 (スタンドアロンでは付かない)、`session <…>` はセッション ID 先頭 8 文字です。
  - フッターを出したくない場合は `notify.attribution: false` で丸ごと無効化できます (既定 `true`)。
- **注入条件**: スタンドアロン (グループ外) のエージェントセッションと、コンボ起動の**オーケストレーターのみ**に注入されます。シェル・コンボのワーカーには注入されません。サンドボックス内外どちらでも動作します (サンドボックス内はソケットを bind、外はホストの node でブリッジを実行)。
- **ツール**:
  | ツール | 引数 | 説明 |
  |--------|------|------|
  | `notify` | `title`, `body`, `level?` (`info`/`success`/`warning`/`error`) | 全チャネルへ配送。`{ ok, delivered: { discord, webhooks, failed, vikunja? } }` (`vikunja` は Vikunja 未設定時は省略) |
  | `subscribe` | `url` (https のみ), `name?` | webhook 購読を追加・永続化。`{ ok, subscription }` |
  | `unsubscribe` | `subscriptionId` | 購読を削除・永続化。`{ ok }` / `{ error: 'not-found' }` |
  | `list_subscriptions` | – | `{ subscriptions: [...] }` |
- 配送は Discord 互換 JSON `{ content, username: 'ccserver' }` を global `fetch` で POST します (10 秒 timeout)。失敗してもエージェント側にはエラーを返さず、ログのみ (非ブロッキング)。
- 予約プロンプト発火 (`schedule_fired`) のブラウザ Notification とヘッダの通知トグルは**独立した稼働機能**のため温存しています。`input_needed` に関するブラウザ側の `onAttention` / attention タブ表示も削除されました。

#### Vikunja 連携

`notify.vikunja` (`baseUrl` https のみ + `apiToken`、両方必須) を設定すると、`notify` 呼び出し1回ごとに Vikunja タスクを作成/更新します (`server/ws/vikunjaClient.js`)。

- **追跡単位**: `groupId` (無ければ `sessionId`) をキーに、進行中のタスク ID を `.saved-vikunja-tasks.json` (`.gitignore` 済み) に永続化します。identity が無い呼び出し (`groupId`/`sessionId` どちらも無し) は Vikunja 連携をスキップし、Discord/webhook のみ配送します。
- **オーケストレーターの運用フロー (開始報告)**: コンボ起動のオーケストレーターは、人間から新しいタスクを引き受けたら作業投入の前に `notify({ title: '開始: <概要>', body: '<スコープ/分担>', level: 'info' })` を**タスクあたり1回だけ**呼びます (オーケストレーター注入テンプレート `server/ws/orchestrator-template.md` の Notification discipline に明記)。この初回 `info` がグループの追跡タスクを自動作成 (`status-running`) し、以後の通知は同一タスクへのコメントになり、完了時の `notify(success)` で done 化します。開始報告を省くとそのタスクは Vikunja 上で追跡されません。Vikunja 未設定環境では Discord/webhook 配送のみ行われます。
- **初回**: 新規タスクを作成 (`title` = notify の `title`、`description` = `body` + 送信元フッター)。**2回目以降 (同じキー)**: タスクへコメントを1件追記 (`title` を先頭行、`body` を本文)。タスクの説明欄そのものは書き換えません。
- **状態はラベルで表現** (`notify.vikunja.statusLabelPrefix`、既定 `status-`)。`success` の場合のみ Vikunja タスクを実際に `done: true` にします (`POST /tasks/{id}` の部分更新、title/description 等の他フィールドは変更しません)。それ以外のレベルでは done にせず、タスクの削除も行いません:

  | `level` | ラベル | 意味 | 追跡終了? |
  |---|---|---|---|
  | `info` (既定) | `status-running` | 進行中の経過報告 | いいえ |
  | `success` | `status-completed` | 完了 | **はい** (次の `notify` は新規タスクとして扱う)。Vikunja タスクも `done: true` にします |
  | `warning` | `status-blocked` | 詰まっている、判断待ち | いいえ (done にはしません) |
  | `error` | `status-needs-input` | 人間の判断が必要 | いいえ (done にはしません。人間が Vikunja 上で手動対応する運用です) |

- ラベルが存在しなければ自動作成します (色付き)。ラベルは Vikunja アカウント単位 (プロジェクト単位ではない) です。
- **リトライ**: 4xx は即座に諦め、5xx / 接続エラー / タイムアウト (`notify.vikunja.timeoutSeconds`、既定15秒) のみ指数バックオフで最大3回試行。失敗してもエージェント側にはエラーを返さず `console.warn` にログを残すのみ (URL やトークンはログに出さず、失敗種別とステータスコードのみ)。
- **notify 自体の有効化条件にも算入**: `discordWebhook` 未設定・購読ゼロでも `notify.vikunja` (baseUrl + apiToken) だけで notify MCP が注入されます。
- `apiToken` は秘匿値なので `sandbox.config.json` への直書きより環境変数 `CCSERVER_VIKUNJA_API_TOKEN` を推奨します (`baseUrl`/`projectId` も `CCSERVER_VIKUNJA_BASE_URL`/`CCSERVER_VIKUNJA_PROJECT_ID` で上書き可)。`projectId` が未設定のままだとタスク作成はできません (warning ログのみ、エラーにはしません)。

### 使用量 (Usage) ボタン

画面上部タブバー右端の **Usage** ボタンから、Claude Code の `/usage` または Codex の利用率 (セッション/週次相当の利用率・リセット時刻・プラン) をポップオーバーで確認できます。ボタンには現在セッションの使用率と、現在表示中のアプリを示すバッジ (`(claude)` / `(codex)`) が常時表示されます (opencode / copilot セッションでは非表示)。ポップオーバーは**前回ポップオーバー内で選択したアプリをブラウザに記憶して**開きます (OpenCode などのターミナルを開き直しても表示は元に戻りません)。記憶がない初回のみアクティブなタブのアプリ (claude / codex) を既定とし、両方インストールされている場合はポップオーバー内の **Claude / Codex タブ** でいつでも切り替えられます (バッジも切り替えに追従します。記憶したアプリがアンインストールされた場合は、もう片方へ自動的にフォールバックします)。

- **Claude**: 裏側で `claude --ax-screen-reader` を短時間起動して `/usage` の描画をパースします (`/usage` の閲覧自体は API を消費しません)。
- **Codex**: `codex app-server` を起動し、JSON-RPC (`account/rateLimits/read`) でレート制限のスナップショットを直接取得します。TUI 描画のスクレイピングではないため、起動待ちやプロジェクト信頼ダイアログのハンドリングは不要です。
- どちらも結果を約 1 分キャッシュします。「更新」ボタンで即時に再取得できます。
- bwrap がある環境では、**該当 CLI の設定だけを見せる最小サンドボックス** (docker/gpg/ssh なし) で起動します。無ければ CLI を直接起動します。
- API: `GET /api/usage?app=claude|codex` (`&force=1` で強制再取得、`app` 省略時は `claude`)。サーバー起動時に両方のキャッシュを 1 度ウォームします。
- ボタンは設定ファイルの `showUsage: false` で非表示にできます。さらに **claude/codex のどちらもサーバーにインストールされていない環境では、設定に関わらず自動的に非表示**になります (この場合 `GET /api/usage` は `claude is not installed on this server` / `codex is not installed on this server` を返します)。片方だけインストールされている場合はボタンは表示され、ポップオーバー内のタブ切替はそのインストール済みの 1 つだけになります。

### ccserver-usage (使用量参照用 MCP)

エージェントが**自分で**上記の Usage スナップショットを読める MCP ツール `get_usage` を提供します。`ccserver-notify` とは独立した別の MCP サーバーで、`server/usage.js` の `getUsage()` (上記ボタンが叩くのと同じキャッシュ/キャプチャロジック) を同一プロセス内で直接呼ぶだけです (HTTP 経由ではありません)。

- **ツール**: `get_usage({ force?: boolean })` — `{ usage, updatedAt, cached, sandboxed?, error? }` を返します (`GET /api/usage` と同じ形)。`force: true` で強制再取得 (最大 15 秒程度かかることがあります)。
- **注入条件**: **`claude` セッションのみ** (`/usage` は Claude Code CLI 固有の機能のため opencode/copilot には注入されません)。シェルセッションには注入されません。`ccserver-notify` と異なり、コンボのワーカー/オーケストレーター/スタンドアロンは区別せず、対象となる claude セッション全てに注入されます。
- **オプトイン**: デフォルトでは注入されません。サーバーに claude バイナリがインストールされ、設定ファイルで `usageMcp: true` を明示した場合のみ注入されます。Usage ボタンの `showUsage` 設定とは独立しています。
- サンドボックス内外どちらでも動作します (サンドボックス内はソケットを bind、外はホストの node でブリッジを実行) — 仕組みは `ccserver-notify` と同じパターンですが、`get_usage` は接続元によらず同じ結果を返すため識別情報 (identity) は一切やり取りしません。

### ccserver-meta (メタエージェント用 MCP)

ccserver 自体を MCP 経由で操作できる特権エージェント (**メタエージェント**) 向けの MCP サーバーです。プロジェクト/サンドボックス/グループ/セッションの一覧参照から、セッションやコンボの新規起動、プリセット管理、破壊的操作の実行までをカバーします。`ccserver-notify` / `ccserver-usage` と同じくプロセスグローバルな単一ソケット (`ccserver-meta.sock`) でホストされますが、サーバー全体 (全グループ・全サンドボックス・全プロジェクト) へのアクセスを持つ**単一の信頼されたエージェントにのみ渡す**前提のため、注入条件は両者とは別になっています。

- **オプトイン**: 既定では無効です。設定ファイルで `metaAgentMcp: true` を明示した場合のみ有効化され、さらにセッション起動時に明示的にメタエージェントとして指定された単発セッションにだけ注入されます。コンボのワーカー/オーケストレーターへ自動注入されることは一切ありません (強い権限を持つため、既定オフは `usageMcp` よりさらに強く推奨されます)。
- **固定ディレクトリ起動**: メタエージェントは常にプロジェクト外の固定ディレクトリ `~/.local/share/ccserver-sandbox/meta-agent` で起動されます。ブラウザや API が指定する `cwd` はサーバー側で無視され、プロジェクトのファイルや `CLAUDE.md` が特権セッションに混入することを防ぎます (サーバー側 `createSession` の不変則として強制。`metaAgentMcp` がオフでも flag 付きなら固定化される)。サンドボックスもこの固定ディレクトリ基準で作成され、通常の起動方法選択とは分離した専用の「⌘ メタエージェント」ボタンから起動します。単一の固定ディレクトリのため同時起動はクライアント側の確認で制御され、永続 HOME も `meta-agent` 専用のものが作成されます。
- **ツール一覧** (権限区分: **R** = 読み取り専用 / **W-low** = 設定データの作成・変更・削除のみ / **W-create** = 新しいセッション・グループの起動 / **W-destructive** = 実行中リソースの終了・削除。W-destructive のみ承認必須):

  | 区分 | ツール | 説明 |
  |------|--------|------|
  | R | `list_projects` | プロジェクト一覧 (表示ラベル / git remote / 最終利用時刻) |
  | R | `list_sandboxes` | サンドボックス一覧 (サイズ / 利用中・削除中状態 / 所属プロジェクト) |
  | R | `browse_directory` | 指定パスのディレクトリ・ファイル一覧 (`GET /api/dirs` 同等) |
  | R | `list_groups` / `get_group` | コンボグループの一覧・メンバー詳細 |
  | R | `list_sessions` | 全セッション一覧 |
  | R | `list_worker_presets` / `list_launch_presets` | Worker プリセット・コンボ起動プリセットの一覧 |
  | W-low | `create_worker_preset` / `update_worker_preset` / `delete_worker_preset` | Worker プリセットの CRUD (既存 REST API と同水準・確認なし) |
  | W-low | `create_launch_preset` / `update_launch_preset` / `delete_launch_preset` | コンボ起動プリセット (複数ワーカーを一括起動するテンプレート) の CRUD |
  | W-low | `update_project_label` | プロジェクトの表示ラベル変更 |
  | W-low | `create_directory` | フォルダ作成 (`{ parent, name, gitInit? }`) |
  | W-create | `launch_session` | 単発セッションの新規起動 (`POST /api/sessions` 相当) |
  | W-create | `launch_group` / `launch_from_preset` | コンボの新規起動 (`POST /api/groups` 相当) / プリセットからの展開起動 |
  | **W-destructive** | `close_session` / `destroy_group` / `delete_sandbox` | セッション強制終了 / グループ破棄 / サンドボックス削除。**必ず下記の承認フローを経由します** |

- **承認フロー (W-destructive)**: 破壊的ツールが呼ばれると、サーバーは操作を即座には実行せず `pending_approvals` に記録してブラウザ UI からの判断を待ちます (その間、MCP ツール呼び出し自体がブロックされます)。ブラウザ側では画面上部の**グローバルバナー** (どのタブを開いていても表示) に操作内容の要約 (`summary`) が列挙され、**承認 / 却下** を選べます。バナーは `GET /api/approvals?status=pending` を数秒間隔でポーリングして更新され、判断は `POST /api/approvals/:id/decision { decision: 'approved' | 'rejected' }` で送信されます。
- **タイムアウトは 5 分固定で、未応答のリクエストは常に「拒否」扱い**になります (fail-safe は常に「何もしない」側)。また、メタエージェントが**自分自身のセッションや自分の所属グループ**を対象に破壊的操作を呼んだ場合は、承認フローに回さずその場でエラーとして拒否されます (fail closed — 自己終了・自己破壊はどんな理由でも代行させません)。`delete_sandbox` については、メタエージェント自身がそのサンドボックス HOME 内で稼働中なら既存の「使用中」ガードが自然に自己削除を防ぎます。
- **サンドボックス権限のキャップ**: メタエージェントが `launch_session` / `launch_group` 経由で他セッションに付与する `sandboxOpts` (gpg / sshAgent) は、メタエージェント自身が現在保持する権限でキャップされ、超過分は要求されていても暗黙に downgrade されます (エラーにはなりません)。コンボのオーケストレーターが子ワーカーの権限をキャップするのと同じルールです。

### 拠点間 (federation) ペアリング

複数の ccserver インスタンス (別マシン・別ネットワーク上でもよい) を**ペアリング**すると、ブラウザの **Remote** タブから他インスタンスのセッション/コンボの**一覧・起動・端末操作**ができます。現時点 (Phase 1) では一覧・起動・端末 I/O 中継のみが対象で、あるインスタンスのオーケストレーターが別インスタンスの MCP ツールを直接操作する分散コンボ (Phase 2) は未実装です。

- **オプトイン**: 既定では無効です。`CCSERVER_FEDERATION_PORT` 環境変数を設定した場合のみ、メインの Fastify ポートとは別listenerとして相互 TLS (mTLS) の待受を開始します。未設定 (または `0`) なら federation 機能自体が丸ごと無効になり、`Settings` タブにも `GET /api/federation/identity` にも「無効」と表示されます。

  ```bash
  CCSERVER_FEDERATION_PORT=3210 NODE_ENV=production node server/index.js
  ```

- **信頼モデル**: 各インスタンスは初回起動時に自己署名 Ed25519 証明書を1組生成し (`openssl` が必要。無い環境では federation は無効のまま動作を継続します)、`~/.local/share/ccserver-sandbox/federation/{instance.key,instance.crt}` に `0600` で保存します (`CCSERVER_FEDERATION_HOME` で置き場を上書き可能)。federation ポートの TLS は **CA 検証を完全に無効化**しており、代わりに「ペアリング時に人間が承認して pin した証明書 fingerprint (`fingerprint256`) との完全一致」だけを信頼根拠とします。SSH のホスト鍵 + `known_hosts` と同じメンタルモデルです。
- **双方向承認が必須**: どちらから接続を開始しても、**発信側・着信側それぞれの人間が別々にブラウザの承認バナーで fingerprint を確認して承認ボタンを押すまで有効になりません**。片側だけの承認では `active` になりません。承認/却下は `Settings` タブの上に出るグローバルバナーから行います (`GET /api/federation/pending` を数秒間隔でポーリング)。取り消しはいつでも `Settings` タブの「ペアリング済みインスタンス」一覧から (相手には通知されません。相手側から見ると以後の接続が単に拒否されるだけです)。
- **自己申告アドレスの到達性**: ペアリング相手が後からこちらへ接続し直せるよう、自分の `<ホスト名>:<CCSERVER_FEDERATION_PORT>` を相手に伝えます。ホスト名は `CCSERVER_HOSTNAME` 環境変数 (未設定なら `ccserver-notify` の footer と同じ解決順) が使われるため、Tailscale などフラットなネットワークでない構成では **`CCSERVER_HOSTNAME` に相手から解決できるホスト名を明示してください** (でないと相手が pending 状態から `active` へ進めません)。
- **ペアリング時のトークン要求 (任意)**: `sandbox.config.json` の `federation.requireTokenForPairing: true` を設定すると、ペアリング開始リクエスト (bootstrap) にだけ相手側の `CCSERVER_TOKEN` の提示を必須にできます。あくまでスパム対策で、**トークンが合っていても人間の双方向承認は省略されません**。
- **できること (Remote タブ)**: ペアリング済みで `active` なインスタンスごとに、実行中セッション/コンボの一覧、新規セッション/コンボの起動、既存セッションへの接続 (通常のターミナルタブと同じ xterm 画面で、入出力は federation 経由で中継されます) ができます。コンボのメンバーは個別の通常セッションとして開けます (ローカルの3ペイン統合ビューとは異なります — MCP によるハンドオフはあくまで相手インスタンス内で完結する仕組みのため)。
- **できないこと (Phase 2 未実装)**: あるインスタンスのオーケストレーターが別インスタンス上に直接ワーカーを生成・操作する分散コンボ。REST API 経由で REST/端末 I/O を中継しているだけで、MCP ソケットそのものを跨マシンで公開しているわけではありません。

### コンボ起動: ロール別 git worktree

コンボ起動の各ワーカー (workerA/workerB や `open_tab` で追加されたロール) は、プロジェクトが git リポジトリであれば**ロールごとに独立した git worktree** で起動します。以前は全ワーカーが同一チェックアウトを共有しており、別ブランチでの並行 git 操作 (実装とレビューを別ワーカーが同時に行う等) が衝突する事故が起きていたため、この分離が導入されました。

- 配置先はプロジェクトディレクトリの**外** (`~/.local/share/ccserver-sandbox/worktrees/<プロジェクトのハッシュ>/<ロール>/`) — `orchestratorDir` や永続 HOME と同じ置き場ポリシーで、ユーザーの `git status` やエディタのファイルツリーに紛れ込みません。
- サーバーは `git worktree add --detach` で作るだけで、**作業ブランチの作成は一切行いません**。git の排他制約は「同一ブランチの同時チェックアウト」にのみ発生し、複数の worktree が同じコミットを detached HEAD で同時に指すのは無条件に可能なため、実際のブランチ作成・チェックアウトは worktree の中で動くエージェント自身の `git checkout -b ...` に委ねられます。
- ロールが再起動・再接続 (ブラウザ再読込、`open_tab` によるロール差し替え、サーバー再起動後の復帰) しても、既存の worktree はそのまま (チェックアウト状態を変更せず) 再利用されます。
- worktree がディスクから失われていた場合 (サーバークラッシュ・手動削除等) は、次回そのロールが (再) 起動するタイミングで自動的に作り直されます。作業ブランチ自体が生き残っていれば再アタッチされ (未コミットの変更のみ喪失)、ブランチ自体も失われていた場合は起動時点の HEAD から detached で新規作成されます。**実際に作業内容が失われた場合は `ccserver-notify` (下記) 経由で必ず通知されます** — ログ警告のみで済ませることはありません。
- ロールを `close_tab` で閉じる、またはグループを破棄すると worktree は削除されます。未コミットの変更が残っていて `git worktree remove` が失敗する場合は、削除せずログ警告のみに留めます (作業内容を消すリスクを避けるため、強制削除はしません)。削除に失敗して残った worktree は、次回サーバー起動時に「どのグループにも属さないディレクトリ」としてログに警告が出ます (自動削除はされません)。
- プロジェクトが git リポジトリでない場合は worktree 化をスキップし、従来どおり全ロールが同じ cwd を共有します。
- **単発起動 (コンボでない通常のセッション) には一切影響しません。**

副作用として、ロールごとに cwd が分かれることで**永続 HOME と docker の data-root もロールごとに独立**します (詳細は下記「サンドボックスの再利用」「同じプロジェクトを2つのサンドボックスで開いた場合」を参照)。

コンボのロール間でファイルではなくテキストを直接受け渡したい場合 (例: workerA が書いた plan を workerB に渡す) は、`publish_doc`/`fetch_doc`/`list_docs` MCP ツールを使ってください — 各ロールの `./tmp/` は自分の worktree の中にしかなく、他のロールからは見えなくなりました。

| ツール | 引数 | 説明 | 使えるロール |
|--------|------|------|--------------|
| `publish_doc` | `key`, `content` | 指定した key でドキュメントを公開/上書き。グループの他メンバー全員に見える | ワーカーのみ |
| `fetch_doc` | `key` | `publish_doc` で公開済みのドキュメントを取得。`{ content, publishedBy, publishedAt }` / `{ error: 'not-found' }` | ワーカー・オーケストレーター両方 |
| `list_docs` | – | 公開済みドキュメントの一覧 (`key`/`publishedBy`/`publishedAt`/`size`、本文は含まない) | ワーカー・オーケストレーター両方 |

1 文書あたり 256KB、グループあたり最大 50 件の上限があります。オーケストレーターに `publish_doc` は生えていません (ワーカー間の直接のやり取りが主目的で、ワーカー→オーケストレーターは既存の `handoff_to_orchestrator` を使います)。

コンボのブラウザ<->エージェント間でファイルをやり取りしたい場合 (例: スマホ画像をエージェントに渡す、エージェントが生成したファイルをブラウザでダウンロード) は、グループファイル交換を使ってください — 既存の汎用 `/api/files` とは別経路で、グループIDで完全に隔離されます。

- **ブラウザ -> エージェント**: グループタブの **Files** パネルでドラッグ&ドロップまたはファイル選択でアップロード。エージェントは `list_files` → `fetch_file({ fileId })` で `sandboxPath: /ccserver-group-files/<generated>` を受け取り、サンドボックス内のそのパスを読み取ります (本文バイト列は返しません)。
- **エージェント -> ブラウザ**: エージェントは自分の worktree 内の相対パスで `publish_file({ path })` を呼び出してグループに公開。ブラウザの Files パネルで一覧・ダウンロードできます。絶対パス、`..`、シンボリックリンクによる worktree 外への脱出は拒否されます。
- **HTTP API**: `GET /api/groups/:id/files` (一覧), `POST /api/groups/:id/files` (multipart アップロード), `GET /api/groups/:id/files/:fileId` (ダウンロード), `DELETE /api/groups/:id/files/:fileId` (削除)。ディスクパスは一切受け付けません。
- **MCP**: ワーカーは `list_files` / `fetch_file` / `publish_file`、オーケストレーターは `list_files` / `fetch_file` のみ (publish なし)。すべて `groupId`/role/sessionId を引数に取らず、クロージャに束縛されたグループで隔離されます。
- **制限**: 1 ファイル 50 MiB、1 グループ 20 ファイル、合計 200 MiB。超過時は `too-large` / `too-many-files` / `quota-exceeded` を返します。`mimeType` は表示名から推測、サイズ・公開者・時刻とともに一覧に表示されます。
- **ライフサイクル**: すべての記録/Blob はグループIDで隔離され、グループ破棄時に削除されます。サンドボックス内では各メンバーのグループファイルは読み取り専用で `/ccserver-group-files` にマウントされます。

### コンボ起動: オーケストレーターが `send_input` でワーカーに指示するときの注意

> **copilot はコンボ起動 (グループ) では選択できません** — copilot は MCP を CLI 引数/環境変数で注入する仕組みが無く (設定ファイル経由のため)、グループメンバーにしても ccserver の MCP broker ツール (`send_input` / `wait_for_handoff` 等) が使えないためです。起動モーダルのコンボ UI には選択肢が表示されず、`POST /api/groups` に `app: "copilot"` を渡しても 400 で拒否されます。

コンボ起動 (2 ワーカー + オーケストレーター) では、オーケストレーターが MCP ツール `send_input` でワーカーのターミナルにテキストを流し込みます。実際に「ワーカーのタブが TUI ではなく素のシェルの `$` プロンプトに落ちていた」状態を見落として長文の指示を送り、トラブルになったことがあります (一度はシェルプロセスごと終了、一度は `eval` の構文エラー)。この種の事故を避けるため:

- ワーカータブ (opencode 等) は、直前に TUI が描画されていたように見えても、実際には素のシェルの `$` プロンプトに戻っていることがあります。`send_input` の `settled: true` や、直前の `read_output` で TUI が見えていたことは、**送った内容を実際に TUI が受け取った保証にはなりません**。
- 素のシェルにテキストが渡ると、バッククォート `` ` `` はコマンド置換として評価され、複数行テキストはシェルを継続入力待ち (`>` プロンプト) の状態にしてしまうことがあります。
- そのため `send_input` で送る指示は**短く 1 行にまとめ**、バッククォートや改行などの特殊文字を避けてください。詳細な指示をターミナルに直接貼り付けるのではなく、既存ファイルへの**パス参照**に留めるのが安全です (これは**そのワーカー自身の worktree 内で完結する**、単一ワーカー宛ての指示を短くする用途です。**ロールをまたいだ内容の受け渡し (例: workerA の plan を workerB に渡す) には、共有されなくなった `./tmp/` ではなく `publish_doc`/`fetch_doc` を使ってください** — 上記「コンボ起動: ロール別 git worktree」参照)。この推奨には実機由来の理由がもう1つあります: Codex は長文・箇条書きの指示に対して通常のチャット送信ではなく独自の確認モーダル (`Create a plan? esc dismiss`) を出すことがあり、ワーカーがスピナーも応答も無いまま停止します (下記 `send_key` 項目参照)。
- 送信後は必ず `read_output` で、`command not found` / `許可がありません` / `unexpected token` / `eval` のようなシェルエラーが出ていないか確認してください。
- シェルエラーが出てしまった場合、それを収拾しようとして空入力や Ctrl+C 相当の入力を送ってはいけません。継続入力待ちのシェルに対しては EOF のように作用し、**シェルプロセスごと終了させてしまうことがあります** (実際に一度そうなりました)。`get_tab_status` で `exited: true` を確認したら、そのタブは諦めて `close_tab` → `open_tab` で作り直してください。
- 新規に開いたタブに何かを送る前には、`read_output` で実際にアプリの TUI が描画されていることを確認してから送ってください。
- `send_input` は**純粋なキーストローク送信**であり、セッションのリセット (`/new` 等のスラッシュコマンド) をテキストとして打ち込む用途には使わないでください — スラッシュコマンドの解釈はアプリごとに異なり、`/new\n\n本文` のように1つの text に連結しても「コマンド実行 → 本文送信」の2操作にはなりません (実機の Codex では `/new` が最初の改行で即時実行され、後続本文がセッション名に消費されて消失します)。ワーカーに**まっさらな会話コンテキスト**を与えたいときは control MCP ツール **`new_session`** を使ってください。同一ロール・同一 git worktree・既存の起動設定 (app/model/sandboxOpts) を保ったまま fresh プロセスへ原子的に置換されます (失敗時は旧セッションがそのまま残ります)。`new_session` は指示本文を受け取らないため、戻り値の**新 `sessionId` に対して改めて別の `send_input` を1回呼んで**指示を送ってください。
- **既知の制限と限定復旧 `send_key`**: Codex は長文・箇条書きの指示で確認モーダル (`Create a plan? esc dismiss`) を出すことがあり、そのままでは処理が止まります。静止を単発の `read_output` で確認し、モーダルが見えた場合に限り control MCP ツール **`send_key({ sessionId, key: 'escape' })`** を**1回だけ**送って復旧してください。`send_key` は Escape 専用の group 境界付き復旧手段であり (`escape` 以外のキー・raw bytes・ANSI シーケンスは公開されません)、テキスト送信の代替でも Enter 代替でもありません。Escape 後は元の依頼が届いたかを確認し、必要なら内容を短く 1 行にして別の `send_input` で再送します。連打・ポーリングはしないでください。
- docker を使うタスクをワーカーに振る前には、`list_group_sessions` / `get_tab_status` の `dockerAvailable` を確認してください。同一プロジェクトの rootless dockerd は1つの data-root を1セッションでしか同時に使えず (下記「サンドボックス」参照)、`dockerAvailable: false` のメンバーに docker タスクを振ると失敗します。**「workerA だけが docker を使える」という決め打ちはできません** — 実際には起動順のレースで、逆転することもあります。

#### control MCP ツールの信頼性保証 (handoff と read_output)

- **ハンドオフは失われません**: `wait_for_handoff` はタイムアウト (`{timedOut:true}`) 時に**そのままもう一度呼ぶだけで安全**です。誰も待っていない間に届いたハンドオフはキューに残り、また**待機中に接続が切れても**イベントを消費しないため、再接続後の次の `wait_for_handoff` が必ず受け取ります。サーバー再起動後も未受信ハンドオフは残っています。
- **`read_output` の `screen` / `screenAlt` / `screenIdleMs` を使う**: ワーカーのスピナー等の動的描画はカーソル移動と行消去でその場を書き換えるため、生のバイト列 (`raw` / `text`) からは「今見えている画面」を復元できません。サーバーはセッションごとに軽量な仮想画面 (ANSI 解釈) を維持しており、`screen` が現在の可視画面、`screenIdleMs` が**画面が最後に変化してからの経過** (スピナーが回っていれば小さい値、静止プロンプトなら大きい値) です。stuck/busy 判定は `text` や `idleForMs` (バイトベース) よりこれらを優先してください。`get_tab_status` の `screenIdleMs` も同様です。
- **通常の進捗確認は `wait_for_handoff` の待ち受けで行う (原則)**: `read_output` は進捗ポーリング用のツールではありません。`{timedOut:true}` 自体は異常ではなく (worker が単に長時間作業しているだけの可能性が高い)、そのまま再呼び出しするのが正規の待ち方です。`read_output` を許容するのは具体的な異常シグナルがある場合 (`wait_for_handoff` の連続タイムアウト目安2〜3回、稼働中のはずのメンバーの大きな `idleForMs` / 静止画面が `list_group_sessions` / `get_tab_status` で見つかった、ワーカー自身が異常を報告した) に限定され、その場合も**1回だけ**読んで判断します (`send_input` での nudge または待ち戻り)。この規律はオーケストレーター注入テンプレート (`orchestrator-template.md`) と control MCP の各ツール説明文に反映されています。

#### オーケストレーターから見えるのは repo_info の基本情報だけ

オーケストレーターのサンドボックスにワーカーのディレクトリは**マウントされません** (プロジェクトファイルへの直接アクセスは不可)。代わりに、control MCP サーバーのツール `repo_info` がグループのプロジェクト (cwd) の**基本情報だけ**を返します: トップレベルの構成 (ディレクトリ/ファイル名のみ、100 エントリ上限)、README の先頭 ~8KB、`package.json` の要約 (name/version/description と scripts/dependencies/devDependencies の**キー一覧のみ**、値は返さない、各 50 キー上限)、git 状態 (現在ブランチ / short HEAD / 直近 5 コミットの件名 / 変更ファイル数)。

パス引数は受け取らず (対象はグループのプロジェクトに固定)、読み取り専用で、返る情報はすべてサイズ上限付きです。ソースファイルの内容は返しません。深い調査・コマンド実行・コード修正・判断を伴う作業は、従来どおり MCP ツール (`send_input` 等) 経由でワーカーに任せる必要があります。

## サンドボックス (bwrap + rootless docker)

「🔒 サンドボックスで起動」(上記「使い方 > 起動」参照) を選ぶと、`bwrap` でファイルシステムを制限した状態で起動します。選択したプロジェクトと最小限の設定 (`~/.claude`, `~/.claude.json`, `~/.config/opencode`, `~/.local/share/opencode`, `~/.local/state/opencode`, `~/.config/github-copilot`, `~/.copilot` 等) だけが見え、**隣接する他プロジェクトは見えません**。

docker も安全に使えるよう、サンドボックス**内部**に rootless dockerd を起動します。`rootlesskit` (subuid マッピング) の内側で `bwrap` を動かす構成のため、`docker run -v ...` でもサンドボックス外へは到達できません (daemon 自身が制限された FS の中にいるため)。

### サンドボックスの再利用 (永続 HOME)

既定ではサンドボックスの `HOME` は**プロジェクト毎に永続化**されます (`persistentHome`、既定 `true`)。パスの実体は `~/.local/share/ccserver-sandbox/home/<プロジェクト>` で、セッション中に `pip install --user` や `npm i -g` などで入れたツール・キャッシュ・シェル設定が**次回以降のセッションに引き継がれます** (以前は毎回まっさらな tmpfs のため再構築が必要でした)。隣接する他プロジェクトは引き続き見えません (bind はこの 1 ディレクトリのみ)。

サンドボックス内の `/tmp` も、この永続 HOME 配下 (`.ccserver-tmp`) への**プロジェクト毎の永続 bind** です。fresh tmpfs ではないため、エージェントが `/tmp` に展開したツール・キャッシュ (例: opencode の抽出した Node ランタイム) がセッションを跨いで引き継がれます。`persistentHome: false` の場合は従来どおり `/tmp` も毎回まっさらな tmpfs です。

サンドボックスで起動するとき、そのプロジェクトに前回のサンドボックスが残っていれば**再利用ダイアログ**が表示されます:

- **使用する**: 前回の永続 HOME をそのまま引き継ぎます (ツール・キャッシュ・設定を保持)。
- **新規作成**: 前回の永続 HOME を**破棄**して空の状態から始めます (不可逆)。このプロジェクトのサンドボックスを利用中のセッションがある間は選択できません (`GET /api/sandbox/status` が `inUse` を返し、ダイアログ側で無効化。サーバー側でも起動時に拒否されます)。
- **キャンセル**: 何もせず閉じます。

コンボ起動のワーカー / オーケストレーターのサンドボックスにも永続 HOME の既定動作 (再利用) が適用されますが、ダイアログ・破棄操作の対象は**シングル起動のみ**です。workerA/workerB はそれぞれ別の git worktree (cwd) で起動するようになったため (上記「コンボ起動: ロール別 git worktree」参照)、永続 HOME もロールごとに独立します — 以前はワーカー同士が同じ永続 HOME (同じ `~/.claude` 設定、npm キャッシュ等) を共有していました。

永続 HOME を無効にするには `sandbox.config.json` で `"persistentHome": false`。既存の永続状態をリセットするには `~/.local/share/ccserver-sandbox/home/` 配下の該当ディレクトリを削除してください (ディスク消費の整理も兼ねます)。

> **セキュリティノート**: 永続 HOME はサンドボックス内から書き込み可能な**ホスト上の永続ディレクトリ**です。侵害・暴走したセッションはこのディレクトリ内に `.bashrc` 等を仕込み、**同一プロジェクトの次回セッションで実行させる**ことができます (単発セッション内の挙動が次回以降に持ち越される点が tmpfs HOME との違いです)。対象はそのプロジェクトのディレクトリに閉じていますが、機密プロジェクトで `forceSandbox` を多層防御の一部として使う場合はこの点を考慮してください。

### 設定ページ (作成済みサンドボックス一覧)

ディレクトリブラウザの「Select a Directory」ヘッダー右端の **スパナ (🔧)** ボタンから設定タブを開けます。設定タブには**作成済みサンドボックス**が一覧表示されます:

- 各行はサンドボックスの**実プロジェクトパス** (SQLite の projects/sandboxes テーブルで管理、未知のものは slug)、プロジェクトの**表示ラベル** (設定されている場合) と **git remote**、**最終使用時刻**、**使用容量**、右端の **✕** 削除ボタンで構成されます (旧サイドカー JSON index は DB v2 マイグレーションで取り込まれ、`.index.json.migrated` として退避されます)。
- ✕ を押すと確認ダイアログを経て、そのサンドボックスの永続 HOME (`~/.local/share/ccserver-sandbox/home/<slug>`) と同名の **docker data-root** (`dind/<slug>`) を削除します。
- **利用中のサンドボックス** (生存セッションがマウント中) は「利用中」バッジが付き、✕ は無効化されます (サーバー側でも 409 で拒否)。
- API: `GET /api/sandboxes` (一覧: `name` / `cwd` / `projectLabel` / `gitRemote` / `lastUsedAt` / `size` / `inUse`)、`DELETE /api/sandboxes/:name` (削除)。

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

- 許可: `pr` (create/view/list/edit/comment/merge/close/reopen/ready/review/checks/diff/status/checkout)、`issue` (create/view/list/edit/comment/close/reopen/status)、`release` (create/view/list/edit/delete/upload/download/delete-asset)、`workflow` (view/list はcwdフォールバック可、`run`/`enable`/`disable` は `--repo`/`-R` の明示が必須 — 下記)、`run` (list/view/watch)、`repo view`、`gh api` は **`repos/OWNER/REPO/actions/...` への読み取り専用 GET のみ**。エンドポイントの owner/repo は**リテラル記述が必須**で、`{owner}`/`{repo}` プレースホルダ形式は受け付けません (gh がプレースホルダを独自の基準リポジトリ解決 (cwd origin / `GH_REPO` / `--repo`) から埋め、常に既定の API ホストへ投げるため、ブローカーが照合したリポジトリと実際の要求先が食い違う可能性がある)。
- `workflow run`/`enable`/`disable` はトリガー/書き込み系 (CI 起動、workflow 自体の on/off) のため、**`--repo`/`-R` の明示が必須**で、作業ディレクトリの origin への暗黙フォールバックは行いません。この制限は `run`/`enable`/`disable` のみに適用され、以前は `--repo` 無しでもそのまま通っていた挙動を狭める破壊的変更です (それ以外の読み取り系サブコマンドは従来通り cwd フォールバック可)。
- 対象リポジトリは `--repo`/`-R` フラグ (`OWNER/REPO`, `HOST/OWNER/REPO`, URL) があればそれを、無ければ作業ディレクトリの origin リモートを使い、いずれも許可リストと照合されます (`--repo` で許可リスト外のリポジトリを指定しても拒否されます)。
- `pr view`/`checkout`/`diff`/`merge`/`close`/`edit` 等は `<number>|<url>|<branch>` を、`repo view` は裸の `OWNER/REPO` も受け付けます。**PR/issue の URL をそのまま位置引数に渡した場合、そのURLが指すリポジトリも許可リストと照合されます** (`--repo`/cwd の判定をすり抜けて無関係なリポジトリを操作させることはできません)。
- **バンドルされた短縮フラグ (`-wR owner/repo` のような1トークンへの複数フラグの結合) は拒否されます**: gh (pflag/Cobra) はこの形を `-w -R owner/repo` と等価に解釈しますが、ブローカー側でこれを正しく再現するのは複雑で壊れやすいため、`-R` 単体または `-Rvalue` (値を直接くっつける形) 以外の複数文字の短縮フラグはまとめて拒否します。個別のフラグ (`-w` 単体等) はそのまま使えます。
- 拒否: `gh api` の Actions 以外のエンドポイント (`graphql`、`/user`、`/orgs/...`、`repos/.../actions` 以外の `repos/...` 系、絶対URL、`{owner}`/`{repo}` プレースホルダ形式、POST 等の書き込み系 — Actions 配下でも `--method` は GET のみ、データ系フラグ `-f`/`--raw-field`/`--field`/`--input`、`--hostname`、短縮フラグは全面的に拒否)、`gh auth`/`gh secret`/`gh variable`/`gh ssh-key`/`gh gpg-key` (認証情報自体の管理)、`gh repo clone`/`fork`/`create`/`delete`/`rename` (対象リポジトリが位置引数で来るため個別のパース対応が必要で未対応)、`gh run rerun`/`cancel`/`delete`/`download` (トリガー/書き込み系) など、上記に無いものは全て拒否されます。
- ブローカー越しの実行はホスト側で TTY なしの子プロセスとして動くため、**非対話的な呼び出し (必要な入力は全てフラグ/stdin で渡す) のみ**サポートします。エディタが開く対話フロー (`gh pr create` をフラグなしで叩く等) は動作しません。

`gitBroker: false` で git 側のゲート・gh ブローカーの両方を無効化できます (git は使えますが ssh-agent が有効なら無制限に、gh はそのまま実行されますが `~/.config/gh` が無いため無認証で失敗します)。

#### 既知の限界

これは「侵害/暴走したプロセスが無関係なリポジトリの認証情報を安易に使ってしまう」事故を防ぐ多層防御であり、意図的にバイパスを試みるコードへの完全な防壁ではありません。以下は主に ssh-agent 転送が有効なときに関係します (既定オフなら SSH 経由の抜け道はそもそも存在しません):

- 転送された ssh-agent ソケットに対し `ssh` バイナリを経由せず直接 ssh-agent プロトコルを話すコードは、宛先チェックをすり抜けて任意ホスト向けの署名を依頼できます。
- **`docker: true` (既定) と ssh-agent 転送を併用する場合、上記よりずっと簡単な迂回経路があります**: サンドボックス内から `docker run` されたコンテナはサンドボックス自身の `/usr/bin/ssh`・`gh` 差し替えを引き継がず、独自のイメージ内の素の `ssh`/`gh` を使えます。転送された `SSH_AUTH_SOCK` は固定の既知パスにバインドされているため、コンテナ側に `-v` でそのソケットを渡すだけで、ラッパーを一切経由しない無制限の ssh-agent アクセスになります。つまり **docker + ssh-agent 転送有効時は gitBroker のリポジトリ制限を強い境界として当てにしないでください**。厳密なスコープが必要なセッションでは ssh-agent 転送を無効 (既定) のままにするか `docker: false` にするか、サンドボックス起動時にコンソールへ出る警告を確認してください。
- サブモジュールの URL は、実際にチェックアウト済み (作業ディレクトリが存在する) のものだけを許可リストに加えます。`.gitmodules` はリポジトリのコンテンツそのものであり信頼できないため、宣言されているだけで未チェックアウトの「サブモジュール」は無視されます (信頼できないリポジトリがでっち上げの URL を許可リストへ紛れ込ませるのを防ぐため)。
- 許可リストはセッション起動時に一度だけ算出するため、セッション中に追加/チェックアウトしたサブモジュールや変更した gh の許可サブコマンドは次回起動まで反映されません。

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
  "forceSandbox": false,
  "defaultApp": "claude",
  "showUsage": true,
  "usageMcp": false,
  "metaAgentMcp": false,
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
| `persistentHome` | `true` | プロジェクト毎の永続 HOME を有効化 (下記「サンドボックスの再利用」参照)。`false` で従来どおり毎回まっさらな tmpfs HOME。 |
| `gpg` | `false` | コミット署名用に gpg-agent を転送 (上記参照)。UI で上書き可。 |
| `sshAgent` | `false` | ssh-agent を転送 (上記参照)。UI で上書き可。 |
| `gitBroker` | `true` | git/gh の認証情報スコープ制限 (上記参照)。 |
| `forceSandbox` | `false` | `true` でサンドボックス外の起動を全面禁止。エージェント・シェルを問わず全セッションがサンドボックス強制になり、UI のサンドボックス切替は無効化されます。bwrap が無い環境 (または Windows) では起動をエラーで拒否します (Claude の `/usage` / Codex のレート制限取得の直接起動フォールバックも同様に禁止)。ホストに bwrap (bubblewrap) のインストールが必須です。 |
| `defaultApp` | `"claude"` | 新規セッションの既定エージェント (`"claude"`、`"opencode"`、`"copilot"`)。UI で一度明示的に選んだ後はブラウザの記憶が優先され、この値は初回表示時の見た目とサーバー側フォールバック (予約プロンプトの自動再開など、クライアントが `app` を指定しない経路) にのみ使われます。**コンボ起動のメンバーには適用されません** (コンボのロール別選択は別途ブラウザの `localStorage` に記憶され、copilot はそもそも選択不可)。 |
| `showUsage` | `true` | タブバー右端の Usage ボタン (Claude Code の `/usage` / Codex のレート制限読み取り) を表示するか。`false` で非表示。**claude/codex のどちらもサーバーに無い場合は設定に関わらず自動的に非表示**になります (片方だけあればボタンは表示され、ポップオーバーはそのアプリのみ表示)。 |
| `usageMcp` | `false` | Claude セッションへ `ccserver-usage` MCP (`get_usage` ツール) を注入するか。安全のため既定はオフで、`true` の明示時だけ有効です。`showUsage` とは独立しています。 |
| `metaAgentMcp` | `false` | メタエージェント用 MCP (`ccserver-meta`) を有効化するか。`true` の明示時のみ、メタエージェントとして起動されたセッションへ注入されます (上記「ccserver-meta (メタエージェント用 MCP)」参照)。全サーバーを操作できる特権ツールのため既定はオフです。 |
| `binds` | `[]` | 追加で見せるホストパス。各要素 `{ src, mode?, dest? }`。`mode` は `ro` (既定) か `rw`。存在しないパスはスキップ。`~` はホームに展開。`~/.ssh` と `~/.config/gh` は `gitBroker` の設定に関わらず常にブロックされます。 |
| `env` | `{}` | サンドボックス内の追加環境変数 (適用順は最後 = 既定値を上書き)。例: `sshAgent: true` のときに `SSH_AUTH_SOCK` を明示指定して自動検出を上書き。 |
| `claudeBin` | 自動検出 | claude/opencode/copilot の起動方法。`claude` を PATH から解決し、ラッパー (例: `/usr/bin/claude` → `/opt/claude-code/bin/claude`) の場合は実体のインストール先を辿ってサンドボックスへ自動的に公開します。opencode は PATH に加えて `~/.opencode/bin` も自動探索。copilot は PATH (SANDBOX_PATH) で自動解決されます (通常 `~/.local/bin/copilot`)。自動検出で外れる場所にある場合や特定ビルドに固定したい場合のみ絶対パスで指定 (環境変数 `CCSERVER_CLAUDE_BIN` が優先。copilot に個別の bin 設定はありません)。 |
| `notify` | `{}` | 通知用 MCP (ccserver-notify) の設定 (上記「ccserver-notify (通知用 MCP)」参照)。`discordWebhook` は https のみ (非 https は無視)、`subscriptions` は初期購読 (https のみ)。`CCSERVER_DISCORD_WEBHOOK` 環境変数で discordWebhook を上書き可。`vikunja` は Vikunja タスク連携の設定 (上記「Vikunja 連携」参照、`baseUrl`+`apiToken` で有効化)。 |
| `federation` | `{}` | 拠点間ペアリング (上記「拠点間 (federation) ペアリング」参照) の設定。`requireTokenForPairing: true` でペアリング開始リクエストに `CCSERVER_TOKEN` の提示を必須化 (既定 `false`)。機能自体の有効/無効は `CCSERVER_FEDERATION_PORT` 環境変数で制御し、ここでは切り替えられません。 |

サンドボックスは Linux 限定です。同じプロジェクトを 2 つのサンドボックスで同時に開いた場合、docker の data-root は1つしかないため、rootless dockerd が実際に起動できる (`sandbox-entrypoint.sh` の `flock` を取れる) のはどちらか一方だけです。**先に取れた方が勝つだけで、workerA/workerB のような役割やコンボの登録順とは無関係** — 起動順が入れ替われば逆転しえます。負けた方は docker 無しで (エラーにはならず) 起動します。

**コンボのワーカー同士については、この制約は実質解消されています**: workerA/workerB はそれぞれ独立した git worktree (cwd) で起動するようになったため (上記「コンボ起動: ロール別 git worktree」参照)、data-root もロールごとに分かれ、両方が同時に docker を使える可能性があります。この制約が引き続き残るのは、**同じプロジェクトを単発起動で 2 つ**開いた場合 (cwd が完全に同一) です。

コンボのオーケストレーターは、`list_group_sessions` / `get_tab_status` が返す `dockerAvailable` (`true`/`false`/`null`) と `dockerReason` でメンバーごとの実際の状態を確認できます:

| `dockerReason` | 意味 |
|---|---|
| `available` | このセッション自身の dockerd がロックを保持しており、docker タスクを振ってよい |
| `data-root-locked-by-another-session` | 同じプロジェクトの別セッションが保持中。このセッションに docker タスクを振っても失敗する |
| `starting` | サンドボックス起動直後で、`flock` の勝敗がまだ確定していない。数秒待って再確認する |
| `disabled-by-config` | `docker` ツール自体は使えるが、`sandbox.config.json` の `docker` 設定で無効化されている |
| `tooling-missing` | ホストに `bwrap`/`rootlesskit`/`slirp4netns`/`newuidmap` が揃っていない |
| `not-sandboxed`（`dockerAvailable: null`） | サンドボックス自体を使っていないセッション。docker は無関係 |

これにより、「workerA にしか docker タスクを振れない」という誤った思い込みで一悶着起きるのを避けられます — 実際には起動順のレースであり、確認すべきは `dockerAvailable` そのものです。

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
│   ├── copilot-launch.spec.js      # copilot 起動 + コンボ拒否 (copilot 未インストール環境では skip)
│   ├── mobile-scroll.spec.js       # opencode TUI: タッチドラッグ→合成ホイールイベント (opencode 未インストール環境では skip)
│   └── scroll-buttons.spec.js      # opencode TUI: スクロールボタン→メッセージスクロールキー (同上)
├── server/
│   ├── package.json
│   ├── index.js                    # Fastify エントリポイント (トークン認証・静的配信含む)
│   ├── usage.js                    # `claude --ax-screen-reader` を叩いて /usage をパース・キャッシュ
│   ├── codexUsage.js               # `codex app-server` に JSON-RPC で account/rateLimits/read を投げてキャッシュ
│   ├── sandbox.config.example.json
│   ├── routes/
│   │   ├── dirs.js                 # GET/POST /api/dirs, GET /api/dirs/home
│   │   ├── sessions.js             # GET/POST/DELETE /api/sessions (POST は単発セッション新規起動)
│   │   ├── approvals.js            # GET /api/approvals, POST /api/approvals/:id/decision (メタエージェント承認)
│   │   ├── projects.js             # GET /api/projects, PUT /api/projects/:id/label
│   │   ├── launchPresets.js        # GET/POST/PUT/DELETE /api/launch-presets (コンボ起動プリセット)
│   │   ├── files.js                # GET/POST /api/files (アップロード/ダウンロード), GET /api/files/content (プレビュー)
│   │   ├── system.js               # GET /api/system-stats (CPU/メモリ/温度/GPU/IPMI/ストレージ)
│   │   └── usage.js                # GET /api/usage (?app=claude|codex)
│   └── ws/
│       ├── terminal.js             # WebSocket + node-pty ブリッジ (/ws/terminal)
│       ├── sessionManager.js       # セッション・予約プロンプトの状態管理/永続化
│       ├── appLaunch.js            # アプリ非依存の起動ロジック (resume引数・permission検出等)
│       ├── notify.js               # ccserver-notify: 購読レジストリ + Discord/webhook/Vikunja 配送 + MCP ソケット
│       ├── vikunjaClient.js        # notify.js から呼ばれる Vikunja タスク作成/更新クライアント
│       ├── usageMcp.js             # ccserver-usage: get_usage MCP ツール (server/usage.js の getUsage を直接呼ぶ)
│       ├── mcpConfig.js            # MCP 設定の生成 (ccserver / ccserver-notify / ccserver-usage / ccserver-meta、sandbox/host 両モード)
│       ├── mcpServer.js            # control / handoff / notify / usage / meta 各 MCP サーバー (SocketTransport 含む)
│       ├── mcpBroker.js            # Unix-socket MCP ブローカー (control/handoff はグループ毎、notify/usage/meta はプロセス毎 1 つ)
│       ├── mcpTools.js             # control/handoff ツールの実装 (deps 注入)
│       ├── metaTools.js            # メタエージェント用ツールの実装 (ワイヤ引数を信頼する、mcpTools とは別の信頼境界ファイル)
│       ├── metaAgent.js            # ccserver-meta: metaAgentMcp ゲーティング + プロセスグローバル MCP ソケット
│       ├── screenModel.js          # read_output 用の軽量仮想画面 (ANSI 解釈 + 変化検知)
│       ├── sandbox.js              # bwrap + rootless docker サンドボックス構築
│       ├── sandbox-entrypoint.sh
│       ├── sandbox-gh-wrapper.cjs         # サンドボックス内 gh をブローカー中継に差し替え
│       ├── sandbox-ssh-wrapper.cjs        # サンドボックス内 ssh を許可リストでゲート
│       ├── sandbox-git-credential-helper.cjs
│       ├── sandbox-mcp-wrapper.cjs        # MCP stdio ↔ Unix socket の中継 (argv 'notify'/'usage' でそれぞれのソケットへ)
│       ├── sandbox-gitconfig / sandbox-known-hosts / sandbox-ssh-config
│       ├── git-broker.js           # サンドボックス外で動く、リポジトリスコープの認証情報ブローカー
│       └── ghAllowlist.js / gitAllowlist.js  (+ 各 *.test.js, appLaunch.test.js, sandbox-resolve.test.js, notify.test.js, vikunjaClient.test.js)
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
        │   ├── SystemMonitor.jsx
        │   └── ApprovalBanner.jsx  # メタエージェント承認待ちグローバルバナー (ポーリング)
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
| GET | `/api/dirs/home` | `{ home, defaultApp, availableApps, metaAgentEnabled, metaAgentDir }` — サーバーのホームディレクトリ、既定起動アプリ、検出済みCLI (`claude`/`opencode`/`copilot`/`codex`)、メタエージェント有効フラグと固定ディレクトリ |
| POST | `/api/dirs` | `{ parent, name }` でフォルダ作成 |
| GET | `/api/sessions` | 実行中セッションの一覧 |
| DELETE | `/api/sessions/:id` | セッションを終了する (予約プロンプトも解除) |
| GET | `/api/files?path=<path>` | ファイルをダウンロード |
| GET | `/api/files/content?path=<path>` | ファイルブラウザのプレビュー用。`.md` / `.txt` のみ対象で、UTF-8 テキストを JSON (`{ path, name, size, mtime, kind, content, truncated }`) で返す。`kind` は `.md` なら `markdown`、`.txt` なら `text` (レンダリングはクライアント側で DOMPurify を通して行う)。先頭 1 MiB を超える分は切り捨てて `truncated: true`。他の拡張子、および先頭 8 KiB に NUL バイトを含むバイナリは 415 |
| POST | `/api/files` | multipart アップロード (`destination` フィールド + ファイルパート) |
| GET | `/api/system-stats?ipmi=1` | CPU/メモリ/温度/GPU (`nvidia-smi`)/IPMI (要 `ENABLE_IPMI=1`)・load average |
| GET | `/api/usage?force=1` | Claude Code `/usage` のキャッシュ済みスナップショット (`force=1` で即時再取得) |
| GET / POST | `/api/worker-presets` | Worker プリセット一覧取得 / 作成 (`{ name, role, app, model }`、`model` は null 可) |
| PUT / DELETE | `/api/worker-presets/:id` | プリセットの全置換更新 / 削除。role 重複は 409 |
| GET / POST | `/api/launch-presets` | コンボ起動プリセット一覧 / 作成 (`{ name, workers: [1–7 x { role, app, model?, name?, sandboxOpts? }], orchestratorApp?, orchestratorModel?, instructions? }`)。管理 UI は無く、メタエージェントの MCP ツールと対になる REST |
| PUT / DELETE | `/api/launch-presets/:id` | コンボ起動プリセットの全置換更新 (workers スナップショットごと置換) / 削除。preset 名重複は 409 |
| GET | `/api/projects` | プロジェクト一覧 (サンドボックス永続 HOME の所属プロジェクト行。`{ id, cwd, pathHash, label, gitRemote, lastSeenAt }`) |
| PUT | `/api/projects/:id/label` | プロジェクト表示ラベル変更 (`{ label }`、null でクリア)。メタエージェントの `update_project_label` と同じストア経由 |
| POST | `/api/sessions` | 単発セッションをサーバー側で新規起動 (`{ cwd, app?, model?, shell?, sandbox?, sandboxOpts?, resume?, isMetaAgent? }` — `isMetaAgent: true` のとき `cwd` は省略可かつ無視され、固定ディレクトリ `~/.local/share/ccserver-sandbox/meta-agent` で起動)。メタエージェントの `launch_session` と同一実装 (`isMetaAgent: true` は `metaAgentMcp: true` のときのみ意味を持つ) |
| POST | `/api/groups` | コンボ起動。従来の `workerA`/`workerB`/`orchestrator` に加え、canonical な `workers: [{ name?, role, app?, model?, sandboxOpts? }]` (1–7 人、role 一意) を受け付ける。プリセットはクライアントがスナップショットへ展開して送る。copilot はどちらの経路でも 400 拒否 |
| GET | `/api/approvals?status=pending` | メタエージェントの承認待ち破壊的操作一覧 (`ccserver-meta` 参照)。ブラウザのグローバルバナーが数秒間隔でポーリング |
| POST | `/api/approvals/:id/decision` | `{ decision: 'approved' \| 'rejected' }` で承認待ち操作を承認/却下する。5 分未応答のリクエストはサーバー側で expired (拒否扱い) になる |
| GET | `/api/federation/identity` | `{ enabled, fingerprint?, keyPermissionsSafe? }` — このインスタンス自身の federation 有効/無効と証明書 fingerprint |
| GET | `/api/federation/instances` | ペアリング済みインスタンス一覧 (全ステータス)。呼び出しのたびに未確定 (pending) 行を相手へ問い合わせて解決を試みる |
| POST | `/api/federation/instances` | `{ remoteAddr, remoteToken?, label? }` で新規ペアリングを発信 (`remoteAddr` は `host:port`) |
| PATCH | `/api/federation/instances/:id` | `{ label }` で表示名を変更 |
| DELETE | `/api/federation/instances/:id` | ペアリングを取り消す (即時・ローカルのみ。相手には通知されない) |
| GET | `/api/federation/pending` | 未承認 (双方向承認の途中) のペアリング一覧 |
| POST | `/api/federation/pending/:id/decide` | `{ decision: 'approved' \| 'rejected' }` — このインスタンス側の人間の承認/却下を記録する |
| GET/POST/DELETE | `/api/federation/instances/:id/{sessions,groups,dirs}` | `active` なペアへの薄いプロキシ。ボディ/レスポンス形状はそれぞれ `/api/sessions`・`/api/groups`・`/api/dirs` と同一 |

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
| → | `init` | `cwd`, `cols`, `rows`, `claudeSessionId?`, `shell?`, `sandbox?`, `sandboxOpts?`, `app?`, `resume?` | 新規セッションを起動 (`app`: `"claude"` (既定)、`"opencode"`、`"copilot"`、`shell: true` で素のシェル、`resume: true` で opencode/copilot の最終セッションに再開) |
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

### `WebSocket /ws/remote-terminal`

拠点間ペアリング (上記) のリモート端末タブが使う中継専用エンドポイント。メッセージ語彙は `/ws/terminal` と完全に同一で、`init`/`attach` の最初のメッセージに `instanceId` (ペアリング済みインスタンスの id) を追加で含める点だけが違います。以降のメッセージはそのまま federation TLS チャンネル経由で相手インスタンスの `/ws/terminal` ロジックへ中継され、`output`/`replay`/`exit` などの応答もそのまま返ってきます。相手が `active` なペアでない場合は `error` (`code: 'INSTANCE_NOT_FOUND'`)、接続後に federation 側が切断された場合は `error` (`code: 'REMOTE_DISCONNECTED'`) を送ってからソケットを閉じ、クライアント側の既存の自動再接続ロジックに委ねます。

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
Description=ccserver — Context & Coordination Server
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
