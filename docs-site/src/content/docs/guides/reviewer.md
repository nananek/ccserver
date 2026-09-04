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

## 重点観点の指定 (`focus`)

`run_review` の `focus` に自由記述の文字列を渡すと、実行される `/code-review` の指示に「特に次の観点を重点的に見てください: `<focus>`」という一文が追記されます (`number`/`headRef`/`includeUncommitted` のどのモードでも同様)。省略した場合は通常のレビュー (重点指定なし) になります。渡した値は `pr_reviews` テーブルにもそのまま保存されるため、`get_review`/`list_reviews` で後から「何を頼んだレビューだったか」を確認できます。

## 完了検知と結果の受け取り方

`run_review` はジョブを起動した時点ですぐ返るため、完了は `get_review`/`list_reviews` をポーリングして確認します。サーバー側では画面出力が一定時間 (既定 60 秒) 静止したこと、かつ最低実行時間を超えたことをもって `/code-review` の完了とみなし、20 分の絶対タイムアウトを安全弁として持っています。この閾値は実測に基づくものではないため、レビュー対象や利用モデルによっては調整が必要になる場合があります。

ジョブ結果は SQLite (`pr_reviews` テーブル) に永続化されるため、サーバー再起動後も `list_reviews`/`get_review` で参照できます (ただし再起動時点で `running` のままだったジョブは自動再開されず、そのまま `running` 表示で残ります)。

## 同時実行数の上限

`run_review` はプロセス全体で同時に受け付けるジョブ数を上限 4 件 (環境変数 `CCSERVER_REVIEWER_MAX_CONCURRENT` で変更可) に制限しています。shell/copilot を除く全セッションから (ワーカー含め) 呼び出せる設計上、ループ的な呼び出しでサンドボックスセッションを際限なく起動されるのを防ぐための安全弁です。上限に達した状態で `run_review` を呼ぶと `{ ok: false, error: "too many review jobs running..." }` を返すので、`list_reviews` で既存ジョブの完了を待ってから再試行してください。
