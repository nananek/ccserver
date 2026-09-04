# ccserver docs

[ccserver](https://github.com/nananek/ccserver) のドキュメントサイトです。[Astro](https://astro.build) + [Starlight](https://starlight.astro.build) で構築されています。

このディレクトリはリポジトリルートの npm workspaces (`server`/`client`) には含まれない、独立した Node プロジェクトです (別の `package.json` / `package-lock.json` を持ちます)。

## コマンド

すべてこのディレクトリ (`docs-site/`) から実行します。

| コマンド | 内容 |
| :------------------------ | :----------------------------------------------- |
| `npm install`              | 依存関係をインストール |
| `npm run dev`               | 開発サーバーを `localhost:4321` で起動 |
| `npm run build`             | 本番ビルドを `./dist/` に出力 |
| `npm run preview`           | ビルド結果をローカルでプレビュー |

## デプロイ

`master` への push で `.github/workflows/docs.yml` が `docs-site/` をビルドし、GitHub Pages (`https://nananek.github.io/ccserver/`) へ自動デプロイします。

## ページの追加

`src/content/docs/` 配下に Markdown (`.md`) / MDX (`.mdx`) ファイルを追加すると、ファイルパスに対応したルートとして公開されます。サイドバーへの表示順は `astro.config.mjs` の `starlight().sidebar` で管理しています。
