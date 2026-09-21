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

## 6. pty-host 分離でサーバー再起動をまたいでセッションを維持する（撤回済み・デフォルト無効）

> **2026-09時点でこの分離機能は撤回されています。** 実装の複雑さに見合う効果がなく、プロセス分離由来のバグの温床になっていました（例: GPG vault のアンロック状態は `ccserver` 本体プロセスのメモリにしか存在しないため、pty-host 側から見ると常に locked 扱いになり、サンドボックス起動が `SPAWN_FAILED` で失敗する、といった不整合）。デフォルトは無効（直接 spawn 方式のみ）に戻っており、下記の手順で明示的にオプトインしない限り有効になりません。新規デプロイでは有効化しないことを推奨します。

通常の構成では、`systemctl --user restart ccserver` のたびに、実行中の全ターミナルセッション（Claude Code / opencode / codex などの子プロセス）が終了します。実行中の長時間コマンドやバックグラウンドジョブの状態はこの再起動で失われます（会話自体は resume 機能で再開できますが、プロセスの状態は失われます）。

これを緩和する目的で、PTY プロセスの生成・管理を `ccserver` 本体から切り離した常駐プロセス **pty-host** への分離を実験していました。`ccserver` を再起動しても pty-host 側のプロセスには触れないため、再起動後に既存セッションへ再接続できます。ただし上記の理由で撤回済みのため、`Environment=CCSERVER_PTY_HOST=1`（またはその他 `0` 以外の値）を明示的に設定しない限り、`ccserver-pty-host.service` を起動していても使われません（後述の「手順」参照）。

`CCSERVER_PTY_HOST=1` を設定しても `ccserver-pty-host.service` が起動していない場合は、`ccserver` は起動時にそれを検出できず、自動的に従来どおりの直接 spawn 方式（`ccserver` 自身が PTY プロセスの親になる、再起動でセッションが失われる方式）にフォールバックします。ログに警告が出ますが、動作自体はデフォルト構成と変わらず継続します。

pty-host 自体がクラッシュした場合（`Restart=on-failure` で自動再起動される想定）も、直前まで保持していたセッションをそのセッションIDのまま自動的に再起動時に再launchします（自動resume）。ただし現時点では以下の制約が残ります。

- 自動resumeが再現できるのは会話・シェルそのもの（`--resume <id>` での再開、または `resumeLast` によるフォールバック）までで、クラッシュ時点で実行中だった長時間コマンドやバックグラウンドジョブの**プロセス状態そのもの**は失われます。
- 正確な `--resume <id>` での再開が保証されるのは claude セッションのみです。claude はTUI出力に会話IDのヒント（`claude --resume <id>`）を継続的に出力するため、これを生存中に追跡して記録できますが、opencode/copilot/codex/commandcode のTUIは会話IDを一切出力しないため、`resumeLast`（同一cwdの直近の会話を再開）にフォールバックします。この場合、同一cwdで複数タブを開いていると、意図しない会話が再開される可能性があります。
- `ccserver` 本体と pty-host が同時にクラッシュ・再起動するケース（サーバーごと再起動する等）では、MCP注入（notify/usage/meta/reviewer等)に使うソケットパスの整合性が取れなくなる可能性があります。通常運用（pty-hostだけが単独でcrashしてsystemdが再起動するケース）では問題ありません。
- 自動resumeは launch 時の起動コマンド一式（環境変数を含む）を `.pty-host-session-meta.json` に保存して再現します。この環境変数には `ccserver` プロセス自身の環境（`NODE_ENV`/`PORT`/`CCSERVER_*`/`SSH_AUTH_SOCK` 系を除く全て）が含まれるため、シェルの起動時に export された APIキー等の秘匿情報がこのファイルに平文で書き込まれる可能性があります。ファイルは書き込みのたびに `0600` 権限へ強制されますが、同一ホスト上の root や同一ユーザーの他プロセスからは読めることに変わりないため、バックアップ・ログ収集の対象から除外する等、運用側でも配慮してください。

### 手順

1. `ccserver-pty-host.service` を配置し、`ccserver` より先に有効化します。

   ```bash
   cp docs/ccserver-pty-host.service ~/.config/systemd/user/ccserver-pty-host.service
   systemctl --user daemon-reload
   systemctl --user enable --now ccserver-pty-host
   ```

2. `ccserver.service` に `Environment=CCSERVER_PTY_HOST=1` を設定してから、`ccserver` を（再）起動します（デフォルトは無効なので、この設定なしでは pty-host を起動していても使われません）。起動時に pty-host への到達性を確認し、到達できればそのまま使い始めます。

   ```bash
   systemctl --user daemon-reload
   systemctl --user restart ccserver
   ```

   すでに `ccserver` が起動済みで、`ccserver-pty-host.service` を後から追加した場合も、`ccserver` 側を一度再起動すれば検出されます（起動時の一度きりのチェックのため、稼働中に自動検出されることはありません）。

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

シャード1以降の各インスタンスには、`CCSERVER_PTY_HOST_SOCK`（ソケットパス）に加えて `Environment=CCSERVER_PTY_HOST_SHARD_INDEX=<N>` も設定してください。pty-host自身は `ccserver` 側のパーティショニングロジック（`CCSERVER_PTY_HOST_SHARDS`/どのcwd・groupIdがどのシャードに属するか）を一切関知しない設計のため、このインスタンスが「自分はシャードNである」と認識する唯一の方法です。未設定時は0（シャード0）として動作するため、シャード0のインスタンスでは設定不要です。この値は自動resume（前節）が「`.pty-host-session-meta.json` 内のどのエントリが自分の担当か」を判定するのに使われます。

