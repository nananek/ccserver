// ccserver setup / migration wizard (issue #201 Step7). The ONLY thing that
// ever moves files between the pre-#201 layout and the XDG one, and the only
// thing that writes the layout marker. Nothing relocates itself at boot.
//
// Usage: node server/cli/setup.js [--yes] [--move-large] [--seed-example]
//                                 [--force] [--json] [--help]
//        (or: npm run setup [-- --yes])
//
// Dry run by default -- the contract gpg-vault-reset.js established and
// cli.test.js already pins: print exactly what would happen, change nothing,
// make the operator re-run with --yes. No interactive prompt, deliberately:
// this gets run over ssh and from systemd units where there is no TTY, and
// node:readline's behavior on a detached stdin varies between "resolves
// instantly" and "hangs forever". Neither is acceptable for an irreversible
// operation. --yes also survives in shell history, where an interactive "y"
// does not.
//
// This wizard NEVER OPENS THE DATABASE. Opening it at the old path would
// create -wal/-shm sidecars moments before the move.

import { connect } from 'node:net';
import { existsSync, mkdirSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  allPaths, configRoot, dataRoot, stateRoot, layoutMarkerPath, readLayout,
  layoutVersion, resetLayoutCache, repoRoot, CURRENT_LAYOUT_VERSION,
} from '../paths.js';
import {
  planMigration, applyMigration, ensureRoots, findLeftovers, writeBreadcrumbs,
  writeFileNoFollow, STICKY_REASON,
} from '../pathMigration.js';

const KNOWN_FLAGS = new Set(['--yes', '--move-large', '--seed-example', '--force', '--json', '--help']);
const args = process.argv.slice(2);
const unknown = args.filter((a) => !KNOWN_FLAGS.has(a));
if (unknown.length > 0) {
  console.error(`不明な引数: ${unknown.join(' ')}`);
  console.error(usage());
  process.exit(2);
}
if (args.includes('--help')) {
  console.log(usage());
  process.exit(0);
}

const apply = args.includes('--yes');
const moveLarge = args.includes('--move-large');
const seedExample = args.includes('--seed-example');
const force = args.includes('--force');
const asJson = args.includes('--json');

// --move-large promotes the sticky trees into ordinary move steps.
const entries = allPaths().map((e) => (moveLarge ? { ...e, stickyLegacy: false } : e));
const plan = planMigration({ entries });
const leftovers = findLeftovers({ entries });
const alreadyMigrated = layoutVersion() >= CURRENT_LAYOUT_VERSION;
const running = apply && !force ? await serverSeemsRunning() : false;

if (asJson) {
  console.log(JSON.stringify({
    layoutVersion: layoutVersion(),
    targetLayoutVersion: CURRENT_LAYOUT_VERSION,
    roots: { config: configRoot(), data: dataRoot(), state: stateRoot() },
    ...plan,
    leftovers,
    // --json is always a dry run, even with --yes: a machine reading this
    // must not conclude the migration happened (F8). Applying and emitting
    // JSON at the same time would also mean the plan printed is not the plan
    // executed if anything failed partway.
    willApply: false,
    dryRun: true,
    note: apply ? '--json は常にドライランです。適用するには --json を外して実行してください。' : undefined,
  }, null, 2));
  process.exit(0);
}

printHeader();
printCurrentLayout();

// The plan is printed in EVERY mode, an already-migrated host included.
// Skipping it there made the dry run LIE: a v2 host with a legacy file left
// behind -- a rolled-back run, or an older branch booted once and
// re-created <repo>/.saved-groups.json -- printed "移行するものはありません"
// and then `--yes` went ahead and moved it. A dry run whose output does not
// predict what --yes does is worse than having no dry run at all. It is also
// the only place a both-present warning can reach the operator on a host
// that is already at v2.
printPlan();
printLeftovers();

if (running) {
  console.error(`ccserver (:${port()}) が応答しています。移行前に停止してください:`);
  printServiceHint('stop');
  console.error('  (停止せずに実行するには --force)');
  process.exit(1);
}

