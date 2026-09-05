---
title: 起動 (アプリ・サンドボックス)
description: セッションの起動方法、アプリ選択、Worker プリセット、各 CLI ごとの挙動の違い
---

起動ボタン右の **▼** から開くモーダルで、起動方法を選べます。

| 項目 | 選択肢 | 記憶される場所 |
|------|--------|----------------|
| アプリ | Claude Code / opencode / GitHub Copilot / OpenAI Codex / Command Code | ブラウザの `localStorage` (次回以降の既定) |
| 起動モード | 通常起動 / 🔒 サンドボックスで起動 | 同上 |
| 許可モード (Command Code のみ) | 標準 / 自動承認 (`--auto-accept`) / yolo (`--yolo`) | 同上 (標準の選択も含めて記憶) |
| GPG署名を使う | on/off (既定 off) | `localStorage` に**ディレクトリ単位**で |
| ssh-agentを転送する | on/off (既定 off) | 同上 |

サンドボックス・GPG・ssh-agent の詳細は [サンドボックス](/ccserver/sandbox/overview/) を参照してください。「アプリ」と「起動モード」のどちらの項目をクリックしても、選んだ内容で即座に起動します。

コンボ起動のロール別アプリ選択 (ワーカーA / ワーカーB / オーケストレーター) もブラウザの `localStorage` に記憶され、次回のコンボ起動の既定になります (初期値: ワーカーA・オーケストレーターが Claude Code、ワーカーB が opencode)。各ロールで Claude Code / opencode / OpenAI Codex を選択可能です (copilot のみ不可)。単発起動の「アプリ」記憶とは独立しており、コンボ起動には `defaultApp` は適用されません。

**Worker プリセット**: 表示名・ロール・CLI・モデルを1組み合わせにした起動テンプレートをサーバー共有で保存でき (SQLite `ccserver.sqlite3`、`CCSERVER_DB_PATH` で変更可)、コンボモーダルの「Worker プリセット」から複数選択して起動できます。ロール (`workerImplement` 等) は MCP handoff・git worktree・セッション識別子として使われる技術識別子で、表示名とは独立です。プリセットの追加・編集・削除は「プリセット管理」ダイアログから行え、選択済みの行や起動済みグループには影響しません (起動時にスナップショットとして展開されるため)。プリセット一覧の取得に失敗した場合も、従来どおりワーカーA/Bのドラフトで起動できます。起動済みグループのタブでは、表示名があるメンバーは「実装担当（workerImplement）」のように表示されます。

新規セッションの既定アプリ・サンドボックス設定は `sandbox.config.json` (詳細は [設定ファイル](/ccserver/sandbox/configuration/)) でサーバー全体の初期値を決められますが、上記モーダルで一度でも明示的に選んだ後はブラウザ側の記憶が優先されます。

**サーバーにインストールされていない CLI は選択できません**: ccserver は起動モーダル表示時にサーバー側の実行ファイル解決 (PATH・サーバーの node バイナリディレクトリ・`~/.local/bin`・アプリ別ディレクトリ) を確認し、見つからないアプリはグレーアウトされます (ツールチップ「サーバーに未インストール」)。既定アプリが未インストールの場合も、利用可能なアプリへ自動で切り替えます。何らかの経路で未インストールのアプリが指定された場合 (例: 予約プロンプトの自動再開)、サーバーは `Cannot launch: <app> is not installed on this server (searched ...)` という明示エラーを返します。インストール/アンインストールした場合はブラウザを再読込すれば反映されます。

## opencode を選んだ場合の挙動の違い

- **クリップボード同期 (OSC 52)**: opencode がターミナルに書き込む OSC 52 シーケンスをブラウザが解釈し、システムクリップボードへ反映します (xterm.js は OSC 52 を無視するため、ccserver 側で処理)。
- **TUI ネイティブスクロール**: opencode は独自の代替画面バッファでスクロールするため (xterm.js 自体のスクロールバックは効きません)、マウスホイール/タッチドラッグは合成ホイールイベントとして、ターミナル下部のスクロールボタンは opencode のメッセージスクロールキー (PageUp/PageDown, Ctrl+G/Ctrl+Alt+G) として中継されます。
- **列数の確保**: 狭い画面 (スマホ等) では、opencode のプロンプト表示 (agent · model · provider 行) が折り返して画面の大半を占領しないよう、68 列を下限にフォントサイズを自動で縮小します。
- Usage ボタンは Claude Code の `/usage` 専用のため、opencode セッションでは非表示になります。

## GitHub Copilot を選んだ場合

- コマンドは `copilot`。認証情報 (`~/.config/github-copilot` の `hosts.json`) と設定 (`~/.copilot`) はサンドボックスにも rw で見えるため、ログイン状態・モデル選択・セッション履歴はサンドボックス起動でも維持されます。
- **再開は `copilot --continue`** (最後のセッションへの再開) のみです。会話 ID を指定しての再開はできません (copilot の TUI は ID を出力しないため)。exit 後のセッション一覧からの再開や、予約プロンプト発火時の自動復帰も `--continue` で行われます。
- モデル入力欄に入れたモデル名は `--model <model>` として渡されます。
- Usage ボタンは Claude Code 専用のため非表示になります。
- **コンボ起動では選択できません**: copilot には MCP を CLI 引数/環境変数で注入する仕組みが無い (設定ファイル経由のため) ので、グループメンバーにしても ccserver の MCP broker ツールが使えません。コンボのメンバーには claude / opencode / OpenAI Codex が選べます (copilot のみ不可)。Codex は `-c mcp_servers...` でプロセススコープに注入されるため `~/.codex/config.toml` を変更せずに利用できます。

## OpenAI Codex について

- 単体起動でモデル入力と `codex resume` / `codex resume --last` を利用できます。Codex の TUI 出力からセッション ID は推測しません。
- Codex の永続 `codex mcp add` は自動実行しません。ccserver は起動単位の `-c mcp_servers.<name>=...` で MCP を注入するため、`~/.codex/config.toml` を変更せずにコンボ起動でも利用できます。
- サンドボックスではプロジェクト単位の永続 HOME 内に `~/.codex` を保持します。Codex 自身の sandbox/approval policy は ccserver 側から無条件に緩和しません。

## Command Code について

- 単体起動でモデル入力 (`--model <model>`) と `command-code --resume <id>` / `-c` (最後の会話への再開) を利用できます。TUI 出力からセッション ID は推測しません。
- **許可モード** (Command Code 選択時のみ表示): `標準` (既定、フラグなし) / `自動承認` (`--auto-accept` 付きで開始) / `yolo` (`--yolo` 付きで開始し、全ての許可プロンプトを回避)。選択は標準も含めてブラウザに記憶されます。yolo モードのセッションはセッション一覧とターミナルヘッダに `yolo` バッジが付きます。予約プロンプトの自動再開・サーバー再起動後の復元でもモードは維持されます。
- **コンボ起動では選択できません** (グループメンバーに必要な MCP 注入が CLI 引数/環境変数でできないため)。
- 認証情報 (ホストの `~/.commandcode/auth.json`) はサンドボックスにも rw-bind されるため、サンドボックス起動でも再ログインは不要です。
