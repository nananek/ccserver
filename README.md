# ccserver

> **Note:** このプロジェクトは Anthropic 非公式のサードパーティツールです。Anthropic による公式サポートの対象外です。

ディレクトリを指定して Claude Code を起動する Web フロントエンド。
VS Code のようにフォルダを選択し、ブラウザ内のターミナルで Claude Code を操作できます。

## アーキテクチャ

```
ブラウザ (xterm.js) <── WebSocket ──> Fastify <── node-pty ──> claude CLI
                    <── HTTP REST ──>         (ディレクトリ一覧 API)
```

| レイヤー | 技術スタック |
|----------|-------------|
| Frontend | React 19 + Vite + xterm.js |
| Backend  | Node.js + Fastify + @fastify/websocket + node-pty |

## 必要な環境

- Node.js >= 20
- npm >= 9
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (`/usr/bin/claude`)
- C++ コンパイラ（node-pty のビルドに必要。Arch: `base-devel`、Ubuntu: `build-essential`）

## セットアップ

```bash
git clone <repo-url> ccserver
cd ccserver
npm install
```

## 使い方

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

ブラウザで http://localhost:3001 を開く。

ポートは環境変数 `PORT` で変更可能:

```bash
PORT=8080 NODE_ENV=production node server/index.js
```

## 操作方法

1. ディレクトリブラウザでフォルダを選択
   - **シングルクリック** → フォルダ内に移動
   - **ダブルクリック** → そのフォルダで Claude Code を起動
   - **Open with Claude Code** ボタン → 現在のディレクトリで起動
2. ブラウザ内ターミナルで Claude Code を操作
3. **Back** ボタンでディレクトリ選択に戻る

### 予約プロンプト (タイマー)

ターミナルヘッダの時計 (⏰) ボタンから、指定時刻に任意のプロンプトを自動投入できます。
5 時間の利用制限で停止したとき、解除時刻に「続けて」などを予約しておくと自動再開します。

- 時刻は **サーバーのタイムゾーン**で解釈されます (Claude Code が表示する制限解除時刻と一致)。パネルに現在のサーバー時刻とタイムゾーンを常時表示します。
- 過ぎている時刻は翌日として扱います。
- 予約はディスク (`.scheduled-prompts.json`) に永続化され、**ブラウザを閉じても、サーバーが再起動・クラッシュしても発火します**。発火時にセッションが生きていなければ、`claude --resume` で会話を自動復帰させてからプロンプトを投入します (元の cwd / サンドボックス設定も復元)。サーバー停止中に発火時刻を過ぎた予約は、起動直後にまとめて発火します (12 時間以上前に過ぎた物は破棄)。

### 使用量 (Usage) ボタン

画面上部タブバー右端の **Usage** ボタンから、Claude Code の `/usage` (セッション / 週次の利用率・リセット時刻・プラン) をポップオーバーで確認できます。ボタンには現在セッションの使用率が常時表示されます。

- 裏側では `claude --ax-screen-reader` を短時間起動して `/usage` の描画をパースし、結果を約 2 分キャッシュします (`/usage` の閲覧自体は API を消費しません)。「更新」ボタンで即時に再取得できます。
- bwrap がある環境では、**Claude の設定だけを見せる最小サンドボックス** (docker/gpg/ssh なし) で起動します。無ければ claude を直接起動します。
- API: `GET /api/usage` (`?force=1` で強制再取得)。サーバー起動時にキャッシュを 1 度ウォームします。

## サンドボックス起動 (bwrap + rootless docker)

「Claude Code」ボタン右の **▼** から「🔒 サンドボックスで起動」を選ぶと、`bwrap` でファイルシステムを制限した状態で起動します。選択したプロジェクトと最小限の設定 (`~/.claude`, `~/.claude.json`) だけが見え、**隣接する他プロジェクトは見えません**。一度選ぶと既定として記憶されます。

docker も安全に使えるよう、サンドボックス**内部**に rootless dockerd を起動します。`rootlesskit` (subuid マッピング) の内側で `bwrap` を動かす構成のため、`docker run -v ...` でもサンドボックス外へは到達できません (daemon 自身が制限された FS の中にいるため)。

### 必要なもの (docker を使う場合)

```bash
# Debian/Ubuntu
sudo apt install uidmap slirp4netns
# rootlesskit / docker (rootless) が入っていること。/etc/subuid, /etc/subgid にエントリが必要。
```

