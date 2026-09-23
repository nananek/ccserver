---
title: 通知 (ccserver-notify)
description: エージェントが自分で呼べる通知用 MCP サーバー
---

エージェントが**自分で呼べる**通知ツール `notify` を提供する MCP サーバーです。旧来の「一定時間アイドル → ブラウザに `input_needed` 通知」というヒューリスティックは実質機能していなかった (アイドル判定が主観的・非フォーカス時のみ等) ため**廃止**され、この MCP に置き換わりました。

配信先は 2 種類で、設定されているものすべてに**並行**配信されます。

1. **Discord webhook** — `sandbox.config.json` の `notify.discordWebhook` (https のみ) または環境変数 `CCSERVER_DISCORD_WEBHOOK` (こちらが優先)。webhook URL は `.gitignore` 済みの `sandbox.config.json` に入れるため、リポジトリに混入しません。
2. **ランタイム購読 (webhook URL)** — MCP ツール `subscribe` で登録した任意の webhook (`unsubscribe` で解除、`list_subscriptions` で一覧)。購読は `.saved-notifications.json` に永続化され、サーバー再起動後も生き残ります。

:::caution[配信先を1つも設定しないと通知機能ごと無効になります]
`notify.discordWebhook` が未設定で購読もゼロだと `notifyEnabled()` が false になり、**notify MCP 自体がセッションに注入されません** (= エージェントは人間を呼ぶ手段を持ちません)。最低でも 1 つは設定してください。
:::

## 設定例

`server/sandbox.config.json` に追記します。

```json
{
  "notify": {
    "discordWebhook": "https://discord.com/api/webhooks/...",
    "subscriptions": [
      { "url": "https://hooks.example.com/slack", "name": "slack" }
    ]
  }
}
```

`subscriptions` は**初期購読のシード**です。購読ゼロ + Discord 未設定だと MCP 自体が注入されないため、購読だけから始めたい場合はここで seed します (MCP が無いと `subscribe` を呼べないため)。

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
| `notify` | `title`, `body`, `level?` (`info`/`success`/`warning`/`error`), `channels?` (`['discord']`) | 設定済み全チャネルへ配送。`{ ok, delivered: { discord, webhooks, failed } }` |
| `subscribe` | `url` (https のみ), `name?` | webhook 購読を追加・永続化。`{ ok, subscription }` |
| `unsubscribe` | `subscriptionId` | 購読を削除・永続化。`{ ok }` / `{ error: 'not-found' }` |
| `list_subscriptions` | – | `{ subscriptions: [...] }` |

配送は Discord 互換 JSON `{ content, username: 'ccserver' }` を global `fetch` で POST します (10 秒 timeout)。失敗してもエージェント側にはエラーを返さず、ログのみ (非ブロッキング)。

`channels` は配信先を絞るための引数ですが、現状チャネルは `discord` (= Discord webhook + 全購読 webhook) しか無いため、省略時と同じ動作になります。`channels: []` を渡すとどこにも配送しません。

予約プロンプト発火 (`schedule_fired`) のブラウザ Notification とヘッダの通知トグルは**独立した稼働機能**のため温存しています。`input_needed` に関するブラウザ側の `onAttention` / attention タブ表示も削除されました。

## Vikunja 連携について (削除済み)

かつて `notify` は呼び出しごとに Vikunja タスクを作成/更新していましたが、**削除されました**。「人間を呼ぶ (ping)」ことと「タスクを追跡する」ことは関心事が異なり、1 つの MCP ツールに同居させたのが良くなかったためです。あらためて**独立した MCP サーバーとして再実装**する予定です。

- 追従 Issue: [#207 Vikunja 連携を ccserver-notify から切り出し、独立した MCP サーバーとして再実装する](https://github.com/nananek/ccserver/issues/207) — 削除した挙動 (タスク作成 / コメント追記 / status ラベル / Doing・To-Do バケット / `done` にはしない設計判断)、設定項目、使用していた REST エンドポイントをすべて記録してあります。
- `sandbox.config.json` に `notify.vikunja` が残っていても**エラーにはなりません**。キーは無視され、起動時に警告ログが 1 度出るだけです。`CCSERVER_VIKUNJA_*` 環境変数だけで設定していた場合 (旧ドキュメントが `apiToken` について推奨していた形) も同じ警告が出ます。不要になったら削除してください。
- 状態ファイル `.saved-vikunja-tasks.json` (env `CCSERVER_VIKUNJA_TASKS_PATH` で移動していればその場所) も誰からも読まれなくなります。Vikunja 上のタスクとの対応表が入っているだけなので、[#207](https://github.com/nananek/ccserver/issues/207) で再実装したものに引き継ぐ予定が無ければ削除して構いません。
- **Vikunja だけを配信先にしていた環境は、この削除で実配信先がゼロになります**。上の注意書きのとおり配信先ゼロだと notify MCP ごと注入されなくなるので、`notify.discordWebhook` か `notify.subscriptions` を設定してください (ブラウザへの PWA 通知 = Web Push は別途対応予定)。
