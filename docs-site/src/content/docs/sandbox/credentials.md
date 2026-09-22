---
title: 認証情報の受け渡し
description: サンドボックス内から git/ssh/gpg/gh を安全に使うための仕組みと既知の限界
---

サンドボックス内から git/gh/ssh/gpg を安全に使うための仕組みです。オン/オフは [起動ガイド](/ccserver/guides/launching/) のモーダル (ディレクトリ単位) か、[設定ファイル](/ccserver/sandbox/configuration/) の `gpg`/`sshAgent`/`gitBroker`/`commitMessageGuard` (サーバー全体の既定値、`commitMessageGuard` はディレクトリ単位の上書きなし) で制御します。

## git — HTTPS

`gitBroker` (既定 on) が有効なとき、サンドボックス内の git アクセスは**そのセッションの作業ディレクトリ自身のリモート + サブモジュール (再帰) から起動時に一度だけ算出した owner/repo にだけ**制限されます。設定不要、`~/.config/gh` や `~/.ssh` を binds に足す必要はありません (足してもブロックされ、警告が出るだけです)。

git の `credential.helper` がホスト側の git-broker プロセス (サンドボックスの外で動作、`gh auth token` を都度取得) に host+path を問い合わせ、許可されたリポジトリだけにトークンを渡します。トークン自体はサンドボックス内のファイルには一切現れません。

broker への接続はセッション毎の乱数トークン (`CCSANDBOX_GIT_BROKER_TOKEN`、env 経由) で認証されます。macOS Seatbelt では broker ソケットが `/tmp` 配下の共有ランタイム dir に置かれ、並行する他セッションからも `connect()` 可能なため、トークン無し / 不一致の要求は op 判定より前に `unauthorized` で弾かれます。**ただし macOS ではこのトークンは他の同一 UID セッションから読み取り可能です** — `pgrep` でセッションのプロセスを列挙し `KERN_PROCARGS2` で env を読む 2 手で取得できます (どちらも Seatbelt で塞げない。[sandbox/overview](/ccserver/sandbox/overview/) の「既知の限界」参照)。トークンは監査・偶発防止の層に過ぎず、実効的な境界は broker 側の**リポジトリスコープ allow-list** (盗まれたトークンでもそのセッションの cwd リポジトリ以外の資格情報は出ない) です。bwrap では従来どおりソケット自体がセッション毎マウントなので、そちらはトークンとの二重防御になります。

## git — SSH / ssh-agent 転送

`/usr/bin/ssh` と `$GIT_SSH_COMMAND` を、起動時に読み取り専用で渡された許可リスト (`gitBroker` が算出したのと同じ owner/repo) と照合するラッパーに差し替えます。許可されなければネットワークに出る前に拒否されます。

ただし認証自体 (署名) は素通しなので、SSH の git remote を使うには別途 **ssh-agent 転送**を有効にしておく必要があります。これは HTTPS git (`gitBroker` で完結) にもコミット署名 (下記 gpg の領分) にも必須ではなく、必要なのは **SSH の git remote を使う場合**と**サンドボックス内から素の `ssh` コマンドを直接叩きたい場合**だけです。有効にすると、ccserver が起動時にユーザーの agent ソケット (`/tmp/ssh-*/agent.*` 等、鍵がロードされている物を優先) を探して `SSH_AUTH_SOCK` を設定します (`env.SSH_AUTH_SOCK` で上書き可)。

転送された agent はそのセッションの間、サンドボックス内の**あらゆるプロセスから無制限に使える生の鍵アクセス**になる点に注意してください (git 用途に絞られません) — 既定オフなのはこのためです。

## gpg 署名

有効にすると、`~/.gnupg` と**ホストの生 gpg-agent / keyboxd ソケット**をサンドボックス内へ転送します。ホストの agent (鍵/トークンを保持) で署名するので、**docker 有効のままコミット署名が使えます**。ssh-agent 転送とは独立したフラグで、こちらだけ有効にしても ssh-agent は転送されません。

## GPG Vault (署名 + SSH push、パスキーログイン限定)

上記の `gpg`/`sshAgent` とは**別物**の、新しい仕組みです。`gpg`/`sshAgent` は「ホストの、すでにアンロック済みの鍵をそのまま転送する」だけですが、GPG Vaultは ccserver 自身が専用のGPG鍵ペアを生成し、**ログイン (パスキー認証) しない限り復号できない**形で暗号化して保管します。

