---
title: 認証情報の受け渡し
description: サンドボックス内から git/ssh/gpg/gh を安全に使うための仕組みと既知の限界
---

サンドボックス内から git/gh/ssh/gpg を安全に使うための仕組みです。オン/オフは [起動ガイド](/ccserver/guides/launching/) のモーダル (ディレクトリ単位) か、[設定ファイル](/ccserver/sandbox/configuration/) の `gpg`/`sshAgent`/`gitBroker` (サーバー全体の既定値) で制御します。

## git — HTTPS

`gitBroker` (既定 on) が有効なとき、サンドボックス内の git アクセスは**そのセッションの作業ディレクトリ自身のリモート + サブモジュール (再帰) から起動時に一度だけ算出した owner/repo にだけ**制限されます。設定不要、`~/.config/gh` や `~/.ssh` を binds に足す必要はありません (足してもブロックされ、警告が出るだけです)。

git の `credential.helper` がホスト側の git-broker プロセス (サンドボックスの外で動作、`gh auth token` を都度取得) に host+path を問い合わせ、許可されたリポジトリだけにトークンを渡します。トークン自体はサンドボックス内のファイルには一切現れません。

## git — SSH / ssh-agent 転送

`/usr/bin/ssh` と `$GIT_SSH_COMMAND` を、起動時に読み取り専用で渡された許可リスト (`gitBroker` が算出したのと同じ owner/repo) と照合するラッパーに差し替えます。許可されなければネットワークに出る前に拒否されます。

ただし認証自体 (署名) は素通しなので、SSH の git remote を使うには別途 **ssh-agent 転送**を有効にしておく必要があります。これは HTTPS git (`gitBroker` で完結) にもコミット署名 (下記 gpg の領分) にも必須ではなく、必要なのは **SSH の git remote を使う場合**と**サンドボックス内から素の `ssh` コマンドを直接叩きたい場合**だけです。有効にすると、ccserver が起動時にユーザーの agent ソケット (`/tmp/ssh-*/agent.*` 等、鍵がロードされている物を優先) を探して `SSH_AUTH_SOCK` を設定します (`env.SSH_AUTH_SOCK` で上書き可)。

転送された agent はそのセッションの間、サンドボックス内の**あらゆるプロセスから無制限に使える生の鍵アクセス**になる点に注意してください (git 用途に絞られません) — 既定オフなのはこのためです。

## gpg 署名

有効にすると、`~/.gnupg` と**ホストの生 gpg-agent / keyboxd ソケット**をサンドボックス内へ転送します。ホストの agent (鍵/トークンを保持) で署名するので、**docker 有効のままコミット署名が使えます**。ssh-agent 転送とは独立したフラグで、こちらだけ有効にしても ssh-agent は転送されません。

## gh CLI

`gitBroker` が有効なとき、サンドボックス内の `gh` は素通しではなく、同じ git-broker プロセスへの中継に差し替わります。gh の API 呼び出しは TLS で `api.github.com` に直結するため通信内容を見て絞ることはできませんが、代わりに**決め打ちの安全なサブコマンドだけをブローカーが実 `gh` (ホスト側、実際の認証情報付き) で代行実行**し、対象リポジトリを git と同じ許可リストと照合します。トークンやCookieがサンドボックス内に渡ることはありません。

