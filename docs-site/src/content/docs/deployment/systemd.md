---
title: systemd でバックグラウンド実行
description: ccserver を systemd ユーザーサービスとして常駐させる手順
---

## 1. クライアントをビルドし、セットアップを実行

```bash
cd /path/to/ccserver
npm run build --workspace=client
npm run setup           # まず内容を確認 (ドライラン)
npm run setup -- --yes
```

`npm run setup` はホストごとに一度必要です (新規インストールでも)。設定・データ・状態を
`~/.config/ccserver` / `~/.local/share/ccserver` / `~/.local/state/ccserver` に用意します。
実行するまで Web UI は新しいセッションやグループの作成を拒否します。
詳細は [設定モデル](/ccserver/reference/configuration-model/) を参照してください。

`docs/ccserver.service` の `WorkingDirectory` は checkout を指したままで構いません。
移行後、ccserver はリポジトリ配下に一切書き込まなくなります。

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

## 4. アップグレード手順

移行を伴う可能性があるため、**サーバーを停止してから**実行します。

```bash
systemctl --user stop ccserver
git pull
npm ci
npm run build --workspace=client
npm run setup            # まず内容を確認 (ドライラン)
npm run setup -- --yes
systemctl --user start ccserver
```

:::caution
移行後は、必ず新しいレイアウトに対応したコードで起動してください。古いブランチの checkout は旧パスを参照するため、**空の状態で起動します** (認証セッション・GPG Vault・ペアリング済みインスタンスが見えなくなります)。複数ホストを運用している場合は、checkout を更新してからそのホストでウィザードを走らせてください。
:::

稼働中のセッションがある間は停止しないでください。ウィザードは稼働中のサーバーを検出すると中断します (`--force` で無視できますが、状態が両方のレイアウトに割れます)。

## 5. セッションの寿命 (任意)

接続が無いセッションを破棄するまでの時間や、PTY 終了後の保持時間は環境変数で調整できます。既定のままでも動作しますが、`CCSERVER_SESSION_TIMEOUT_MS=0` で「接続が無くてもセッションを維持し続ける」設定にできます。詳細と、セッションが終了した理由の調べ方は[セッション共有と寿命](/ccserver/guides/session-sharing/)を参照してください。

## 6. 動作確認

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

