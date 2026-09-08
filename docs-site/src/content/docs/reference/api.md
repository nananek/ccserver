---
title: API
description: 認証、REST API、WebSocket プロトコルのリファレンス
---

## 認証 (任意)

`CCSERVER_AUTH_MODE` 環境変数で `none` (既定、認証なし) / `token` (下記の固定共有トークン) / `passkey` (パスキー + ワンタイムトークン、[認証ガイド](/ccserver/guides/auth/) 参照) を切り替えます。未設定時は `CCSERVER_TOKEN` の有無で `token`/`none` のどちらかに解決されるため、この節で説明する `CCSERVER_TOKEN` 単体での有効化は従来通りそのまま使えます。

`CCSERVER_TOKEN` 環境変数を設定すると、`/api` と `/ws` 配下の全リクエストに Jupyter 風のトークン認証がかかります (未設定なら無効)。`?token=<TOKEN>` クエリか `Authorization: Bearer <TOKEN>` ヘッダのどちらかで通ります。クライアントは 401 を受けると `prompt()` でトークンを聞き、`localStorage` (`ccserver-token`) に保存して以降のリクエストへ自動付与します (`client/src/auth.js`)。

```bash
CCSERVER_TOKEN=some-secret NODE_ENV=production node server/index.js
```

## REST

