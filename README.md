# ccserver

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
cd /home/kts_sz/ccserver
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
WorkingDirectory=/home/kts_sz/ccserver
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
sudo loginctl enable-linger kts_sz
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
