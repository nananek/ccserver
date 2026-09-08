---
title: 認証 (ワンタイムトークン/パスキー)
description: CCSERVER_AUTH_MODE によるパスキー (WebAuthn) 認証と、ワンタイムトークンでのリカバリログイン
---

`CCSERVER_AUTH_MODE` 環境変数で認証方式を切り替えます。3値は排他的で、DB での動的切り替えは行わず環境変数のみで管理します (変更にはサーバー再起動が必要)。

| 値 | 説明 |
|---|---|
| `none` (既定) | 認証なし。`CCSERVER_AUTH_MODE`/`CCSERVER_TOKEN` のどちらも未設定のときの既定値 |
| `token` | 従来の `CCSERVER_TOKEN` 固定共有シークレット ([API](/ccserver/reference/api/) 参照)。後方互換のため維持 |
| `passkey` | このページで説明するパスキー (WebAuthn) + ワンタイムトークンによる新方式 |

`CCSERVER_AUTH_MODE` が未設定の場合、`CCSERVER_TOKEN` が設定されていれば `token`、無ければ `none` として解決されます (pre-#141 の「`CCSERVER_TOKEN` 設定の有無だけで認証 ON/OFF が決まる」挙動と完全互換)。`passkey` モードを使うには `CCSERVER_AUTH_MODE=passkey` を明示的に設定する必要があります。

```bash
CCSERVER_AUTH_MODE=passkey NODE_ENV=production node server/index.js
```

**`passkey` モードでは `CCSERVER_TOKEN` による Bearer 認証を一切受け付けません** (設定されていれば起動時に警告ログを出しつつ無視するだけで、併用はできません)。`token`/`none` モードの挙動はこの機能追加によって一切変更されていません。

## 認証フロー

### フロー1: ワンタイムトークンでの初回/リカバリログイン

サーバーにサーバー起動状態に依存しない形でアクセスできる手段 (SSH 等) から、以下を実行します。

```bash
npm run login-token
# または直接:
node server/cli/issue-login-token.js
```

15 分で失効する一度きり (use-once) のトークンが標準出力に表示されます。ブラウザのログイン画面にこのトークンを入力すると、検証・即時失効の上でセッションが確立します。パスキーがまだ無い最初のログイン、またはパスキーが使えなくなった場合のリカバリの両方でこのフローを使います。

### フロー2: パスキー登録

ログイン済み状態で `Settings` タブの「パスキー」セクションから新しいパスキーを登録できます。登録できるパスキー数に上限はなく、複数デバイスでの複数登録に対応します (削除 UI は現時点では未実装です)。

### フロー3: パスキーでのログイン

次回以降はログイン画面の「パスキーでログイン」から WebAuthn 認証でログインできます。

### フロー4: リカバリ

すべてのパスキーが使えなくなった場合は、フロー1 (ワンタイムトークン) で再ログインしてください。認証自体を無効化したい場合は `CCSERVER_AUTH_MODE=none` に変更して再起動します (DB 上での動的な無効化は行いません)。

## セッション

ログイン成功時、JWT ではなくサーバー発行のランダムトークンを `httpOnly` Cookie として発行し、DB (`auth_sessions` テーブル) で管理します。有効期限は 30 日で、認証済みリクエストのたびに sliding expiration で自動延長されます (延長の DB 書き込み自体は 1 時間に 1 回に間引かれます)。毎回パスキー認証を求めない、使い勝手優先の設計です。

## WebAuthn の環境制約

WebAuthn の `rpID` は有効なドメイン名である必要があり、**IP アドレス直打ちでのアクセスでは動作しません** (`localhost` を除く)。[Tailscale Serve での HTTPS 公開](/ccserver/deployment/tailscale/) による `*.ts.net` ドメイン運用を前提としています。既定では `rpID` はリクエストのホスト名 (プロキシ越しなら `X-Forwarded-Host`) からそのまま導出されますが、その導出が合わない構成では `CCSERVER_WEBAUTHN_RPID` 環境変数で明示的に上書きできます。