| メソッド | パス | 説明 |
|---|---|---|
| GET | `/api/dirs?path=<path>&showHidden=1` | 指定パスのサブディレクトリ/ファイル一覧 |
| GET | `/api/dirs/home` | `{ home, defaultApp, availableApps, metaAgentEnabled, metaAgentDir }` — サーバーのホームディレクトリ、既定起動アプリ、検出済みCLI (`claude`/`opencode`/`copilot`/`codex`)、メタエージェント有効フラグと固定ディレクトリ |
| POST | `/api/dirs` | `{ parent, name }` でフォルダ作成 |
| GET | `/api/sessions` | 実行中セッションの一覧 |
| DELETE | `/api/sessions/:id` | セッションを終了する (予約プロンプトも解除) |
| GET | `/api/files?path=<path>` | ファイルをダウンロード |
| GET | `/api/files/content?path=<path>` | ファイルブラウザのプレビュー用。`.md` / `.txt` のみ対象で、UTF-8 テキストを JSON (`{ path, name, size, mtime, kind, content, truncated }`) で返す。`kind` は `.md` なら `markdown`、`.txt` なら `text` (レンダリングはクライアント側で DOMPurify を通して行う)。先頭 1 MiB を超える分は切り捨てて `truncated: true`。他の拡張子、および先頭 8 KiB に NUL バイトを含むバイナリは 415 |
| POST | `/api/files` | multipart アップロード (`destination` フィールド + ファイルパート) |
| GET | `/api/system-stats?ipmi=1` | CPU/メモリ/温度/GPU (`nvidia-smi`)/IPMI (要 `ENABLE_IPMI=1`)・load average |
| GET | `/api/usage?force=1` | Claude Code `/usage` のキャッシュ済みスナップショット (`force=1` で即時再取得) |
| GET / POST | `/api/worker-presets` | Worker プリセット一覧取得 / 作成 (`{ name, role, app, model }`、`model` は null 可) |
| PUT / DELETE | `/api/worker-presets/:id` | プリセットの全置換更新 / 削除。role 重複は 409 |
| GET / POST | `/api/launch-presets` | コンボ起動プリセット一覧 / 作成 (`{ name, workers: [1–7 x { role, app, model?, name?, sandboxOpts? }], orchestratorApp?, orchestratorModel?, instructions? }`)。管理 UI は無く、メタエージェントの MCP ツールと対になる REST |
| PUT / DELETE | `/api/launch-presets/:id` | コンボ起動プリセットの全置換更新 (workers スナップショットごと置換) / 削除。preset 名重複は 409 |
| GET | `/api/projects` | プロジェクト一覧 (サンドボックス永続 HOME の所属プロジェクト行。`{ id, cwd, pathHash, label, gitRemote, lastSeenAt }`) |
| PUT | `/api/projects/:id/label` | プロジェクト表示ラベル変更 (`{ label }`、null でクリア)。メタエージェントの `update_project_label` と同じストア経由 |
| POST | `/api/sessions` | 単発セッションをサーバー側で新規起動 (`{ cwd, app?, model?, shell?, sandbox?, sandboxOpts?, resume?, isMetaAgent? }` — `isMetaAgent: true` のとき `cwd` は省略可かつ無視され、固定ディレクトリ `~/.local/share/ccserver-sandbox/meta-agent` で起動)。メタエージェントの `launch_session` と同一実装 (`isMetaAgent: true` は `metaAgentMcp: true` のときのみ意味を持つ) |
| POST | `/api/groups` | コンボ起動。従来の `workerA`/`workerB`/`orchestrator` に加え、canonical な `workers: [{ name?, role, app?, model?, sandboxOpts? }]` (1–7 人、role 一意) を受け付ける。プリセットはクライアントがスナップショットへ展開して送る。copilot はどちらの経路でも 400 拒否 |
| GET | `/api/approvals?status=pending` | メタエージェントの承認待ち破壊的操作一覧 ([メタエージェント](/ccserver/guides/meta-agent/) 参照)。ブラウザのグローバルバナーが数秒間隔でポーリング |
| POST | `/api/approvals/:id/decision` | `{ decision: 'approved' \| 'rejected' }` で承認待ち操作を承認/却下する。5 分未応答のリクエストはサーバー側で expired (拒否扱い) になる |
| GET | `/api/federation/identity` | `{ enabled, fingerprint?, keyPermissionsSafe? }` — このインスタンス自身の federation 有効/無効と証明書 fingerprint |
| GET | `/api/federation/instances` | ペアリング済みインスタンス一覧 (全ステータス)。呼び出しのたびに未確定 (pending) 行を相手へ問い合わせて解決を試みる |
| POST | `/api/federation/instances` | `{ remoteAddr, remoteToken?, label? }` で新規ペアリングを発信 (`remoteAddr` は `host:port`) |
| PATCH | `/api/federation/instances/:id` | `{ label }` で表示名を変更 |
| DELETE | `/api/federation/instances/:id` | ペアリングを取り消す (即時・ローカルのみ。相手には通知されない) |
| GET | `/api/federation/pending` | 未承認 (双方向承認の途中) のペアリング一覧 |
| POST | `/api/federation/pending/:id/decide` | `{ decision: 'approved' \| 'rejected' }` — このインスタンス側の人間の承認/却下を記録する |
| GET/POST/DELETE | `/api/federation/instances/:id/{sessions,groups,dirs}` | `active` なペアへの薄いプロキシ。ボディ/レスポンス形状はそれぞれ `/api/sessions`・`/api/groups`・`/api/dirs` と同一 |
| GET | `/api/auth/mode` | `{ mode: 'none' \| 'token' \| 'passkey' }` — 現在の `CCSERVER_AUTH_MODE`。認証不要 (`token` モードのみ、他の `/api` と同様にトークン必須) |
| GET | `/api/auth/session` | セッション Cookie の有効性確認専用 (200/401 のみが意味を持つ)。`passkey` モード限定 |
| POST | `/api/auth/login-token` | `{ token }` — `node server/cli/issue-login-token.js` が発行したワンタイムトークンを検証し、セッション Cookie を発行する (`passkey` モード限定、use-once) |
| POST | `/api/auth/webauthn/register-options` / `register-verify` | パスキー登録 (要セッション、[認証ガイド](/ccserver/guides/auth/) フロー2、`passkey` モード限定) |
| POST | `/api/auth/webauthn/authenticate-options` / `authenticate-verify` | パスキー認証 (未ログインで許可、フロー3、`passkey` モード限定) |
| GET | `/api/auth/webauthn/credentials` | 登録済みパスキー一覧 (要セッション、`{ id, label, createdAt, lastUsedAt }[]`、`passkey` モード限定) |

`GET /api/dirs` のレスポンス例:

```json
{
  "current": "/home/user",
  "parent": "/home",
  "dirs": [
    { "name": "projects", "path": "/home/user/projects" }
  ],
  "files": [
    { "name": "notes.txt", "path": "/home/user/notes.txt", "size": 123, "mtime": 1730000000000 }
  ]
}
```