- 鍵はサーバー側で新規生成のみ (既存鍵のインポートは非対応)。秘密鍵はネットワーク/ブラウザを一切経由しません。
- 暗号化方式は WebAuthn の PRF 拡張 (hmac-secret) のみで、フォールバックはありません。PRF対応のパスキー (Touch ID/Windows Hello の対応バージョン、対応FIDO2キー等) が最低1つ登録されている必要があります。対応状況はブラウザ/OS/認証器の組み合わせに依存し、古い環境では使えないことがあります。
- Settings > GPG連携 でボルトの作成・アンロック・ロック・追加パスキー登録・削除・GitHub登録用の公開鍵情報 (GPG公開鍵 + SSH形式公開鍵) の取得ができます。
- **ボルトにパスキーを追加するには 2 回の認証が必要です**: 1 回目は既にこのボルトを解錠できるパスキー (そのPRFが自分の鍵ラップを実際に復号できることをサーバーが確認します)、2 回目は追加したいパスキーです。サーバーがアンロック中かどうかは関係なく、ロック中でも追加できます。既にボルトに登録済みのパスキーを上書きすることはできません。
- PRF の salt はパスキーごとのランダム値で、**アンロックのたびに新しい salt へ差し替えられます** (同じ儀式で次回用の PRF 値も取得して鍵ラップを作り直します)。一度使われた PRF 出力が漏れても、次のアンロック以降は使えません。

### サンドボックスに渡るもの (セキュリティ監査 F1 対応)

サンドボックスから見えるのは、公開鍵情報 (`pubring.kbx`/`trustdb.gpg`/`gpg.conf`) と、中継 (relay) の **2 つのソケット** (`S.gpg-agent`, `S.gpg-agent.ssh`) だけです。

- `S.gpg-agent` は管理下 gpg-agent の**制限モードのソケット (extra socket)** に繋がります。制限モードでは `KEYWRAP_KEY`/`EXPORT_KEY`/`IMPORT_KEY`/`GENKEY`/`PASSWD`/`PRESET_PASSPHRASE` などが gpg-agent 自身によって拒否されるため、サンドボックス内で `gpg --export-secret-keys` を実行しても秘密鍵は一切出力されません。署名 (`git commit -S` 等) は従来どおり使えます。
- それとは独立に、中継はクライアントからのコマンドを許可リストで検査します (Assuan: 署名に必要なコマンドのみ、ssh-agent: 鍵一覧と署名のみ)。許可されていないものは gpg-agent に届く前に `Forbidden` で拒否されます。
- `S.keyboxd`/`S.dirmngr`/`S.gpg-agent.extra` は中継しません (dirmngr はホスト側からネットワークに出るため、ネットワーク隔離の迂回経路になり得ます)。
- `gpgVault` を指定していないサンドボックスからは中継ソケットに接続できません (Linux/bwrap ではそもそも見えず、macOS/Seatbelt では接続を明示的に拒否するルールが入ります)。

### 修正前に作成したボルトは無効化されます

この修正より前のバージョンでは、中継が gpg-agent の制限なしソケットに繋がっていたため、`gpgVault` を有効にしたサンドボックスから秘密鍵を丸ごと持ち出せました。**修正前に作成したボルトの鍵は漏洩した可能性があるものとして扱い、アップグレード時に自動で無効化されます** (起動時にサーバーログへ警告が出ます)。

- 無効化されたボルトはアンロック・パスキー追加ができず (API は `423 GPG_VAULT_LEGACY_DISABLED`)、`gpgVault` を指定したサンドボックスの起動もエラーになります。公開鍵情報の表示と削除だけは可能です。
- 対処手順:
  1. Settings > GPG連携 に表示される旧鍵のフィンガープリント/SSH公開鍵を確認し、GitHub の Settings > SSH and GPG keys (および各リポジトリの Deploy keys) から削除します。
  2. 「Vaultを削除」で削除します (登録済みパスキーでの本人確認を求められます)。ブラウザから操作できない場合はホストで `node server/cli/gpg-vault-reset.js --yes` を実行します (`--yes` なしだと削除対象の表示のみ)。
  3. 新しいボルトを作成し、新しい公開鍵を GitHub に登録し直します。
