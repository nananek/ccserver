---
title: インストールと起動
description: ccserver のインストール、開発モード・本番モードでの起動方法
---

```bash
git clone <repo-url> ccserver
cd ccserver
npm install
```

## 開発モード

ターミナルを 2 つ開いて実行します。

```bash
# バックエンド (port 3001)
npm run dev:server

# フロントエンド (port 5173)
npm run dev:client
```

ブラウザで http://localhost:5173 を開きます。

## 本番モード

```bash
npm run build --workspace=client
NODE_ENV=production node server/index.js
```

:::note
シェルに `NODE_ENV=production` が設定されていると、`npm install` / `npm ci` は devDependencies (vite 等) を省略するため `npm run build --workspace=client` が `vite: not found` で失敗します。その場合は `npm install --include=dev` でインストールしてください。なお ccserver が起動するセッションには `NODE_ENV` / `PORT` / `CCSERVER_*` は引き継がれません (サーバー専用の変数として除外されます)。
:::

ブラウザで http://localhost:3001 を開きます。ポートは環境変数 `PORT` で変更可能です (`PORT=8080 NODE_ENV=production node server/index.js`)。

常駐させたい場合は [systemd でバックグラウンド実行](/ccserver/deployment/systemd/)、Tailnet 内から HTTPS で見たい場合は [Tailscale Serve で HTTPS 公開](/ccserver/deployment/tailscale/) を参照してください。

## 基本的な使い方

1. ディレクトリブラウザでフォルダを選択します。
   - **シングルクリック** → フォルダ内に移動
   - **ダブルクリック** → そのフォルダで (既定の設定のまま) 起動
   - **Back** ボタン → ディレクトリ選択に戻る
   - **`.md` / `.txt` のファイル名クリック** → その場でプレビュー (ダウンロード不要)。Markdown はレンダリング表示と Source 表示を切替可。先頭 1 MiB まで表示、中身がバイナリならエラー表示。他の拡張子は右端の ↓ でダウンロードのみ。Markdown 内の画像・動画・iframe 等は読み込まれず (プレビューを開くだけでは外部へ通信しない)、画像は `[image: alt]` の代替表示になります。
2. ブラウザ内ターミナルで操作します。

起動オプション (サンドボックス・GPG 署名・ssh-agent 転送など) の詳細は [起動 (アプリ・サンドボックス)](/ccserver/guides/launching/) を参照してください。
