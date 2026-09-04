---
title: 通知 (ccserver-notify) と Vikunja 連携
description: エージェントが自分で呼べる通知用 MCP サーバーと、Vikunja タスク連携の詳細
---

エージェントが**自分で呼べる**通知ツール `notify` を提供する MCP サーバーです。旧来の「一定時間アイドル → ブラウザに `input_needed` 通知」というヒューリスティックは実質機能していなかった (アイドル判定が主観的・非フォーカス時のみ等) ため**廃止**され、この MCP に置き換わりました。

配信先は最大 3 種類で、設定されているものすべてに**並行**配信されます。

1. **Discord webhook** — `sandbox.config.json` の `notify.discordWebhook` (https のみ) または環境変数 `CCSERVER_DISCORD_WEBHOOK` (こちらが優先)。webhook URL は `.gitignore` 済みの `sandbox.config.json` に入れるため、リポジトリに混入しません。
2. **ランタイム購読 (webhook URL)** — MCP ツール `subscribe` で登録した任意の webhook (`unsubscribe` で解除、`list_subscriptions` で一覧)。購読は `.saved-notifications.json` に永続化され、サーバー再起動後も生き残ります。
3. **Vikunja タスク** — `notify.vikunja` (`baseUrl` + `apiToken`) を設定すると、`notify` 呼び出しごとに Vikunja タスクを作成/更新します。Discord は見逃されがちですが、Vikunja はタスクとして残るため「人間の対応待ち」を TODO として拾えます。詳細は [Vikunja 連携](#vikunja-連携) を参照。

## 設定例

`server/sandbox.config.json` に追記します。

```json
{
  "notify": {
    "discordWebhook": "https://discord.com/api/webhooks/...",
    "subscriptions": [
      { "url": "https://hooks.example.com/slack", "name": "slack" }
    ],
    "vikunja": {
      "baseUrl": "https://vikunja.example.com",
      "apiToken": "",
      "projectId": 3
    }
  }
}
```

`subscriptions` は**初期購読のシード**です。購読ゼロ + Discord 未設定 + Vikunja 未設定だと MCP 自体が注入されないため、購読だけから始めたい場合はここで seed します (MCP が無いと `subscribe` を呼べないため)。Vikunja だけ設定した場合 (Discord 未設定・購読ゼロ) も MCP は注入されます。

## 発信元属性 (自動付与)

各通知のペイロード末尾に、どのセッションから送られたかを示すフッターが自動で付与されます (`notify.hostname` 未設定なら OS の hostname、`CCSERVER_HOSTNAME` 環境変数が最優先)。

```
🚨 Build failed
details here

_from: myhost · myproject · group abc12345 · session 01234567
```

- `<host>` は常に付与 (複数ホストで同じ webhook を共有する場合は `notify.hostname` で固定できます)。
- `<project>` はセッションの cwd の basename、`group <…>` はコンボのグループ ID 先頭 8 文字 (スタンドアロンでは付かない)、`session <…>` はセッション ID 先頭 8 文字です。
- フッターを出したくない場合は `notify.attribution: false` で丸ごと無効化できます (既定 `true`)。

## 注入条件

スタンドアロン (グループ外) のエージェントセッションと、コンボ起動の**オーケストレーターのみ**に注入されます。シェル・コンボのワーカーには注入されません。サンドボックス内外どちらでも動作します (サンドボックス内はソケットを bind、外はホストの node でブリッジを実行)。

## ツール

| ツール | 引数 | 説明 |
|--------|------|------|
| `notify` | `title`, `body`, `level?` (`info`/`success`/`warning`/`error`) | 全チャネルへ配送。`{ ok, delivered: { discord, webhooks, failed, vikunja? } }` (`vikunja` は Vikunja 未設定時は省略) |
| `subscribe` | `url` (https のみ), `name?` | webhook 購読を追加・永続化。`{ ok, subscription }` |
| `unsubscribe` | `subscriptionId` | 購読を削除・永続化。`{ ok }` / `{ error: 'not-found' }` |
| `list_subscriptions` | – | `{ subscriptions: [...] }` |

配送は Discord 互換 JSON `{ content, username: 'ccserver' }` を global `fetch` で POST します (10 秒 timeout)。失敗してもエージェント側にはエラーを返さず、ログのみ (非ブロッキング)。

予約プロンプト発火 (`schedule_fired`) のブラウザ Notification とヘッダの通知トグルは**独立した稼働機能**のため温存しています。`input_needed` に関するブラウザ側の `onAttention` / attention タブ表示も削除されました。

## Vikunja 連携

`notify.vikunja` (`baseUrl` https のみ + `apiToken`、両方必須) を設定すると、`notify` 呼び出し1回ごとに Vikunja タスクを作成/更新します (`server/ws/vikunjaClient.js`)。

- **追跡単位**: `groupId` (無ければ `sessionId`) をキーに、進行中のタスク ID を `.saved-vikunja-tasks.json` (`.gitignore` 済み) に永続化します。identity が無い呼び出し (`groupId`/`sessionId` どちらも無し) は Vikunja 連携をスキップし、Discord/webhook のみ配送します。
- **オーケストレーターの運用フロー (開始報告)**: コンボ起動のオーケストレーターは、人間から新しいタスクを引き受けたら作業投入の前に `notify({ title: '開始: <概要>', body: '<スコープ/分担>', level: 'info' })` を**タスクあたり1回だけ**呼びます (オーケストレーター注入テンプレート `server/ws/orchestrator-template.md` の Notification discipline に明記)。この初回 `info` がグループの追跡タスクを自動作成 (`status-running` ラベル、Doing バケット) し、以後の通知は同一タスクへのコメントになります。開始報告を省くとそのタスクは Vikunja 上で追跡されません。Vikunja 未設定環境では Discord/webhook 配送のみ行われます。
- **初回**: 新規タスクを作成 (`title` = notify の `title`、`description` = `body` + 送信元フッター)。**2回目以降 (同じキー)**: タスクへコメントを1件追記 (`title` を先頭行、`body` を本文)。タスクの説明欄そのものは書き換えません。**1つのキー(グループ/セッション)につきカードは1枚を使い回します** — `success` になっても追跡は終わらず、次の `notify` は新規タスクではなく同じカードへのコメント追記になります。
- **理由はラベルで、「今どちらの番か」は Kanban バケットで表現**します。`done: true` にする操作は一切行いません -- 完了報告 (`success`) はあくまで「人間の番になった」ことを意味するのであって、人間による確認が済んだ「done」ではないためです。実際に done にするかどうかは人間が Vikunja 上で判断します:

  | `level` | ラベル (`notify.vikunja.statusLabelPrefix`、既定 `status-`) | バケット (`notify.vikunja.buckets`) | 意味 |
  |---|---|---|---|
  | `info` (既定) | `status-running` | **Doing** | Claude が作業中 |
  | `success` | `status-completed` | **To-Do** | 人間の番(確認して次のプロンプトを) |
  | `warning` | `status-blocked` | **To-Do** | 人間の番(判断待ち) |
  | `error` | `status-needs-input` | **To-Do** | 人間の番(入力が必要) |

  同じカードが `info` ↔ `success`/`warning`/`error` の切り替えのたびに Doing/To-Do を行き来します。新しいグループ/セッション(=新しい追跡キー)になって初めて新しいカードが作られます。

  バケットは「Claude の番 (Doing) / 人間の番 (To-Do)」の2値のみで、詳細な理由分けは引き続きラベルが担います。バケット名は `notify.vikunja.buckets.doing`/`buckets.todo` (既定 `Doing`/`To-Do`、`CCSERVER_VIKUNJA_BUCKET_DOING`/`CCSERVER_VIKUNJA_BUCKET_TODO` で上書き可) で、プロジェクトの Kanban ビューに存在しなければ自動作成します。ラベルもバケットも見つからなければ自動作成しますが、ラベルは Vikunja アカウント単位 (プロジェクト単位ではない) です。
- **リトライ**: 4xx は即座に諦め、5xx / 接続エラー / タイムアウト (`notify.vikunja.timeoutSeconds`、既定15秒) のみ指数バックオフで最大3回試行。失敗してもエージェント側にはエラーを返さず `console.warn` にログを残すのみ (URL やトークンはログに出さず、失敗種別とステータスコードのみ)。
- **notify 自体の有効化条件にも算入**: `discordWebhook` 未設定・購読ゼロでも `notify.vikunja` (baseUrl + apiToken) だけで notify MCP が注入されます。
- `apiToken` は秘匿値なので `sandbox.config.json` への直書きより環境変数 `CCSERVER_VIKUNJA_API_TOKEN` を推奨します (`baseUrl`/`projectId` も `CCSERVER_VIKUNJA_BASE_URL`/`CCSERVER_VIKUNJA_PROJECT_ID` で上書き可)。`projectId` が未設定のままだとタスク作成はできません (warning ログのみ、エラーにはしません)。
