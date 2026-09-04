---
title: メタエージェント (ccserver-meta)
description: ccserver 自体を MCP 経由で操作できる特権エージェント向け MCP サーバー
---

ccserver 自体を MCP 経由で操作できる特権エージェント (**メタエージェント**) 向けの MCP サーバーです。プロジェクト/サンドボックス/グループ/セッションの一覧参照から、セッションやコンボの新規起動、プリセット管理、破壊的操作の実行までをカバーします。`ccserver-notify` / `ccserver-usage` と同じくプロセスグローバルな単一ソケット (`ccserver-meta.sock`) でホストされますが、サーバー全体 (全グループ・全サンドボックス・全プロジェクト) へのアクセスを持つ**単一の信頼されたエージェントにのみ渡す**前提のため、注入条件は両者とは別になっています。

- **オプトイン**: 既定では無効です。設定ファイルで `metaAgentMcp: true` を明示した場合のみ有効化され、さらにセッション起動時に明示的にメタエージェントとして指定された単発セッションにだけ注入されます。コンボのワーカー/オーケストレーターへ自動注入されることは一切ありません (強い権限を持つため、既定オフは `usageMcp` よりさらに強く推奨されます)。
- **固定ディレクトリ起動**: メタエージェントは常にプロジェクト外の固定ディレクトリ `~/.local/share/ccserver-sandbox/meta-agent` で起動されます。ブラウザや API が指定する `cwd` はサーバー側で無視され、プロジェクトのファイルや `CLAUDE.md` が特権セッションに混入することを防ぎます (サーバー側 `createSession` の不変則として強制。`metaAgentMcp` がオフでも flag 付きなら固定化される)。サンドボックスもこの固定ディレクトリ基準で作成され、通常の起動方法選択とは分離した専用の「⌘ メタエージェント」ボタンから起動します。単一の固定ディレクトリのため同時起動はクライアント側の確認で制御され、永続 HOME も `meta-agent` 専用のものが作成されます。

## ツール一覧

権限区分: **R** = 読み取り専用 / **W-low** = 設定データの作成・変更・削除のみ / **W-create** = 新しいセッション・グループの起動 / **W-destructive** = 実行中リソースの終了・削除。W-destructive のみ承認必須。

| 区分 | ツール | 説明 |
|------|--------|------|
| R | `list_projects` | プロジェクト一覧 (表示ラベル / git remote / 最終利用時刻) |
| R | `list_sandboxes` | サンドボックス一覧 (サイズ / 利用中・削除中状態 / 所属プロジェクト) |
| R | `browse_directory` | 指定パスのディレクトリ・ファイル一覧 (`GET /api/dirs` 同等) |
| R | `list_groups` / `get_group` | コンボグループの一覧・メンバー詳細 |
| R | `list_sessions` | 全セッション一覧 |
| R | `list_worker_presets` / `list_launch_presets` | Worker プリセット・コンボ起動プリセットの一覧 |
| W-low | `create_worker_preset` / `update_worker_preset` / `delete_worker_preset` | Worker プリセットの CRUD (既存 REST API と同水準・確認なし) |
| W-low | `create_launch_preset` / `update_launch_preset` / `delete_launch_preset` | コンボ起動プリセット (複数ワーカーを一括起動するテンプレート) の CRUD |
| W-low | `update_project_label` | プロジェクトの表示ラベル変更 |
| W-low | `create_directory` | フォルダ作成 (`{ parent, name, gitInit? }`) |
| W-create | `launch_session` | 単発セッションの新規起動 (`POST /api/sessions` 相当) |
| W-create | `launch_group` / `launch_from_preset` | コンボの新規起動 (`POST /api/groups` 相当) / プリセットからの展開起動 |
| **W-destructive** | `close_session` / `destroy_group` / `delete_sandbox` | セッション強制終了 / グループ破棄 / サンドボックス削除。**必ず下記の承認フローを経由します** |

## 承認フロー (W-destructive)

破壊的ツールが呼ばれると、サーバーは操作を即座には実行せず `pending_approvals` に記録してブラウザ UI からの判断を待ちます (その間、MCP ツール呼び出し自体がブロックされます)。ブラウザ側では画面上部の**グローバルバナー** (どのタブを開いていても表示) に操作内容の要約 (`summary`) が列挙され、**承認 / 却下** を選べます。バナーは `GET /api/approvals?status=pending` を数秒間隔でポーリングして更新され、判断は `POST /api/approvals/:id/decision { decision: 'approved' | 'rejected' }` で送信されます。

**タイムアウトは 5 分固定で、未応答のリクエストは常に「拒否」扱い**になります (fail-safe は常に「何もしない」側)。また、メタエージェントが**自分自身のセッションや自分の所属グループ**を対象に破壊的操作を呼んだ場合は、承認フローに回さずその場でエラーとして拒否されます (fail closed — 自己終了・自己破壊はどんな理由でも代行させません)。`delete_sandbox` については、メタエージェント自身がそのサンドボックス HOME 内で稼働中なら既存の「使用中」ガードが自然に自己削除を防ぎます。

**サンドボックス権限のキャップ**: メタエージェントが `launch_session` / `launch_group` 経由で他セッションに付与する `sandboxOpts` (gpg / sshAgent) は、メタエージェント自身が現在保持する権限でキャップされ、超過分は要求されていても暗黙に downgrade されます (エラーにはなりません)。コンボのオーケストレーターが子ワーカーの権限をキャップするのと同じルールです。