`uidmap`/`slirp4netns` が無い場合は docker 無効のサンドボックス (bwrap のみ) として起動します。

### 認証情報の受け渡し (ssh / gpg / gh)

- **ssh-agent**: 自動転送されます。ccserver が起動時にユーザーの agent ソケット (`/tmp/ssh-*/agent.*` 等、鍵がロードされている物を優先) を探して `SSH_AUTH_SOCK` を設定します。設定不要。
- **gpg**: 設定で `"gpg": true` にすると、`~/.gnupg` と**ホストの生 gpg-agent / keyboxd ソケット**をサンドボックス内へ転送します。ホストの agent (鍵/トークンを保持) で署名するので、**docker 有効のままコミット署名が使えます**。
- **gh**: `~/.config/gh` を binds に足せば認証を引き継げます。

### 設定ファイル

```bash
cp server/sandbox.config.example.json server/sandbox.config.json
# 場所を変える場合: CCSERVER_SANDBOX_CONFIG=/path/to/config.json
```

```json
{
  "docker": true,
  "gpg": true,
  "binds": [
    { "src": "~/.config/gh", "mode": "ro" },
    { "src": "~/.ssh", "mode": "ro" }
  ],
  "env": {}
}
```

- `binds` の `mode` は `ro` (既定) か `rw`。存在しないパスはスキップされます。`~` はホームに展開。
- `env` でサンドボックス内の環境変数を追加できます (例: `SSH_AUTH_SOCK` を明示指定して自動検出を上書き)。
- `claudeBin` で claude の起動方法を指定できます (環境変数 `CCSERVER_CLAUDE_BIN` が優先)。既定は自動検出で、`claude` を PATH から解決し、ラッパー (例: `/usr/bin/claude` → `/opt/claude-code/bin/claude`) の場合は実体のインストール先を辿ってサンドボックスへ自動的に公開します。自動検出で外れる場所に claude がある場合や、特定ビルドに固定したい場合のみ絶対パスで指定してください。
- サンドボックスは Linux 限定です。同じプロジェクトを 2 つのサンドボックスで同時に開いた場合、docker の data-root 競合を避けるため 2 つ目は docker 無しで起動します。

### 仕組み (docker と gpg の両立)

```
ccserver → rootlesskit (subuid userns + slirp4netns) → bwrap (FS制限) → dockerd + claude
```

rootless docker には subuid マッピング付き userns が要るため、外側を `rootlesskit`、内側で `bwrap` が FS を制限します (この順序でないと `newuidmap` が使えずマルチ uid が壊れます)。`/run` は **bwrap が専用 tmpfs で用意**し (rootlesskit の `--copy-up=/run` は使わない)、ホストの生ソケットを bind ソースとして活かします。gpg は userns 内で uid 0 のため socketdir が `~/.gnupg` になる点を利用し、生ソケットをそこへ転送しています。`docker run -v ...` でもサンドボックス外へは到達できません (daemon 自身が制限 FS 内)。

## プロジェクト構成

```
ccserver/
├── package.json              # npm workspaces ルート
├── server/
│   ├── package.json
│   ├── index.js              # Fastify エントリポイント
│   ├── routes/
│   │   └── dirs.js           # GET /api/dirs ディレクトリ一覧
│   └── ws/
│       └── terminal.js       # WebSocket + node-pty ブリッジ
└── client/
    ├── package.json
    ├── index.html
    ├── vite.config.js
    └── src/
        ├── main.jsx
        ├── App.jsx
        ├── components/
        │   ├── DirectoryBrowser.jsx
        │   └── TerminalView.jsx
        └── styles/
            └── app.css
```

## API

### `GET /api/dirs?path=<path>&showHidden=1`

指定パスのサブディレクトリ一覧を返す。

```json
{
  "current": "/home/user",
  "parent": "/home",
  "dirs": [
    { "name": "projects", "path": "/home/user/projects" }
  ]
}
```

### `WebSocket /ws/terminal`

JSON メッセージでターミナル I/O を中継。

| 方向 | type | フィールド | 説明 |
|------|------|-----------|------|
| → | `init` | `cwd`, `cols`, `rows` | Claude Code をスポーン |
| → | `input` | `data` | キーボード入力 |
| → | `resize` | `cols`, `rows` | ターミナルリサイズ |
| ← | `ready` | `cwd`, `cols`, `rows` | スポーン完了 |
| ← | `output` | `data` | ターミナル出力 |
| ← | `exit` | `exitCode`, `signal` | プロセス終了 |

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