- 許可: `pr` (create/view/list/edit/comment/merge/close/reopen/ready/review/checks/diff/status/checkout)、`issue` (create/view/list/edit/comment/close/reopen/status)、`release` (create/view/list/edit/delete/upload/download/delete-asset)、`workflow` (view/list はcwdフォールバック可、`run`/`enable`/`disable` は `--repo`/`-R` の明示が必須 — 下記)、`run` (list/view/watch)、`repo view`、`gh api` は **`repos/OWNER/REPO/actions/...` への読み取り専用 GET のみ**。エンドポイントの owner/repo は**リテラル記述が必須**で、`{owner}`/`{repo}` プレースホルダ形式は受け付けません (gh がプレースホルダを独自の基準リポジトリ解決 (cwd origin / `GH_REPO` / `--repo`) から埋め、常に既定の API ホストへ投げるため、ブローカーが照合したリポジトリと実際の要求先が食い違う可能性がある)。
- `workflow run`/`enable`/`disable` はトリガー/書き込み系 (CI 起動、workflow 自体の on/off) のため、**`--repo`/`-R` の明示が必須**で、作業ディレクトリの origin への暗黙フォールバックは行いません。この制限は `run`/`enable`/`disable` のみに適用され、以前は `--repo` 無しでもそのまま通っていた挙動を狭める破壊的変更です (それ以外の読み取り系サブコマンドは従来通り cwd フォールバック可)。
- 対象リポジトリは `--repo`/`-R` フラグ (`OWNER/REPO`, `HOST/OWNER/REPO`, URL) があればそれを、無ければ作業ディレクトリの origin リモートを使い、いずれも許可リストと照合されます (`--repo` で許可リスト外のリポジトリを指定しても拒否されます)。
- `pr view`/`checkout`/`diff`/`merge`/`close`/`edit` 等は `<number>|<url>|<branch>` を、`repo view` は裸の `OWNER/REPO` も受け付けます。**PR/issue の URL をそのまま位置引数に渡した場合、そのURLが指すリポジトリも許可リストと照合されます** (`--repo`/cwd の判定をすり抜けて無関係なリポジトリを操作させることはできません)。
- **バンドルされた短縮フラグ (`-wR owner/repo` のような1トークンへの複数フラグの結合) は拒否されます**: gh (pflag/Cobra) はこの形を `-w -R owner/repo` と等価に解釈しますが、ブローカー側でこれを正しく再現するのは複雑で壊れやすいため、`-R` 単体または `-Rvalue` (値を直接くっつける形) 以外の複数文字の短縮フラグはまとめて拒否します。個別のフラグ (`-w` 単体等) はそのまま使えます。
- 拒否: `gh api` の Actions 以外のエンドポイント (`graphql`、`/user`、`/orgs/...`、`repos/.../actions` 以外の `repos/...` 系、絶対URL、`{owner}`/`{repo}` プレースホルダ形式、POST 等の書き込み系 — Actions 配下でも `--method` は GET のみ、データ系フラグ `-f`/`--raw-field`/`--field`/`--input`、`--hostname`、短縮フラグは全面的に拒否)、`gh auth`/`gh secret`/`gh variable`/`gh ssh-key`/`gh gpg-key` (認証情報自体の管理)、`gh repo clone`/`fork`/`create`/`delete`/`rename` (対象リポジトリが位置引数で来るため個別のパース対応が必要で未対応)、`gh run rerun`/`cancel`/`delete`/`download` (トリガー/書き込み系) など、上記に無いものは全て拒否されます。
- ブローカー越しの実行はホスト側で TTY なしの子プロセスとして動くため、**非対話的な呼び出し (必要な入力は全てフラグ/stdin で渡す) のみ**サポートします。エディタが開く対話フロー (`gh pr create` をフラグなしで叩く等) は動作しません。

`gitBroker: false` で git 側のゲート・gh ブローカーの両方を無効化できます (git は使えますが ssh-agent が有効なら無制限に、gh はそのまま実行されますが `~/.config/gh` が無いため無認証で失敗します)。

## 既知の限界

これは「侵害/暴走したプロセスが無関係なリポジトリの認証情報を安易に使ってしまう」事故を防ぐ多層防御であり、意図的にバイパスを試みるコードへの完全な防壁ではありません。以下は主に ssh-agent 転送が有効なときに関係します (既定オフなら SSH 経由の抜け道はそもそも存在しません)。

- 転送された ssh-agent ソケットに対し `ssh` バイナリを経由せず直接 ssh-agent プロトコルを話すコードは、宛先チェックをすり抜けて任意ホスト向けの署名を依頼できます。
- **`docker: true` (既定) と ssh-agent 転送を併用する場合、上記よりずっと簡単な迂回経路があります**: サンドボックス内から `docker run` されたコンテナはサンドボックス自身の `/usr/bin/ssh`・`gh` 差し替えを引き継がず、独自のイメージ内の素の `ssh`/`gh` を使えます。転送された `SSH_AUTH_SOCK` は固定の既知パスにバインドされているため、コンテナ側に `-v` でそのソケットを渡すだけで、ラッパーを一切経由しない無制限の ssh-agent アクセスになります。つまり **docker + ssh-agent 転送有効時は gitBroker のリポジトリ制限を強い境界として当てにしないでください**。厳密なスコープが必要なセッションでは ssh-agent 転送を無効 (既定) のままにするか `docker: false` にするか、サンドボックス起動時にコンソールへ出る警告を確認してください。
- サブモジュールの URL は、実際にチェックアウト済み (作業ディレクトリが存在する) のものだけを許可リストに加えます。`.gitmodules` はリポジトリのコンテンツそのものであり信頼できないため、宣言されているだけで未チェックアウトの「サブモジュール」は無視されます (信頼できないリポジトリがでっち上げの URL を許可リストへ紛れ込ませるのを防ぐため)。
- 許可リストはセッション起動時に一度だけ算出するため、セッション中に追加/チェックアウトしたサブモジュールや変更した gh の許可サブコマンドは次回起動まで反映されません。