- **PRF儀式が必要なのは「アンロック」操作のときだけです** — 実際のコミット署名やSSH pushは、アンロック済みの管理下gpg-agentとのローカルソケット通信で完結し、ブラウザは関与しません。アンロックの持続時間は既定でログインセッションの有効期限 (30日のスライディング) に連動し、短いアイドルタイマーでは自動ロックしません (無人稼働するAIエージェントセッションを途中で壊さないため)。`sandbox.config.json` の `gpgVaultLockPolicy.idleTimeoutMinutes` で、より厳格な固定タイムアウトをオプトインできます。
- サンドボックス起動オプションの「GPG Vaultで署名・SSH pushする」(`gpgVault`) を有効にした状態でVaultがロック中/未作成だと、**起動自体が明確なエラーで拒否されます** (黙って機能なしで起動することはありません)。稼働中にVaultがロックされた場合は、そのセッション内の以降の署名/SSH pushがエラーで失敗します (フォールバックが無い設計上の割り切りです)。
- `gpg`/`sshAgent` (ホスト鍵転送) と `gpgVault` を同時に有効にすると `gpgVault` が優先されます (警告ログが出ます)。
- **署名系 (GPGコミット署名、および `gpg.format=ssh` での SSH コミット署名/`ssh-keygen -Y sign`) と SSH push は同じ鍵でもリスクが非対称です。** 署名はローカルの gpg-agent ソケット通信 (または ssh-keygen へのローカル呼び出し) だけで完結し、ネットワークに一切出ないため安全です。一方 SSH push は上記「git — SSH / ssh-agent 転送」の仕組み (`server/ws/sandbox-ssh-wrapper.cjs`) がそのまま使われており、これは `git-upload-pack`/`git-receive-pack`/`git-upload-archive` コマンドの host+path を照合する薄いラッパーに過ぎず、認証自体 (鍵の使用、かつ実際のリモートホストへのネットワーク接続) は素通しです。
- **GitHub 側にこのボルトの SSH 公開鍵を登録する際は「Signing Key」としてのみ登録し、「Authentication Key」としては登録しないでください。** GitHub の鍵登録画面 (Settings > SSH and GPG keys > New SSH key) では用途を Authentication Key / Signing Key から選べます。Signing Key はコミット/タグの SSH 署名検証にのみ使われ、push 等の認証には使われないため安全です。Authentication Key として登録すると、サンドボックス内から上記ラッパーの範囲外 (`$CCSANDBOX_REAL_SSH` の直接呼び出し、`git-upload-pack` 等以外の素の ssh 用途など) を経由してそのアカウントの全リポジトリへの書き込みアクセスに到達でき、`gitBroker` の allow-list による制限が実質的に無意味になります。
- **Deploy Key での代替も不可です。** GPG ボルトは 1 インスタンスにつき鍵ペアを 1 つしか生成しない設計 (`server/gpgVaultDb.js` の `gpg_vault` テーブルは固定 ID の 1 行のみ許可するシングルトン) のため、複数リポジトリを扱う運用では、同じ公開鍵を複数リポジトリの Deploy Key として登録することになりますが、GitHub は同一公開鍵の複数リポジトリへの Deploy Key 登録を許可していません。結論として、この鍵は SSH push には使わず (git remote は HTTPS + `gitBroker` 経由に限定する)、コミット署名専用として扱ってください。

## gh CLI

`gitBroker` が有効なとき、サンドボックス内の `gh` は素通しではなく、同じ git-broker プロセスへの中継に差し替わります。gh の API 呼び出しは TLS で `api.github.com` に直結するため通信内容を見て絞ることはできませんが、代わりに**決め打ちの安全なサブコマンドだけをブローカーが実 `gh` (ホスト側、実際の認証情報付き) で代行実行**し、対象リポジトリを git と同じ許可リストと照合します。トークンやCookieがサンドボックス内に渡ることはありません。

