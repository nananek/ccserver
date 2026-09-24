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

systemd 以外 (macOS の launchd、tmux、手動起動など) で常駐させている場合は、上記の `systemctl` の2行をその方法に読み替えてください。ウィザード自身も停止・起動の方法を環境別に表示します。

移行後に元へ戻す必要が生じた場合は、[設定モデル → 移行を取り消す](/ccserver/reference/configuration-model/#移行を取り消す) に実測済みの手順があります (戻らないものの一覧付き)。

:::danger[本番ホストのチェックアウトでテストスイートを実行しないでください]
`npm test` と `npm run test:e2e` は、セットアップウィザードを**実際に `--yes` で実行する**テストを含みます。ウィザードは `$HOME` を基準に移行前の置き場 (`~/.local/share/ccserver-sandbox`) を探すため、`$HOME` を隔離せずにテストを走らせると、**そのホストの本物の DB・federation 秘密鍵・グループ共有ファイル・状態ファイルがテスト用の一時ディレクトリへ移動され、テスト終了時にディレクトリごと削除されます。**

リポジトリ内のテストヘルパー (`server/testIsolation.js`) は `$HOME` と XDG 3 本をすべて一時ディレクトリへ向け、そうなっていなければ**テストを失敗させて中断**します。したがってリポジトリのテストをそのまま実行する分には安全です。危険なのは、そのヘルパーを経由せずにウィザードを手で叩く場合です。

本番ホスト上で動作確認したい場合は、必ず `$HOME` ごと隔離してください。

```bash
T=$(mktemp -d)
env HOME=$T/home \
    XDG_CONFIG_HOME=$T/config XDG_DATA_HOME=$T/data XDG_STATE_HOME=$T/state \
    node server/cli/setup.js          # ドライラン
```

`--yes` を付ける場合も同じ `env` を必ず前置してください。移行内容は実行前 (プラン) と実行後 (「移動しました」) の両方に出力されるので、journal やスクロールバックから追跡できます。
:::

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