if (!apply) {
  console.log('これはドライランです。実行するには --yes を付けて再実行してください。');
  process.exit(0);
}

// --- apply ------------------------------------------------------------------

let applied;
try {
  ensureRoots();
  applied = applyMigration(plan);
} catch (err) {
  console.error('');
  console.error(err.message);
  console.error('原因を解消してから再実行してください。');
  process.exit(1);
}

// The marker is part of the migration, not a postscript (attack-test-201 F3).
// Until it is written the server still resolves the OLD paths -- which, after
// a successful applyMigration, are empty. A failure here (EISDIR on a
// layout.json someone turned into a directory, EACCES, ENOSPC) used to leave
// every file moved and the layout still v1, so ccserver booted as though it
// had lost its DB, federation identity and every group. Rolling the moves
// back returns the host to a state it can actually boot in.
let breadcrumbs = [];
try {
  seedSandboxConfig();
  if (plan.steps.length > 0) breadcrumbs = writeBreadcrumbs();
  writeMarker();
} catch (err) {
  applied.rollback();
  // The breadcrumbs say "these files moved to the XDG layout". After a
  // rollback they did not, so leaving them would send the next person
  // looking in the wrong place.
  for (const path of breadcrumbs) {
    try { rmSync(path, { force: true }); } catch { /* best effort */ }
  }
  console.error('');
  console.error(`セットアップの記録に失敗したため、移動を元に戻しました: ${err.message}`);
  console.error(`レイアウトは v${layoutVersion()} のままです。原因を解消してから再実行してください。`);
  process.exit(1);
}
resetLayoutCache();

// An explicit record of what actually moved, in the same output as the
// plan above. `--yes` is irreversible and runs unattended (ssh, systemd), so
// when something later looks wrong the operator's scrollback -- or the
// journal -- has to be able to answer "where did this file go?" without
// re-deriving it from the registry.
if (plan.steps.length > 0) {
  console.log('');
  console.log(`移動しました (${plan.steps.length}件):`);
  for (const step of plan.steps) {
    const extra = step.items.length > 1
      ? ` (+ ${step.items.slice(1).map((i) => i.to.slice(step.to.length)).join(', ')})`
      : '';
    console.log(`  [${step.kind}] ${step.label}${extra}`);
    console.log(`        ${step.from}`);
    console.log(`     -> ${step.to}`);
  }
}
if (plan.kept.length > 0) {
  console.log('');
  console.log(`その場に残しました (${plan.kept.length}件):`);
  for (const k of plan.kept) console.log(`  ${k.label.padEnd(28)} ${k.at}`);
}
// Repeated here on purpose, after the move list rather than only before it.
// A both-present entry is the one thing this run did NOT resolve, and on a
// host with a dozen moves the pre-flight copy has scrolled away by the time
// the operator reads the result. It is deliberately not a blocker (rev2
// §3-A: making it one leaves the operator with no way to ever finish), so
// being impossible to miss is the whole of its enforcement.
printWarnings('警告 -- 以下は移行していません');

console.log('');
if (plan.steps.length === 0 && plan.kept.length === 0 && plan.skips.every((s) => s.reason !== 'nothing-to-move')) {
  console.log('すべてのパスが env var で明示されています。マーカーのみ書き込みました。');
} else {
  console.log(`移行が完了しました。レイアウト v${CURRENT_LAYOUT_VERSION} を ${layoutMarkerPath()} に記録しました。`);
}
console.log('');
console.log('⚠ 移行後は必ず本機能を含むブランチのコードで起動してください。');
console.log('  古いブランチのコードは旧パスを参照するため、空の状態で起動します。');
console.log('');
printServiceHint('start');
// Said here because this is the moment an operator most needs to know it
// exists: right after an irreversible-looking one-way move, before anything
// has gone wrong. Hunting for it later means reading paths.js.
console.log('');
console.log('元に戻す手順 (移行を取り消す) は docs の「設定モデル」→「移行を取り消す」にあります:');
console.log(`  ${layoutMarkerPath()} を消すと旧レイアウトに戻りますが、`);
console.log('  ファイルを旧位置へ戻す作業が別途必要です。手順は上記ドキュメントを参照してください。');
process.exit(0);