- 許可: `pr` (create/view/list/edit/comment/merge/close/reopen/ready/review/checks/diff/status/checkout)、`issue` (create/view/list/edit/comment/close/reopen/status)、`release` (create/view/list/edit/delete/upload/download/delete-asset)、`workflow` (view/list はcwdフォールバック可、`run`/`enable`/`disable` は `--repo`/`-R` の明示が必須 — 下記)、`run` (list/view/watch)、`repo view`、`gh api` は **`repos/OWNER/REPO/actions/...` への読み取り専用 GET のみ**。エンドポイントの owner/repo は**リテラル記述が必須**で、`{owner}`/`{repo}` プレースホルダ形式は受け付けません (gh がプレースホルダを独自の基準リポジトリ解決 (cwd origin / `GH_REPO` / `--repo`) から埋め、常に既定の API ホストへ投げるため、ブローカーが照合したリポジトリと実際の要求先が食い違う可能性がある)。
- `workflow run`/`enable`/`disable` はトリガー/書き込み系 (CI 起動、workflow 自体の on/off) のため、**`--repo`/`-R` の明示が必須**で、作業ディレクトリの origin への暗黙フォールバックは行いません。この制限は `run`/`enable`/`disable` のみに適用され、以前は `--repo` 無しでもそのまま通っていた挙動を狭める破壊的変更です (それ以外の読み取り系サブコマンドは従来通り cwd フォールバック可)。
- 対象リポジトリは `--repo`/`-R` フラグ (`OWNER/REPO`, `HOST/OWNER/REPO`, URL) があればそれを、無ければ作業ディレクトリの origin リモートを使い、いずれも許可リストと照合されます (`--repo` で許可リスト外のリポジトリを指定しても拒否されます)。
- `pr view`/`checkout`/`diff`/`merge`/`close`/`edit` 等は `<number>|<url>|<branch>` を、`repo view` は裸の `OWNER/REPO` も受け付けます。**PR/issue の URL をそのまま位置引数に渡した場合、そのURLが指すリポジトリも許可リストと照合されます** (`--repo`/cwd の判定をすり抜けて無関係なリポジトリを操作させることはできません)。
- **バンドルされた短縮フラグ (`-wR owner/repo` のような1トークンへの複数フラグの結合) は拒否されます**: gh (pflag/Cobra) はこの形を `-w -R owner/repo` と等価に解釈しますが、ブローカー側でこれを正しく再現するのは複雑で壊れやすいため、`-R` 単体または `-Rvalue` (値を直接くっつける形) 以外の複数文字の短縮フラグはまとめて拒否します。個別のフラグ (`-w` 単体等) はそのまま使えます。
- 拒否: `gh api` の Actions 以外のエンドポイント (`graphql`、`/user`、`/orgs/...`、`repos/.../actions` 以外の `repos/...` 系、絶対URL、`{owner}`/`{repo}` プレースホルダ形式、POST 等の書き込み系 — Actions 配下でも `--method` は GET のみ、データ系フラグ `-f`/`--raw-field`/`--field`/`--input`、`--hostname`、短縮フラグは全面的に拒否)、`gh auth`/`gh secret`/`gh variable`/`gh ssh-key`/`gh gpg-key` (認証情報自体の管理)、`gh repo clone`/`fork`/`create`/`delete`/`rename` (対象リポジトリが位置引数で来るため個別のパース対応が必要で未対応)、`gh run rerun`/`cancel`/`delete`/`download` (トリガー/書き込み系) など、上記に無いものは全て拒否されます。
- ブローカー越しの実行はホスト側で TTY なしの子プロセスとして動くため、**非対話的な呼び出し (必要な入力は全てフラグ/stdin で渡す) のみ**サポートします。エディタが開く対話フロー (`gh pr create` をフラグなしで叩く等) は動作しません。
- **`commitMessageGuard` (既定 on) が有効なとき、`pr create`/`edit`/`comment`/`review` の title/body/body-file もコミットメッセージガードと同じ禁止パターンでチェックされます**(plan8)。`git commit` はローカルの `commit-msg` フックで守られますが、`gh pr create --body "..."` はそのフックを一切通らないため、素通しのままだと `Claude-Session:` 行やセッションURLが PR 説明文に混入できてしまいます。ブローカーは許可リスト判定が通った直後にこのチェックを行い、一致すれば実 `gh` を起動する前に拒否します (`--body`/`--title` の直接指定、`--body-file -` 経由の標準入力、`--body-file <path>` 経由のファイル内容のいずれも対象。ファイル内容はセッションの作業ディレクトリ基準で読みます)。対象は `pr` の title/body 系フラグのみで、`issue`/`release` 等の本文フラグは対象外です。ファイルが読めない等の異常系は該当フィールドをスキップするだけで fail-open します(コミットメッセージガードと同じ方針)。`commitMessageGuard.enabled: false` にすると gh 側のこのチェックも無効になります。

`gitBroker: false` で git 側のゲート・gh ブローカーの両方を無効化できます (git は使えますが ssh-agent が有効なら無制限に、gh はそのまま実行されますが `~/.config/gh` が無いため無認証で失敗します)。**`gitBroker: false` にすると gh が一切ブローカーを経由しなくなるため、上記の PR 本文チェックも効きません。**