## `WebSocket /ws/terminal`

JSON メッセージでターミナル I/O とセッション管理 (アタッチ・予約プロンプト・自動承認) を中継。

1 つのセッションには**複数のクライアントが同時に接続できます**。後から `attach` したクライアントが既存の接続を切ることはなく、`output` などのサーバー発メッセージは接続中の全クライアントへ配信されます。PTY のサイズは 1 つしか持てないため、接続中の全クライアントが申告した `cols`/`rows` の**最小値**が採用され、確定サイズが `size` で通知されます。

| 方向 | type | フィールド | 説明 |
|------|------|-----------|------|
| → | `init` | `cwd`, `cols`, `rows`, `claudeSessionId?`, `shell?`, `sandbox?`, `sandboxOpts?`, `app?`, `resume?` | 新規セッションを起動 (`app`: `"claude"` (既定)、`"opencode"`、`"copilot"`、`shell: true` で素のシェル、`resume: true` で opencode/copilot の最終セッションに再開) |
| → | `attach` | `sessionId`, `cols?`, `rows?` | 既存セッションに接続 (出力バッファを `replay` で再送)。既に他のクライアントが接続していても切断されず、共有になる |
| → | `input` | `data` | キーボード入力 |
| → | `resize` | `cols`, `rows` | 希望サイズの申告。共有中は最小値が採用されるため要求どおりとは限らず、確定サイズが `size` で返る |
| → | `ping` | – | 疎通確認 (`pong` が返る) |
| → | `set_auto_yes` / `get_auto_yes` | `enabled?` | 確認プロンプトの自動承認 ON/OFF・状態取得 |
| → | `schedule_prompt` | `time` (`"HH:MM"`) か `at` (epoch ms), `text` | 予約プロンプトを設定 |
| → | `cancel_schedule` / `get_schedule` | – | 予約の解除・現在状態の取得 |
| ← | `session` | `sessionId`, `cwd`, `cols`, `rows`, `isReconnect`, `isMetaAgent`, `viewers` | スポーン/接続完了 (`viewers`: 自分を含む接続クライアント数) |
| ← | `size` | `cols`, `rows` | PTY の確定サイズ。自分の `resize` への応答、および他クライアントの接続・切断で最小値が変わった時に全クライアントへ配信 |
| ← | `viewers` | `count` | 接続クライアント数の変化 (接続・切断時) |
| ← | `output` | `data` | ターミナル出力 |
| ← | `replay` | `data` | `attach` 時、切断中に貯まった出力バッファを再送 (複数回届く) |
| ← | `exit` | `exitCode`, `signal`, `claudeSessionId` | プロセス終了 |
| ← | `auto_yes_state` | `enabled`, `log` | 自動承認の状態変化・ログ |
| ← | `schedule_state` | `scheduled`, `serverTz`, `serverNow`, `error?` | 予約プロンプトの現在状態 (サーバー時刻/TZ 付き) |
| ← | `error` | `message`, `code` | エラー通知 (`SESSION_NOT_FOUND` は自動再接続、それ以外はターミナルにメッセージを表示) |
| ← | `pong` | – | `ping` への応答 |

## `WebSocket /ws/remote-terminal`

拠点間ペアリング ([federation](/ccserver/guides/federation/)) のリモート端末タブが使う中継専用エンドポイント。メッセージ語彙は `/ws/terminal` と完全に同一で、`init`/`attach` の最初のメッセージに `instanceId` (ペアリング済みインスタンスの id) を追加で含める点だけが違います。以降のメッセージはそのまま federation TLS チャンネル経由で相手インスタンスの `/ws/terminal` ロジックへ中継され、`output`/`replay`/`exit` などの応答もそのまま返ってきます。相手が `active` なペアでない場合は `error` (`code: 'INSTANCE_NOT_FOUND'`)、接続後に federation 側が切断された場合は `error` (`code: 'REMOTE_DISCONNECTED'`) を送ってからソケットを閉じ、クライアント側の既存の自動再接続ロジックに委ねます。