// How to stop/start ccserver. Deliberately not a single systemd command.
//
// The setup gate (issue #201 Step5) means EVERY host now has to run this
// wizard, macOS included, and ccserver runs there under launchd, in a tmux
// pane, or straight from a shell -- `systemctl --user` exists on none of
// them. Printing only that left the operator of the most dangerous command in
// this tool reading an instruction that does not apply to their machine.
//
// systemd is still named first because docs/ccserver.service is what the
// deployment docs set up, and it is the case where a stale unit will restart
// the server underneath a migration. The point is to say what has to be true
// -- the server must not be running -- rather than to guess how.
function printServiceHint(action) {
  const out = action === 'stop' ? console.error : console.log;
  if (action === 'stop') {
    out(`  systemd:          systemctl --user stop ccserver`);
    out(`  launchd (macOS):  launchctl unload ~/Library/LaunchAgents/<ccserver の plist>`);
    out('  tmux / 手動起動:   そのプロセスで Ctrl-C');
    out(`  分からない場合:    lsof -nP -iTCP:${port()} -sTCP:LISTEN  で PID を調べて kill`);
  } else {
    out(`  systemd:          systemctl --user start ccserver`);
    out(`  launchd (macOS):  launchctl load ~/Library/LaunchAgents/<ccserver の plist>`);
    out('  tmux / 手動起動:   NODE_ENV=production node server/index.js');
  }
}

// --- marker + config seeding ------------------------------------------------

function writeMarker() {
  const previous = readLayout();
  const marker = {
    layoutVersion: CURRENT_LAYOUT_VERSION,
    // Re-running the wizard must not rewrite the original completion time.
    completedAt: previous?.completedAt ?? Date.now(),
    updatedAt: Date.now(),
    completedBy: 'server/cli/setup.js',
    migrated: dedupe([...(previous?.migrated || []), ...plan.steps.map((s) => s.id)]),
    // kept[] is what resolvePath() consults for the sticky trees, so it is
    // authoritative state, not a log: it must reflect THIS run exactly.
    kept: plan.kept.map(({ id, at, reason }) => ({ id, at, reason })),
    skipped: plan.skips
      .filter((s) => s.reason === 'env-override')
      .map(({ id, reason, detail }) => ({ id, reason, detail })),
    leftovers: [...plan.warnings.map((w) => ({ id: w.id, path: w.path })),
      ...leftovers.map((l) => ({ id: l.id, path: l.path }))],
  };
  mkdirSync(dirname(layoutMarkerPath()), { recursive: true, mode: 0o700 });
  // Never written through a symlink (F5) -- see writeFileNoFollow.
  //
  // 0644 rather than 0600, deliberately. Everything the object above can
  // hold is non-secret and checked field by field: an integer version, two
  // millisecond timestamps, a fixed literal, registry ids, filesystem paths,
  // and `detail` -- which is `${envVar}=${entry.path}`, an env var NAME and a
  // path, never its contents. Nothing here is read from a file's body, from
  // the DB, or from a request, so no secret has a route in. And the file sits
  // inside configRoot(), which ensureRoots() creates 0700, so the mode on the
  // file is not what decides who can read it anyway. Readable is useful: an
  // operator debugging "where did my DB go" cats this, and so does a
  // deployment script.
  writeFileNoFollow(layoutMarkerPath(), `${JSON.stringify(marker, null, 2)}\n`, 0o644);
}