## コミットメッセージガード

`commitMessageGuard` (既定 on) が有効なとき、サンドボックス内の `git commit` は git の `commit-msg` フックとして注入されたスクリプトを通り、メッセージが禁止パターンに一致すると拒否されます (作業ツリー・インデックスは無傷、コミットオブジェクトは作られません)。`-m`/`-F`/エディタ/テンプレート/`--amend` のどの方法でメッセージが組み立てられたかに関わらず、確定した完全なメッセージを検査します。

`gitBroker` とは完全に独立したフラグです。こちらは「ローカルのコミット内容に何が記録されるか」の話であり、`gitBroker` が担う「ネットワーク越しの認証情報スコープ」とは別軸のため、`gitBroker: false` にしていてもこのガードは有効なままです。

組み込みで常時ブロックされるパターン (設定不要):

- `Claude-Session:` で始まる行
- `https://claude.ai/code/session_` を含む裸のURL

どちらも、そのコミットを生成した会話セッションへの生きたアクセスをそのまま履歴に残してしまうため、常時ブロックの対象です。一方 `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` のような attribution 行はブロック対象に含めていません (多くのワークフローで意図的に残したい行のため)。ブロックしたい場合は設定ファイルの `commitMessageGuard.blockedPatterns` に正規表現文字列を追加してください (例: `"Co-Authored-By:.*noreply@anthropic\\.com"`)。不正な正規表現は警告ログを出して無視されるだけで、他のコミットを止めません (設定ミス1件でセッション全体のコミットが止まる可用性障害の方が実害が大きいため)。

設定・config読み込みに何らかの問題があった場合 (フックへの設定ファイルが読めない、壊れている等) は **fail-open** (コミットを通す) します。これは事故防止のための補助機構であり、可用性を犠牲にしてまで守る機能ではないためです。

## エージェント CLI のログイン (macOS Seatbelt)

Linux (bwrap) では `$HOME` がホストのパスのまま保たれ `~/.claude` などが rw
バインドされるので、エージェント CLI のログインはそのまま引き継がれます。

macOS (Seatbelt) では `$HOME` がサンドボックス側ホームに差し替わるうえ、
**macOS のログインキーチェーンにはこのプロファイルから一切アクセスできません**
(`~/Library/Keychains` は allow リストに無く、`security` は
`errSecNoDefaultKeychain` や認可拒否を返します)。Claude Code は macOS では
通常このキーチェーンに OAuth トークンを保存するため、対策が無いとサンドボックス
起動のたびに再ログインが必要になります。

ccserver はこれを次の方法で回避します:

- `~/.claude` / `~/.codex` を起動時に自動作成し、`CLAUDE_CONFIG_DIR` /
  `CLAUDE_SECURESTORAGE_CONFIG_DIR` / `CODEX_HOME` を常にそこへ向ける
  (プロファイルはこれらのツリーを read+write で allow-list 済み)。
- Claude Code は macOS でもキーチェーンが使えないと平文ファイル
  `~/.claude/.credentials.json` (`0600`) にフォールバックするので、サンドボックス
  内でのログインとトークンのリフレッシュはこのファイルに永続します。
- **初回起動時 (`.credentials.json` がまだ無いとき) だけ**、ccserver
  (サンドボックス外) がホストのログインキーチェーンから一度読み取り
  (`security find-generic-password -s "Claude Code-credentials"`)、その内容を
  `~/.claude/.credentials.json` に書き出します。ホストで既に Claude Code に
  ログイン済みなら再ログイン不要で引き継がれます。
  - ccserver はこのアイテムを作成したアプリではないため、初回は macOS が
    「ccserver がキーチェーンにアクセスしようとしています」の GUI 許可
    ダイアログを出す場合があります (「常に許可」で以後抑制)。
  - 非対話環境などで読み取りに失敗しても致命的ではありません。サンドボックス内で
    一度ログインすれば、以降は `.credentials.json` が永続します。
  - 既存の `.credentials.json` は**上書きしません** (Claude 自身がその
    ファイル上でトークンをリフレッシュ管理します)。

注意点:

- OAuth トークンが平文でディスクに載ります (Linux/bwrap や、キーチェーンが
  使えない環境での Claude Code 自身のフォールバックと同じ挙動)。
- サンドボックス内でトークンがリフレッシュされると、ホストのキーチェーン側の
  トークンは古くなり得ます。ホストで直接 `claude` を使うと再ログインが必要に
  なる場合があります。
