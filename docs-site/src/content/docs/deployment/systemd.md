---
title: systemd でバックグラウンド実行
description: ccserver を systemd ユーザーサービスとして常駐させる手順
---

## 1. クライアントをビルド

```bash
cd /path/to/ccserver
npm run build --workspace=client
```

## 2. サービスファイルを配置

```bash
cp docs/ccserver.service ~/.config/systemd/user/ccserver.service
```

または手動で `~/.config/systemd/user/ccserver.service` を作成します。

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

## 3. サービスを有効化・起動

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

## 4. セッションの寿命 (任意)

接続が無いセッションを破棄するまでの時間や、PTY 終了後の保持時間は環境変数で調整できます。既定のままでも動作しますが、`CCSERVER_SESSION_TIMEOUT_MS=0` で「接続が無くてもセッションを維持し続ける」設定にできます。詳細と、セッションが終了した理由の調べ方は[セッション共有と寿命](/ccserver/guides/session-sharing/)を参照してください。

## 5. 動作確認

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