// A fresh sandbox.config.json is a POINTER, not a copy of the example.
//
// server/sandbox.config.example.json sets "gpg": true, and sandbox.js reads
// it as `raw.gpg === true` -- i.e. false when the file is absent. Copying
// the example verbatim would therefore silently switch ON forwarding of the
// host's gpg-agent and ~/.gnupg into every sandbox, as a side effect of
// running a migration wizard. That is a security boundary moving without
// anyone asking. (docker is `!== false` so it stays on either way;
// gpgVault/forceSandbox/allowUnsandboxedAgents are false in the example too.
// gpg is the only one that actually flips -- and one is enough.)
//
// --seed-example is there for anyone who does want the whole annotated file.
function seedSandboxConfig() {
  const entry = allPaths().find((e) => e.id === 'sandboxConfig');
  // entry.target, never entry.path: the marker has not been written yet at
  // this point, so entry.path still resolves to the LEGACY in-tree location
  // and seeding there would write a config file into the install tree --
  // precisely the thing issue #201 exists to stop.
  const to = entry.target;
  if (entry.overridden || existsSync(to)) return;
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
  if (seedExample) {
    writeFileNoFollow(to, readFileSync(exampleConfigPath(), 'utf-8'), 0o600);
  } else {
    writeFileNoFollow(to, `${JSON.stringify({
      '//': 'ccserver の静的設定。全キーと既定値は ccserver checkout の '
        + 'server/sandbox.config.example.json を参照。ここの変更には ccserver の再起動が必要です。'
        + 'Web UI から変更できる設定は SQLite の settings テーブルにあります。',
    }, null, 2)}\n`);
  }
  try { chmodSync(to, 0o600); } catch { /* best effort */ }
}

function exampleConfigPath() {
  return `${repoRoot()}/server/sandbox.config.example.json`;
}

// --- printing ---------------------------------------------------------------

function printHeader() {
  if (alreadyMigrated) {
    console.log('ccserver セットアップウィザード');
  } else {
    console.log(`ccserver セットアップウィザード (レイアウト v${layoutVersion()} -> v${CURRENT_LAYOUT_VERSION})`);
  }
  console.log('');
}

function printRoots(indent = '  ') {
  console.log(`${indent}設定 (config): ${configRoot()}`);
  console.log(`${indent}データ (data): ${dataRoot()}`);
  console.log(`${indent}状態 (state):  ${stateRoot()}`);
}

function printCurrentLayout() {
  if (alreadyMigrated) {
    const marker = readLayout();
    const when = marker?.completedAt ? new Date(marker.completedAt).toISOString() : '不明';
    console.log(`現在のレイアウト: v${layoutVersion()} (移行済み, ${when})`);
  } else {
    console.log(`現在のレイアウト: v${layoutVersion()} (未移行)`);
    console.log('移行先:');
  }
  printRoots();
  console.log('');
}

function printLeftovers() {
  if (leftovers.length === 0) return;
  console.log('旧レイアウトの残骸を検出しました (ccserver は参照していません。確認のうえ手動で削除してください):');
  for (const l of leftovers) console.log(`  ${l.path}`);
  console.log('');
}

function printPlan() {
  // Warnings count as "something to say": an entry present on both sides is
  // not nothing, and reporting it under a "移行するものはありません" heading
  // would bury it.
  if (plan.steps.length === 0 && plan.kept.length === 0 && plan.warnings.length === 0) {
    console.log(alreadyMigrated ? '移行するものはありません。' : '移行対象は見つかりませんでした (新規インストール)。');
    console.log('');
  }

  if (plan.steps.length > 0) {
    console.log(`移動するもの (${plan.steps.length}件):`);
    for (const step of plan.steps) {
      const extra = step.items.length > 1
        ? ` (+ ${step.items.slice(1).map((i) => i.to.slice(step.to.length)).join(', ')})`
        : '';
      const fs = step.mode === 'copy-delete' ? '   (別FS: コピー＋削除)' : '';
      console.log(`  [${step.kind}] ${step.label}${extra}${fs}`);
      console.log(`        ${step.from}`);
      console.log(`     -> ${step.to}`);
    }
    console.log('');
  }

  if (plan.kept.length > 0) {
    console.log(`その場に残すもの (${STICKY_REASON}):`);
    for (const k of plan.kept) console.log(`  ${k.label.padEnd(28)} ${k.at}`);
    console.log('     -> 旧位置を使い続けます (layout.json の kept[] に記録)。実際に移動する場合は');
    console.log('        --move-large。git worktree の .git ポインタは絶対パスのため、移動後に各');
    console.log('        リポジトリで `git worktree repair` が必要です。');
    console.log('');
  }

  const overrides = plan.skips.filter((s) => s.reason === 'env-override');
  if (overrides.length > 0) {
    console.log('env var で上書き済みのため触らないもの:');
    for (const s of overrides) console.log(`  ${s.label.padEnd(28)} (${s.detail})`);
    console.log('');
  }

  printWarnings('警告');

  // Only on a host that has not been set up yet: on a v2 host the roots and
  // the config file already exist, and restating the static/dynamic split
  // every time the operator re-runs the wizard is noise.
  if (!alreadyMigrated) {
    printCreated();
    printSettingsGuidance();
  }
}

