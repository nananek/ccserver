---
title: 通知 (ccserver-notify / 通知ブリッジ / PWA 通知)
description: エージェントが自分で呼べる通知用 MCP サーバーと、CLI のデスクトップ通知の転送、PWA への Web Push
---

エージェントが**自分で呼べる**通知ツール `notify` を提供する MCP サーバーです。旧来の「一定時間アイドル → ブラウザに `input_needed` 通知」というヒューリスティックは実質機能していなかった (アイドル判定が主観的・非フォーカス時のみ等) ため**廃止**され、この MCP に置き換わりました。

配信先は 3 種類で、設定されているものすべてに**並行**配信されます。

1. **Discord webhook** — `sandbox.config.json` の `notify.discordWebhook` (https のみ) または環境変数 `CCSERVER_DISCORD_WEBHOOK` (こちらが優先)。webhook URL は `.gitignore` 済みの `sandbox.config.json` に入れるため、リポジトリに混入しません。
2. **ランタイム購読 (webhook URL)** — MCP ツール `subscribe` で登録した任意の webhook (`unsubscribe` で解除、`list_subscriptions` で一覧)。購読は `.saved-notifications.json` に永続化され、サーバー再起動後も生き残ります。
3. **PWA 通知 (Web Push)** — ブラウザ/スマートフォンへの push。タブを閉じていても届きます。設定 &gt; 通知 から端末ごとに購読します。詳細は [PWA 通知 (Web Push)](#pwa-通知-web-push)。

:::caution[配信先を1つも設定しないと通知機能ごと無効になります]
`notify.discordWebhook` が未設定で購読もゼロだと `notifyEnabled()` が false になり、**notify MCP 自体がセッションに注入されません** (= エージェントは人間を呼ぶ手段を持ちません)。起動時のログにも警告が出ます。最低でも 1 つは設定してください。

なお PWA 通知 (Web Push) は**この判定には数えません**。notify MCP をエージェントに渡すかどうかは webhook 系の設定で決まり、Web Push は通知ブリッジと `notify` ツールの配信先として使われます。
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
| `notify` | `title`, `body`, `level?` (`info`/`success`/`warning`/`error`), `channels?` (`['discord' \| 'webpush']`) | 設定済み全チャネルへ配送。`{ ok, delivered: { discord, webhooks, failed, webpush? } }` (`webpush` は購読ゼロまたは `channels` で除外時は省略) |
| `subscribe` | `url` (https のみ), `name?` | webhook 購読を追加・永続化。`{ ok, subscription }` |
| `unsubscribe` | `subscriptionId` | 購読を削除・永続化。`{ ok }` / `{ error: 'not-found' }` |
| `list_subscriptions` | – | `{ subscriptions: [...] }` |

配送は Discord 互換 JSON `{ content, username: 'ccserver' }` を global `fetch` で POST します (10 秒 timeout)。失敗してもエージェント側にはエラーを返さず、ログのみ (非ブロッキング)。

`channels` は配信先を絞るための引数です。`discord` は Discord webhook と全購読 webhook をまとめて指し、`webpush` は購読済みの端末を指します。`channels: []` を渡すとどこにも配送しません。

予約プロンプト発火 (`schedule_fired`) のブラウザ Notification とヘッダの通知トグルは**独立した稼働機能**のため温存しています。`input_needed` に関するブラウザ側の `onAttention` / attention タブ表示も削除されました。

## 通知ブリッジ (CLI のデスクトップ通知を転送する)

`notify` MCP は「エージェントが自分で呼ぶ」通知でした。**通知ブリッジ**はその逆で、AI CLI が**普段どおり出そうとしたデスクトップ通知**を ccserver が横取りして、上と同じ配信先へ流します。エージェントに何も指示しなくても、権限待ちやアイドル通知が手元に届きます。

### なぜ横取りが必要なのか

サンドボックス内の CLI は**ホストの通知デーモンに到達できません**。

- bwrap はホストの D-Bus セッションソケットを bind しないので `notify-send` は原理的に動きません。
- macOS の seatbelt プロファイルは Apple Events を許可していないので `osascript` / `terminal-notifier` も動きません。

残る出口は **pty の標準出力**、つまり通知用のエスケープシーケンスだけです。ブリッジはそこを読みます。

### 対応している形式

| 形式 | 出す CLI |
|---|---|
| `OSC 777` (`ESC ]777;notify;<title>;<message> BEL`) | Claude Code (ghostty チャネル)、opencode |
| `OSC 9` (`ESC ]9;<text> BEL`) | Claude Code (iterm2 チャネル) |
| `OSC 99` (複数チャンク) | Claude Code (kitty チャネル) |
| 裸の BEL | Claude Code (terminal_bell チャネル)。既定では無視 |

:::note[Claude Code は既定だと何も出しません]
`preferredNotifChannel` の既定値 `auto` は `TERM_PROGRAM` を見てチャネルを決めますが、ccserver は pty に `TERM=xterm-256color` しか渡しません。したがって `auto` は `no_method_available` に落ち、**通知は一切出ません**。

そのためブリッジは起動時に `claude --settings '{"preferredNotifChannel":"ghostty"}'` を注入します。**プロセス限りの指定で、ホストの `~/.claude/settings.json` は書き換えません**。`hooks` キーを含まないので、利用者が設定済みのフックとも衝突しません (実機で Stop フックが1回だけ発火することを確認済み)。
:::

### 設定

設定 &gt; 通知 から編集できます (`sandbox.config.json` の `notify.bridge`)。

```json
{
  "notify": {
    "bridge": {
      "enabled": false,
      "apps": ["claude", "opencode"],
      "injectConfig": true,
      "channels": ["discord", "webpush"],
      "captureBell": false,
      "minIntervalMs": 3000,
      "dedupeWindowMs": 10000,
      "maxPerHour": 60,
      "level": "info"
    }
  }
}
```

| キー | 既定 | 意味 |
|---|---|---|
| `enabled` | `false` | 機能全体。オフの間は捕捉も設定注入も行わず、**CLI の起動コマンドラインは機能追加前と完全に同一**です |
| `apps` | `["claude","opencode"]` | 捕捉対象。`codex` は検証環境に binary が無く未検証のため既定から外してあります (選択は可能)。`copilot` / `commandcode` は設定注入の手段が無いため「既定で吐けば拾えるだけ」です |
| `injectConfig` | `true` | 上記の「吐かせる」設定を注入するか |
| `channels` | `["discord","webpush"]` | 転送先。空にすると検出器自体が付きません |
| `captureBell` | `false` | 裸の BEL も通知として扱う。シェルの補完音や `printf '\a'` と区別できないため既定オフ |
| `minIntervalMs` | `3000` | 同一セッションからの連投を間引く最小間隔 |
| `dedupeWindowMs` | `10000` | 同一内容の重複を抑止する窓 |
| `maxPerHour` | `60` | 1セッションあたりの時間あたり上限 |
| `level` | `"info"` | 転送時の重要度 |

**いつ反映されるか**は項目によって違います。

- `enabled` / `apps` / `injectConfig` — **次回起動から**。CLI は起動引数で初めて通知を出すようになるため、また監視対象かどうかは起動時に一度だけ決まるためです。
- `channels` の「空 ↔ 非空」— **次回起動から** (空なら検出器を付けないため)。非空のなかでどれを使うかは即時。
- `level` / `minIntervalMs` / `dedupeWindowMs` / `maxPerHour` — **即時**。
- `captureBell` — **オフにするのは即時、オンにするのは次回起動から** (オフのときに出力を BEL 走査しないため)。

### 通知の見え方と、なりすまし対策

通知の中身はサンドボックス内のエージェントが完全に制御できる untrusted な入力です。そのため:

- **タイトルはサーバーが組み立てます** (`<アプリ名> · <プロジェクト名>`)。エージェントが指定したタイトルは本文側へ畳み込まれるので、**別のセッションやシステム自身からの通知を騙ることはできません**。

  ただしこれは**通知ブリッジ経由の通知に限った話**です。エージェントが `notify` MCP ツールを自分で呼んだ場合、タイトルはエージェントが指定したものになります (それがツールの用途なので)。

- **発信元フッター (`_from:` / PWA の `attribution`) は「サーバーが組み立てる」が「認証済み」ではありません。**

  フッターの**組み立て**はサーバーが行い、必ず1行に収まります (値に改行を仕込んでも潰されるので、偽の行を丸ごと足すことはできません)。しかし**値そのもの**は、notify ブローカーのソケットに接続したプロセスが自己申告したものです。このソケットには現状トークン認証が無く、サンドボックス内から到達できます ([#216](https://github.com/nananek/ccserver/issues/216))。

  つまりフッターは「**どのセッションだと名乗っているか**」であって、「どのセッションか」ではありません。根本対応は #216 で追跡しています。

- 本文中の `_from:` は無害化されます。無描画の文字 (ゼロ幅スペース、異体字セレクタ等) を途中に挟んで回避しようとしても、それらごと無害化します。ただし**全角の `＿from：` やキリル文字の `о` を使った見た目の似た文字列までは潰しません** — 同形異字の網羅は原理的に不可能なので、「ccserver 自身のフッターとバイト単位で同一のものは作れない」という保証に留まります。
- **本文は必ず1行**になります。改行・`U+2028`/`U+2029`・bidi 制御・不可視文字は捕捉時に除去されるため、末尾の `_from:` フッター (ccserver が付ける発信元表示) を「別の行」として偽装できません。本文中の `_from:` も無害化されます。
- 長さはタイトル 200 / 本文 2000 文字で打ち切られます (コードポイント単位なので絵文字が壊れません)。PWA 通知のペイロードは `notify` MCP 経由のものも含めて同じ場所でサニタイズされます (制御文字・不可視文字の除去、`_from:` の無害化、長さ上限)。
- **PWA 通知の本文は改行を保持します** (通知は複数行で描画されるため)。その結果、本文が `attribution` と同じ見た目の行を含むことは防げません — `attribution` には `_from:` が付かないので、無害化の対象にもなりません。上の行が本文・下の行が `attribution` という位置関係だけが手がかりです。Discord 経路は `_from:` が実際に付くため、こちらは無害化が効きます。
- Discord へは `allowed_mentions` を空で送るため、本文に `@everyone` と書かれていてもメンションにはなりません。

### 流量の制限

1MiB の pty 出力は約 65,000 件の通知イベントになり得ます。そのまま流すと Discord webhook が 429 で止まるので、3段で抑えます (上表の `minIntervalMs` / `dedupeWindowMs` / `maxPerHour`)。

**抑制は無言では行いません。**

- 種類ごとに、窓あたり1回だけサーバーログに出ます。
- `maxPerHour` に達したときは「いつまで抑制されるか」を書いた通知が**1通だけ**配信されます。見ている当の経路で理由が分かるようにするためです。
- 設定 &gt; 通知 の下部に累計カウンタ (監視中セッション数・配信・間引き・重複・上限・到達先なし・失敗) が出ます。

### 既存の Stop フック等と併用する場合

Claude Code の `Stop` フックなどで既に通知を送っている場合、**二重配信にはなりませんが、通数は増えます**。実機で確認した時系列は次のとおりです。

```
t+8s    プロンプト送信
~t+12s  Stop フックが1回    (ターン完了)
t+71s   ブリッジが1回        (60秒アイドル後の idle_prompt)
```

同じイベントが2回来るのではなく、**「ターンが終わった」と「60秒放置されている」という別のイベントがそれぞれ1回ずつ**です。エスカレーションとしては自然ですが、通数を減らしたい場合はどちらか一方に寄せてください。

## PWA 通知 (Web Push)

タブを閉じていても端末に届く通知です。設定 &gt; 通知 の「この端末で受け取る」から購読します。

- VAPID 鍵はサーバーが**初回起動時に自動生成**して SQLite に保存するので、設定は不要です。
- 購読は端末ごとです。設定画面に購読中の端末一覧が出るので、不要になったものは削除できます。
- 配信に失敗し続けるエンドポイント (ブラウザの再インストール等) は、push サービスが 404/410 を返した時点で自動的に削除されます。
- 購読できる端末は最大 32 件です。
- 設定画面の「テスト通知を送る」は 5 秒に 1 回までです (実際に全チャネルへ配信するため)。

:::caution[前提条件]
- Push API は **secure context 必須**です。`http://localhost` は可ですが、LAN の平文 HTTP では購読できません。[Tailscale Serve で HTTPS 公開](/ccserver/deployment/tailscale/) した上でアクセスしてください。
- **iOS / iPadOS の Safari は「ホーム画面に追加」した PWA からでないと購読できません。**
- 通知の許可はユーザー操作起因でしか求められないため、必ず設定画面のボタンから購読してください。
:::

RFC 8292 の `sub` (push サービスから運用者への連絡先) は既定で ccserver のリポジトリ URL です。ccserver が利用者の連絡先を勝手に名乗るべきではないためで、必要なら環境変数 `CCSERVER_VAPID_SUBJECT` (`mailto:` または `https://`) で上書きできます。

### 前景通知との違い

設定 &gt; 一般の「デスクトップ通知を有効にする」は**別機能**です。

| | 設定 &gt; 一般の「デスクトップ通知」 | 設定 &gt; 通知の「PWA 通知」 |
|---|---|---|
| 仕組み | ブラウザの `Notification` を直接生成 | Service Worker 経由の Web Push |
| 届く条件 | そのタブが開いていて、かつ非フォーカス | タブを閉じていても届く |
| 用途 | 予約プロンプトの発火通知 | 通知ブリッジ・`notify` MCP |

## Vikunja 連携について (削除済み)

かつて `notify` は呼び出しごとに Vikunja タスクを作成/更新していましたが、**削除されました**。「人間を呼ぶ (ping)」ことと「タスクを追跡する」ことは関心事が異なり、1 つの MCP ツールに同居させたのが良くなかったためです。あらためて**独立した MCP サーバーとして再実装**する予定です。

- 追従 Issue: [#207 Vikunja 連携を ccserver-notify から切り出し、独立した MCP サーバーとして再実装する](https://github.com/nananek/ccserver/issues/207) — 削除した挙動 (タスク作成 / コメント追記 / status ラベル / Doing・To-Do バケット / `done` にはしない設計判断)、設定項目、使用していた REST エンドポイントをすべて記録してあります。
- `sandbox.config.json` に `notify.vikunja` が残っていても**エラーにはなりません**。キーは無視され、起動時に警告ログが 1 度出るだけです。`CCSERVER_VIKUNJA_*` 環境変数だけで設定していた場合 (旧ドキュメントが `apiToken` について推奨していた形) も同じ警告が出ます。不要になったら削除してください。
- 状態ファイル `.saved-vikunja-tasks.json` (env `CCSERVER_VIKUNJA_TASKS_PATH` で移動していればその場所) も誰からも読まれなくなります。Vikunja 上のタスクとの対応表が入っているだけなので、[#207](https://github.com/nananek/ccserver/issues/207) で再実装したものに引き継ぐ予定が無ければ削除して構いません。
- **Vikunja だけを配信先にしていた環境は、この削除で実配信先がゼロになります**。上の注意書きのとおり配信先ゼロだと notify MCP ごと注入されなくなるので、`notify.discordWebhook` か `notify.subscriptions` を設定してください (ブラウザへの PWA 通知 = Web Push は別途対応予定)。