- codex はキーチェーンを使わず `~/.codex/auth.json` (平文) に保存するため、
  `CODEX_HOME` とディレクトリ自動作成だけで引き継がれます (キーチェーン種取りは
  Claude Code のみ)。
- copilot / commandcode は `$HOME` 依存で env 上書きが無いため、Seatbelt では
  引き続き引き継がれません (上記 overview 参照)。

## 既知の限界

これは「侵害/暴走したプロセスが無関係なリポジトリの認証情報を安易に使ってしまう」事故を防ぐ多層防御であり、意図的にバイパスを試みるコードへの完全な防壁ではありません。以下は主に ssh-agent 転送が有効なときに関係します (既定オフなら SSH 経由の抜け道はそもそも存在しません)。

- 転送された ssh-agent ソケットに対し `ssh` バイナリを経由せず直接 ssh-agent プロトコルを話すコードは、宛先チェックをすり抜けて任意ホスト向けの署名を依頼できます。
- **`docker: true` (既定) と ssh-agent 転送を併用する場合、上記よりずっと簡単な迂回経路があります**: サンドボックス内から `docker run` されたコンテナはサンドボックス自身の `/usr/bin/ssh`・`gh` 差し替えを引き継がず、独自のイメージ内の素の `ssh`/`gh` を使えます。転送された `SSH_AUTH_SOCK` は固定の既知パスにバインドされているため、コンテナ側に `-v` でそのソケットを渡すだけで、ラッパーを一切経由しない無制限の ssh-agent アクセスになります。つまり **docker + ssh-agent 転送有効時は gitBroker のリポジトリ制限を強い境界として当てにしないでください**。厳密なスコープが必要なセッションでは ssh-agent 転送を無効 (既定) のままにするか `docker: false` にするか、サンドボックス起動時にコンソールへ出る警告を確認してください。
- サブモジュールの URL は、実際にチェックアウト済み (作業ディレクトリが存在する) のものだけを許可リストに加えます。`.gitmodules` はリポジトリのコンテンツそのものであり信頼できないため、宣言されているだけで未チェックアウトの「サブモジュール」は無視されます (信頼できないリポジトリがでっち上げの URL を許可リストへ紛れ込ませるのを防ぐため)。
- 許可リストはセッション起動時に一度だけ算出するため、セッション中に追加/チェックアウトしたサブモジュールや変更した gh の許可サブコマンドは次回起動まで反映されません。
- **コミットメッセージガードも同じ多層防御であり、意図的な迂回への完全な防壁ではありません**: `git commit --no-verify` でフック自体をスキップできますし、ローカルリポジトリに `git config core.hooksPath <空ディレクトリ>` を設定する、あるいは `GIT_CONFIG_COUNT` 系の環境変数自体を unset/上書きすることでも経路そのものを迂回できます (git の config はどの層で設定しても最終的に呼び出し元プロセスの自由であり、OS レベルの強制ではありません)。この機能は「セッションURLをコミットメッセージに入れろ、といった外部からの指示に無批判に従ってしまう」典型的な事故を防ぐためのものです。
- **gh PR本文ガード (plan8) の対象は `pr create`/`edit`/`comment`/`review` の title/body/body-file のみです**。同種の本文フラグを持つ `gh issue create`/`edit`/`comment` 等は対象外で、そのまま通ります。また `gh` 自体の許可判定 (`ghAllowlist.js`) は位置引数中のURL形トークンを全てリポジトリ参照とみなして解決しようとするため、たまたま `--title`/`--body` の値そのものが1トークン丸ごとURLになっている場合、本ガードに一致するより先に (無関係の) `repo-unresolved`/`not-allowlisted` で拒否されることがあります(本文の一部としてURLが埋め込まれている通常のケースでは発生しません)。
- **ネットワーク隔離 (network-broker.js) の seatbelt (macOS) 側は、bwrap のようなカーネルレベルの境界ではなく defense-in-depth です**: 同一UIDの別プロセスから `KERN_PROCARGS2` 経由でセッションの環境変数を読み取れてしまう既知の制限 (上記) により、ブローカーのトークンも同様に読み取り可能です。トークン自体は許可リストで用途がスコープされているため無制限のネットワーク到達性にはなりませんが、bwrap (Linux) の in-netns ファイアウォールほどの強い保証はありません。bwrap 側はカーネルレベルで境界が構造化されているため、この限界は適用されません。
