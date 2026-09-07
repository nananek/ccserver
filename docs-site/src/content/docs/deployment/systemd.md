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

## 6. (実験的) pty-host 分離でサーバー再起動をまたいでセッションを維持する

通常の構成では、`systemctl --user restart ccserver` のたびに、実行中の全ターミナルセッション（Claude Code / opencode / codex などの子プロセス）が終了します。実行中の長時間コマンドやバックグラウンドジョブの状態はこの再起動で失われます（会話自体は resume 機能で再開できますが、プロセスの状態は失われます）。

これを緩和するため、PTY プロセスの生成・管理を `ccserver` 本体から切り離した常駐プロセス **pty-host** に分離できます。`ccserver` を再起動しても pty-host 側のプロセスには触れないため、再起動後に既存セッションへ再接続できます。

ただし現時点では以下の制約が残ります。

- pty-host 自体がクラッシュ・再起動した場合、その時点で管理していた全セッションは失われます（自動 resume の仕組みは未実装）。
- そのため本機能は実験的な位置づけです。デフォルトでは無効になっています。

### 手順

1. `ccserver-pty-host.service` を配置し、`ccserver` より先に有効化します。

   ```bash
   cp docs/ccserver-pty-host.service ~/.config/systemd/user/ccserver-pty-host.service
   systemctl --user daemon-reload
   systemctl --user enable --now ccserver-pty-host
   ```

2. `~/.config/systemd/user/ccserver.service` の `Environment=CCSERVER_PTY_HOST=1` の行のコメントアウトを外します（`docs/ccserver.service` には無効化された状態でコメント付きの例が入っています）。

3. 設定を反映して `ccserver` を再起動します。

   ```bash
   systemctl --user daemon-reload
   systemctl --user restart ccserver
   ```

### 動作確認

```bash
# pty-host のログ表示
journalctl --user -u ccserver-pty-host -f

# ccserver 本体を再起動しても既存セッションに再接続できることを確認
systemctl --user restart ccserver
```

### (実験的) 複数の pty-host インスタンスに分散する

pty-host が1インスタンスだけの場合、そのインスタンス自体がクラッシュ・再起動すると管理下の全セッションが失われます。`ccserver.service` に `Environment=CCSERVER_PTY_HOST_SHARDS=<N>`（`N` は2以上の整数）を設定すると、プロジェクト単位（`groupId` があればグループ単位、なければ cwd 単位）で最大 `N` 個の pty-host インスタンスにセッションを分散し、1インスタンスの障害範囲を局所化できます。未設定時は常に1（分散なし、上記の手順のまま）です。

分散させる場合、`ccserver` 側の設定だけでは不十分で、シャード番号ごとに pty-host インスタンスをあらかじめ起動しておく必要があります（シャード0は上記手順の `ccserver-pty-host.service` のまま、シャード1以降はソケットパスが `ccserver-pty-host-<N>.sock` になる別インスタンス）。systemd のテンプレートunit化など複数インスタンスの具体的な起動構成自体は本ガイドの対象外です。

