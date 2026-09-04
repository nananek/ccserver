---
title: コードレビュー (ccserver-reviewer)
description: 使い捨てのヘッドレスセッションでローカルの ref/ブランチ/PR/未コミット差分をレビューする MCP サーバー
---

任意のセッション (ワーカーでもオーケストレーターでも単発セッションでも) から、ローカルの git ref/ブランチ/PR 番号/未コミット差分に対して `/code-review` を走らせられる MCP サーバーです。GitHub の PR が存在しなくてもレビューできる点が特徴で、未 push のローカルブランチや PR 化前のブランチ、あるいは作業中の未コミット差分もそのままレビュー対象にできます。`ccserver-notify` / `ccserver-usage` と同じくプロセスグローバルな単一ソケット (`ccserver-reviewer.sock`) でホストされます。

- **オプトイン**: 既定では無効です。設定ファイルで `reviewerMcp: true` を明示した場合のみ有効化されます ([設定ファイル](/ccserver/sandbox/configuration/) 参照)。
- **注入対象が広い**: `ccserver-meta` とは異なり、shell と copilot を除く**全セッション**に注入されます。コンボのワーカー/オーケストレーターも対象です (グループの有無を問わず呼び出せる、という設計方針のため)。
- **使い捨ての専用 worktree**: レビュー対象プロジェクトの worktree (`~/.local/share/ccserver-sandbox/review-worktrees/<projectHash>/<jobId>/`) をジョブごとに新規作成し、そこでヘッドレスセッションを起動して `/code-review` を実行します。呼び出し元セッションの作業ディレクトリや、コンボの各ロール用 worktree ([コンボ起動](/ccserver/guides/combo-launch/) 参照) とは完全に分離されており、レビュー中に元の作業を変更しても影響しません。ジョブ終了後は worktree ・セッション・(有効なら) 専用の永続 HOME を破棄します。

## ツール一覧

| ツール | 説明 |
|--------|------|
| `run_review` | レビュージョブを起動し、即座に `{ id, status: "running", ... }` を返す (完了を待たずに返る非同期ツール)。`cwd` は必須。対象の指定は `number` (PR 番号、`gh pr checkout` 経由で取得し完了後 PR にコメント投稿)、`headRef` (ブランチ名/コミット指定)、`includeUncommitted` (未コミット差分) のいずれか 1 つ以上が必要 — 複数指定時は `number` > `headRef` > `includeUncommitted` の優先順位。`baseRef` 省略時はプロジェクトの既定ブランチを自動解決。`focus` (任意・自由記述の文字列) で「セキュリティ面を重点的に」のようなレビューの重点観点を指示できる。 |
| `list_reviews` | プロジェクト単位 (`cwd` 省略可) でジョブ一覧を取得 (id・mode・status・作成/終了時刻など、結果本文は含まない)。 |
| `get_review` | ジョブ 1 件の詳細を `id` で取得 (`resultSummary`・`postedToPr` を含む)。 |
| `finish_review` | レビュージョブ**自身のセッション**が、作業完了時に呼び出す完了報告ツール。`jobId`・`status` (`"done"` または `"failed"`) が必須、`summary` (任意・自由記述) でレビューで見つかった内容を報告できる。詳細は下記「完了検知」を参照。 |

## 重点観点の指定 (`focus`)

`run_review` の `focus` に自由記述の文字列を渡すと、実行される `/code-review` の指示に「`Focus especially on: <focus>`」という一文が追記されます (`number`/`headRef`/`includeUncommitted` のどのモードでも同様)。省略した場合は通常のレビュー (重点指定なし) になります。渡した値は `pr_reviews` テーブルにもそのまま保存されるため、`get_review`/`list_reviews` で後から「何を頼んだレビューだったか」を確認できます。

## 完了検知と結果の受け取り方

`run_review` はジョブを起動した時点ですぐ返るため、完了は `get_review`/`list_reviews` をポーリングして確認します。

完了の判定は **`finish_review` の呼び出しが正**です。`run_review` が組み立てるプロンプトには、レビューセッション自身が作業完了時に `finish_review` を (自分のジョブの `jobId` を添えて) 呼び出すよう常に指示が含まれます。`finish_review` は MCP 接続の識別情報 (per-connection identity) を使って「呼び出しているセッションが、本当にそのジョブが起動したセッション自身か」を検証するため、他のセッションから他ジョブの `finish_review` を呼んだり、成りすましたりすることはできません。すでに完了済みのジョブに対する呼び出しも拒否されます。

`finish_review` が (セッションのクラッシュ・ハング等で) 一度も呼ばれなかった場合に備えて、サーバー側には**フォールバック専用**のアイドルポーラーが残っています。これは以下の 2 パターンのみを検知します:

- レビューセッションのプロセスが既に終了している → `status: "failed"`
- `finish_review` が一度も呼ばれないまま絶対タイムアウト (既定 20 分、実測に基づく値ではないため大きな diff や遅いモデルでは調整が必要な場合がある) を超えた → `status: "timeout"`

画面出力のアイドル時間だけをもって「完了」と推測することはもう行いません (`finish_review` が呼ばれない限り、動作中である限りは `running` のまま待ち続けます)。

ジョブ結果は SQLite (`pr_reviews` テーブル) に永続化されるため、サーバー再起動後も `list_reviews`/`get_review` で参照できます (ただし再起動時点で `running` のままだったジョブは自動再開されず、そのまま `running` 表示で残ります)。

### `reviewerMcp` が無効な環境での挙動

`run_review` が起動するレビュージョブ自身のセッションには、`sandbox.config.json` の `reviewerMcp` フラグの値によらず `ccserver-reviewer` (と `finish_review` を呼ぶために必要な識別情報) が強制的に注入されます。これは、ブローカー起動後に `reviewerMcp` がライブ編集で無効化された場合でも (ブローカー自体は再起動しない限り止まらない)、実行中のレビュージョブが `finish_review` を呼べなくなって完了検知が壊れる、という事態を避けるための安全策です。通常のセッション (レビュージョブ以外) には、これまで通り `reviewerMcp` が有効な場合のみ注入されます。

## 同時実行数の上限

`run_review` はプロセス全体で同時に受け付けるジョブ数を上限 4 件 (環境変数 `CCSERVER_REVIEWER_MAX_CONCURRENT` で変更可) に制限しています。shell/copilot を除く全セッションから (ワーカー含め) 呼び出せる設計上、ループ的な呼び出しでサンドボックスセッションを際限なく起動されるのを防ぐための安全弁です。上限に達した状態で `run_review` を呼ぶと `{ ok: false, error: "too many review jobs running..." }` を返すので、`list_reviews` で既存ジョブの完了を待ってから再試行してください。