function printWarnings(heading) {
  if (plan.warnings.length === 0) return;
  console.log('');
  console.log(`${heading} (${plan.warnings.length}件):`);
  for (const w of plan.warnings) console.log(`  ${w.message}`);
  console.log('');
}

// Shown for any not-yet-set-up host, a pure migration included: that still
// creates the three roots and the marker, and the operator should see the
// config file listed before it appears. (printPlan skips it once the marker
// says v2, where all of it already exists.)
function printCreated() {
  const configEntry = allPaths().find((e) => e.id === 'sandboxConfig');
  console.log('作成されるもの:');
  console.log(`  + ${configRoot()}/   (dir, 0700)`);
  console.log(`  + ${dataRoot()}/   (dir, 0700)`);
  console.log(`  + ${stateRoot()}/   (dir, 0700)`);
  if (!configEntry.overridden && !existsSync(configEntry.path) && !plan.steps.some((s) => s.id === 'sandboxConfig')) {
    if (seedExample) {
      console.log(`  + ${configEntry.target}   (example の全文)`);
    } else {
      console.log(`  + ${configEntry.target}   (最小の雛形。全キーの既定値は`);
      console.log('      <checkout>/server/sandbox.config.example.json 参照)');
    }
  }
  console.log(`  + ${layoutMarkerPath()}   (セットアップ完了マーカー)`);
  console.log('');
}

function printSettingsGuidance() {
  console.log('設定の使い分け:');
  console.log('  - Web UI (設定タブ) から変更でき即時反映されるもの ... SQLite の settings テーブル');
  console.log('  - sandbox.config.json を編集し再起動が必要なもの   ... docker / persistentHome / gpg /');
  console.log('    sshAgent / gpgVault / browseRoots / hiddenApps / allowUnsandboxedAgents / reviewerMcp /');
  console.log('    usageMcp');
  console.log('    (実行中セッションの安全性がその値に依存するため、動的変更は行いません)');
  console.log('');
}

function dedupe(arr) {
  return [...new Set(arr)];
}

// --- running-server probe ---------------------------------------------------

function port() {
  return Number(process.env.PORT || 3001);
}

// No pidfile exists, so probe the port the same way startup-auth-mode.test.js
// polls for readiness. A live server is the likeliest way an operator breaks
// their install here: it holds the DB open while re-reading the state JSONs
// from their paths on every write, so migrating underneath it splits state
// across both layouts.
function serverSeemsRunning() {
  return new Promise((resolve) => {
    const socket = connect({ port: port(), host: '127.0.0.1' });
    const done = (answer) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(1000);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
}

function usage() {
  return [
    '使い方: npm run setup [-- <フラグ>]',
    '',
    '  (なし)            ドライラン。プランを表示して終了 (何も変えません)',
    '  --yes             実際に移行し、レイアウトマーカーを書き込みます',
    '  --move-large      home/ worktrees/ review-worktrees/ orchestrator/ dind/ も移動します',
    '                    (移動後、各リポジトリで `git worktree repair` が必要です)',
    '  --seed-example    sandbox.config.json を example の全文から生成します',
    '                    (既定はポインタコメントだけの最小ファイル)',
    '  --force           サーバーが稼働中でも実行します',
    '  --json            機械可読なプランを出力します',
    '  --help            このヘルプ',
    '',
    '終了コード: 0 正常 / 1 適用失敗 (ロールバック済み) / 2 引数不正',
  ].join('\n');
}
