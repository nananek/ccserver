---
title: 拠点間 (federation) ペアリング
description: 複数の ccserver インスタンスを mTLS でペアリングしてリモート操作する
---

複数の ccserver インスタンス (別マシン・別ネットワーク上でもよい) を**ペアリング**すると、ブラウザの **Remote** タブから他インスタンスのセッション/コンボの**一覧・起動・端末操作**ができます。現時点 (Phase 1) では一覧・起動・端末 I/O 中継のみが対象で、あるインスタンスのオーケストレーターが別インスタンスの MCP ツールを直接操作する分散コンボ (Phase 2) は未実装です。

## オプトイン

既定では無効です。`CCSERVER_FEDERATION_PORT` 環境変数を設定した場合のみ、メインの Fastify ポートとは別 listener として相互 TLS (mTLS) の待受を開始します。未設定 (または `0`) なら federation 機能自体が丸ごと無効になり、`Settings` タブにも `GET /api/federation/identity` にも「無効」と表示されます。

```bash
CCSERVER_FEDERATION_PORT=3210 NODE_ENV=production node server/index.js
```

## 信頼モデル

各インスタンスは初回起動時に自己署名 Ed25519 証明書を1組生成し (`openssl` が必要。無い環境では federation は無効のまま動作を継続します)、`~/.local/share/ccserver-sandbox/federation/{instance.key,instance.crt}` に `0600` で保存します (`CCSERVER_FEDERATION_HOME` で置き場を上書き可能)。federation ポートの TLS は **CA 検証を完全に無効化**しており、代わりに「ペアリング時に人間が承認して pin した証明書 fingerprint (`fingerprint256`) との完全一致」だけを信頼根拠とします。SSH のホスト鍵 + `known_hosts` と同じメンタルモデルです。

## 双方向承認が必須

どちらから接続を開始しても、**発信側・着信側それぞれの人間が別々にブラウザの承認バナーで fingerprint を確認して承認ボタンを押すまで有効になりません**。片側だけの承認では `active` になりません。承認/却下は `Settings` タブの上に出るグローバルバナーから行います (`GET /api/federation/pending` を数秒間隔でポーリング)。取り消しはいつでも `Settings` タブの「ペアリング済みインスタンス」一覧から (相手には通知されません。相手側から見ると以後の接続が単に拒否されるだけです)。

## 自己申告アドレスの到達性

ペアリング相手が後からこちらへ接続し直せるよう、自分の `<ホスト名>:<CCSERVER_FEDERATION_PORT>` を相手に伝えます。ホスト名は `CCSERVER_HOSTNAME` 環境変数 (未設定なら `ccserver-notify` の footer と同じ解決順) が使われるため、Tailscale などフラットなネットワークでない構成では **`CCSERVER_HOSTNAME` に相手から解決できるホスト名を明示してください** (でないと相手が pending 状態から `active` へ進めません)。

## ペアリング時のトークン要求 (任意)

`sandbox.config.json` の `federation.requireTokenForPairing: true` を設定すると、ペアリング開始リクエスト (bootstrap) にだけ相手側の `CCSERVER_TOKEN` の提示を必須にできます。あくまでスパム対策で、**トークンが合っていても人間の双方向承認は省略されません**。

## できること (Remote タブ)

ペアリング済みで `active` なインスタンスごとに、実行中セッション/コンボの一覧、新規セッション/コンボの起動、既存セッションへの接続 (通常のターミナルタブと同じ xterm 画面で、入出力は federation 経由で中継されます) ができます。コンボのメンバーは個別の通常セッションとして開けます (ローカルの3ペイン統合ビューとは異なります — MCP によるハンドオフはあくまで相手インスタンス内で完結する仕組みのため)。

## できないこと (Phase 2 未実装)

あるインスタンスのオーケストレーターが別インスタンス上に直接ワーカーを生成・操作する分散コンボ。REST API 経由で REST/端末 I/O を中継しているだけで、MCP ソケットそのものを跨マシンで公開しているわけではありません。
