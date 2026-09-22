import { useState, useEffect, useCallback, useMemo, useRef, lazy, Suspense } from 'react';
import { authFetch, getToken, resolveAuthMode } from '../auth.js';
import { displayPath } from '../displayPath.js';
import { formatSize } from '../formatSize.js';
import { isPreviewable } from '../previewExts.js';
import { isAppSelectable } from '../appAvailability.js';
import { PERMISSION_MODES, PERMISSION_MODE_LABELS } from '../permissionMode.js';
import { loadSandboxDefaults, defaultSandboxOpts } from '../sandboxDefaults.js';

// marked + DOMPurify only matter once someone opens a preview, so keep them
// out of the initial bundle (same split as TerminalView in App.jsx).
const FilePreview = lazy(() => import('./FilePreview.jsx'));

const LAST_DIR_KEY = 'ccserver-last-dir';
const SANDBOX_KEY = 'ccserver-sandbox-default';
const SANDBOX_OPTS_PREFIX = 'ccserver-sandbox-opts:';
const APP_KEY = 'ccserver-app-default';
const COMBO_APPS_KEY = 'ccserver-combo-apps';
const COMBO_ROLES = ['workerA', 'workerB', 'orchestrator'];
const COMBO_DEFAULT_APPS = { workerA: 'claude', workerB: 'opencode', orchestrator: 'claude' };
// Apps a group member can run (copilot cannot join groups -- same whitelist
// the server enforces for presets and workers[]).
const COMBO_WORKER_APPS = ['claude', 'opencode', 'codex'];
// Every launchable app id, in the order pickers list them.
const ALL_APPS = ['claude', 'opencode', 'copilot', 'codex', 'commandcode'];
// macOS (seatbelt) copy for the opt-in tool toggles the server host cannot
// provision (/api/dirs/home's toolsAvailable). See issue #22.
const TOOL_UNAVAILABLE_NOTE = 'この ccserver ホスト (macOS) では非対応です';

// Force any tool the server host cannot provision to false, so a selection
// remembered from a Linux host never rides along in a launch payload the
// server would silently drop. `avail` is /api/dirs/home's toolsAvailable
// ({ rtk, codeReviewGraph }) or null (older server / not fetched -> untouched).
function sanitizeSandboxOpts(opts, avail) {
  if (!opts || !avail) return opts;
  const tools = opts.tools || {};
  const next = { ...tools };
  if (avail.rtk === false) next.rtk = false;
  if (avail.codeReviewGraph === false) next.codeReviewGraph = false;
  return { ...opts, tools: next };
}
// sandbox-unavailable warning copy shared by the sandbox picker note and the
// browser header banner, so the two can't drift apart (see PR#135 review).
// The short title variant is used for disabled launch-button tooltips.
const SANDBOX_UNAVAILABLE_NOTE = 'このサーバーではサンドボックス機能が利用できないため、サンドボックス起動・コンボ起動はできません。通常起動をご利用ください。';
const FORCE_SANDBOX_UNAVAILABLE_NOTE = 'サーバー設定 (forceSandbox) でサンドボックスが強制されていますが、このホストではサンドボックス機能を利用できません。サンドボックス基盤をインストールするか、サーバー設定を見直してください。';
const LAUNCHES_BLOCKED_TITLE = 'サーバー設定でサンドボックスが強制されていますが、このホストではサンドボックス機能を利用できません';
const COMBO_UNAVAILABLE_TITLE = 'コンボ起動は常時サンドボックス必須ですが、このサーバーではサンドボックス機能を利用できません';

// Hard cap mirrored from the server (MAX_GROUP_MEMBERS - 1 orchestrator).
const MAX_COMBO_WORKERS = 7;

// Same picker set + labels as single mode, so the two can't drift apart.
const APP_LABELS = { claude: 'Claude Code', opencode: 'opencode', copilot: 'GitHub Copilot', codex: 'OpenAI Codex', commandcode: 'Command Code' };

// Combo-mode role app picks, remembered per browser like the single-launch
// APP_KEY so the next combo launch reuses them instead of the claude/
// opencode defaults. Only claude/opencode/codex are valid choices; anything else
// falls back to the per-role default.
function loadComboApps() {
  try {
    const raw = localStorage.getItem(COMBO_APPS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        const out = {};
        for (const role of COMBO_ROLES) {
          const v = parsed[role];
          out[role] = v === 'claude' || v === 'opencode' || v === 'codex' ? v : COMBO_DEFAULT_APPS[role];
        }
        return out;
      }
    }
  } catch { /* ignore */ }
  return { ...COMBO_DEFAULT_APPS };
}

// Per-directory opt-in sandbox flags (gpg / sshAgent / tools), remembered
// separately per cwd rather than as one server-wide default -- see
// server/sandbox.config.json's `gpg`/`sshAgent`/`tools` for the fallback these
// override at launch. `tools` (rtk / code-review-graph) provisions the tool
// into the sandbox HOME at launch instead of installing it on the host.
// 記憶が無い場合の初期値は Settings > 一般のグローバル既定値
// (client/src/sandboxDefaults.js) を使う。gpg/sshAgent は既定オフ。
// tools (rtk / code-review-graph) もキー不在時はグローバル既定値に
// フォールバックする (旧形式の記憶には tools が無いため); a stored
// explicit false turns them back off for that directory.
export function hasSandboxOptsMemory(path) {
  try {
    return localStorage.getItem(SANDBOX_OPTS_PREFIX + path) !== null;
  } catch { /* ignore */ }
  return false;
}

function loadSandboxOpts(path, globalDefaults) {
  try {
    const raw = localStorage.getItem(SANDBOX_OPTS_PREFIX + path);
    if (raw) {
      const parsed = JSON.parse(raw);
      // 旧形式の記憶 ({gpg, sshAgent} のみ) では tools キーが不在。
      // 不在 = 未選択なので一律 true にせずグローバル既定値にフォールバックする
      // (明示保存された true/false は引き続き尊重される)。
      const fallbackTools = defaultSandboxOpts(globalDefaults || loadSandboxDefaults()).tools;
      return {
        gpg: !!parsed.gpg,
        sshAgent: !!parsed.sshAgent,
        gpgVault: !!parsed.gpgVault,
        tools: {
          rtk: parsed.tools?.rtk ?? fallbackTools.rtk,
          codeReviewGraph: parsed.tools?.codeReviewGraph ?? fallbackTools.codeReviewGraph,
        },
      };
    }
  } catch { /* ignore */ }
  return defaultSandboxOpts(globalDefaults || loadSandboxDefaults());
}

function saveSandboxOpts(path, opts) {
  try {
    localStorage.setItem(SANDBOX_OPTS_PREFIX + path, JSON.stringify(opts));
  } catch { /* ignore */ }
}

export default function DirectoryBrowser({ onOpen, onOpenShell, onOpenCombo, initialPath, sandboxDefaults }) {
  const [currentPath, setCurrentPath] = useState(initialPath || localStorage.getItem(LAST_DIR_KEY) || '/');
  const [homeDir, setHomeDir] = useState(null);
  // browseRoots (issue #189): the server's guaranteed-browsable start (the
  // first allowed root when home() itself is outside them, home() otherwise).
  // Used for the Home button and to recover when a remembered/restored path
  // falls outside a newly-narrowed browseRoots (403 on fetch).
  const [initialBrowsePath, setInitialBrowsePath] = useState(null);
  const [dirs, setDirs] = useState([]);
  const [files, setFiles] = useState([]);
  const [parentPath, setParentPath] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [showHidden, setShowHidden] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  // git init opt-in for folder creation (off by default, like the other
  // launch flags): avoids surprising nested repositories under existing ones.
  const [initGit, setInitGit] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState('');
  const [previewFile, setPreviewFile] = useState(null);
  const fileInputRef = useRef(null);
  const dragCountRef = useRef(0);
  const [sandboxDefault, setSandboxDefault] = useState(() => localStorage.getItem(SANDBOX_KEY) === '1');
  // Server-enforced sandbox (sandbox.config.json's "forceSandbox"): when on,
  // the sandbox toggle is overridden -- every launch is sandboxed and the
  // "通常起動" choice is disabled. Set from /api/dirs/home.
  const [forceSandbox, setForceSandbox] = useState(false);
  // Whether a sandbox backend exists on the server host (/api/dirs/home's
  // sandboxAvailable). false disables the sandbox choice (and combo mode,
  // which always requires the sandbox). null until the fetch resolves;
  // while null everything stays enabled (old-server fallback, same as
  // availableApps).
  const [sandboxAvailable, setSandboxAvailable] = useState(null);
  // gpgVault (plan: gpg-agent-vault) is a passkey-login-only feature -- this
  // component has no other reason to know authMode, so it resolves it
  // locally rather than threading a new prop through App.jsx, same
  // independent-resolution pattern GeneralSection.jsx/PasskeysSection.jsx
  // already use. null until resolved (checkbox stays enabled meanwhile,
  // same old-server-fallback posture as availableApps/sandboxAvailable).
  const [authMode, setAuthMode] = useState(null);
  useEffect(() => {
    let cancelled = false;
    resolveAuthMode().then((m) => { if (!cancelled) setAuthMode(m); });
    return () => { cancelled = true; };
  }, []);
  // Which agent CLIs the server can actually launch ({ claude, opencode,
  // copilot, codex, commandcode } booleans), from /api/dirs/home. null until
  // the fetch resolves; while null every picker entry stays enabled
  // (old-server fallback).
  const [availableApps, setAvailableApps] = useState(null);
  // Which opt-in tool toggles (rtk / code-review-graph) the server host can
  // actually provision, from /api/dirs/home. false on macOS (seatbelt has no
  // provisioner). null until the fetch resolves -> both stay enabled
  // (old-server fallback). An unavailable tool renders its checkbox disabled
  // with an explanation, like availableApps for CLIs.
  const [toolsAvailable, setToolsAvailable] = useState(null);
  // Apps hidden via sandbox.config.json's "hiddenApps" (issue #105 -- CLIs the
  // operator hasn't contracted for): removed from every picker below
  // entirely, regardless of install status. From /api/dirs/home; empty until
  // the fetch resolves, so nothing is hidden by default (old-server fallback).
  const [hiddenApps, setHiddenApps] = useState([]);
  // 'claude' until the server's configured default (sandbox.config.json's
  // "defaultApp") arrives via /api/dirs/home, or the user picks explicitly.
  const [appDefault, setAppDefault] = useState(() => {
    const saved = localStorage.getItem(APP_KEY);
    return ['opencode', 'copilot', 'codex', 'commandcode', 'claude'].includes(saved) ? saved : 'claude';
  });
  const [codexModel, setCodexModel] = useState(() => localStorage.getItem('ccserver-codex-model') || '');
  const [commandcodeModel, setCommandcodeModel] = useState(() => localStorage.getItem('ccserver-commandcode-model') || '');
  // --model 対応アプリの判定はここに集約（対応アプリ追加時はここだけ変える）。
  const modelForApp = (app) => {
    if (app === 'codex') return codexModel.trim() || null;
    if (app === 'commandcode') return commandcodeModel.trim() || null;
    return null;
  };
  const modelInputForApp = (app) => app === 'codex' || app === 'commandcode';
  // commandcode の許可モード (standard / auto-accept / yolo)。OFF(=standard)
  // も含めて記憶する (単なる既定値ではなくユーザーの明示選択として保持)。
  const [commandcodePermissionMode, setCommandcodePermissionMode] = useState(() => {
    const saved = localStorage.getItem('ccserver-commandcode-permission-mode');
    return PERMISSION_MODES.includes(saved) ? saved : 'standard';
  });
  const choosePermissionMode = (val) => {
    if (!PERMISSION_MODES.includes(val)) return;
    setCommandcodePermissionMode(val);
    localStorage.setItem('ccserver-commandcode-permission-mode', val);
  };
  // 許可モードは commandcode 起動にだけ付与する (他アプリは常に standard)。
  const permissionModeForApp = (app) => (app === 'commandcode' ? commandcodePermissionMode : 'standard');
  const [openMenuOpen, setOpenMenuOpen] = useState(false);
  const [launchMode, setLaunchMode] = useState('single'); // 'single' | 'combo'
  const [comboApps, setComboApps] = useState(() => loadComboApps());
  // Free-form per-role model identifiers; empty string = omitted (server uses
  // the persisted role preference, then the app default). null would mean
  // "explicitly the app default", which the text input doesn't produce -- an
  // omitted value is the practical equivalent.
  const [comboModels, setComboModels] = useState({ workerA: '', workerB: '', orchestrator: '' });
  // Per-role sandbox overrides; null = inherit the group-level common flags.
  const [comboRoleSandbox, setComboRoleSandbox] = useState({ workerA: null, workerB: null, orchestrator: null });
  const [orchestratorInstructions, setOrchestratorInstructions] = useState('');
  const [sandboxOpts, setSandboxOpts] = useState(() => loadSandboxOpts(currentPath, sandboxDefaults));

  // Worker presets (shared server-side library). presetsState: 'idle' until
  // the combo modal first needs them, then 'loading' | 'ready' | 'error'.
  // An 'error' (or an empty library) keeps the classic workerA/workerB draft
  // UI fully functional -- a broken preset API must never break the modal.
  const [presets, setPresets] = useState([]);
  const [presetsState, setPresetsState] = useState('idle');
  // Workers added from presets for THIS launch: { uid, presetId, name, role,
  // app, model }. Per-launch snapshot only: editing/deleting a preset later
  // never touches already-selected rows or launched groups.
  const [selectedWorkers, setSelectedWorkers] = useState([]);
  const workerUidRef = useRef(0);
  // Preset management dialog state (create/edit/delete).
  const [manageOpen, setManageOpen] = useState(false);
  const [editingPresetId, setEditingPresetId] = useState(null);
  const [presetForm, setPresetForm] = useState({ name: '', role: '', app: 'claude', model: '' });
  const [presetFormError, setPresetFormError] = useState(null);

  // Combo-mode state is per-launch, not sticky: leaving the modal (cancel,
  // overlay click, or a launch) must return it to the plain single mode,
  // otherwise the user's next "起動" -- possibly for a different project --
  // would silently fire a full combo spawn with the previous instructions.
  // One close path for every exit route so future routes can't forget.
  // (The role app picks in comboApps are the exception: they are remembered
  // in localStorage, see loadComboApps/chooseComboApp, and intentionally
  // survive both modal closes and reloads.)
  const closeOpenMenu = useCallback(() => {
    setLaunchMode('single');
    setOrchestratorInstructions('');
    setComboModels({ workerA: '', workerB: '', orchestrator: '' });
    setComboRoleSandbox({ workerA: null, workerB: null, orchestrator: null });
    setSelectedWorkers([]);
    setManageOpen(false);
    setEditingPresetId(null);
    setPresetFormError(null);
    // Back to 'idle' so the next combo open refetches the library -- retries a
    // failed fetch and picks up presets saved elsewhere since this modal opened.
    setPresetsState('idle');
    setOpenMenuOpen(false);
  }, []);

  const chooseSandbox = useCallback((val) => {
    if (forceSandbox) return; // server forbids unsandboxed launches
    if (val && sandboxAvailable === false) return; // no sandbox backend on the server host
    setSandboxDefault(val);
    localStorage.setItem(SANDBOX_KEY, val ? '1' : '0');
  }, [forceSandbox, sandboxAvailable]);

  const chooseApp = useCallback((val) => {
    if (hiddenApps.includes(val)) return; // operator hid this app
    if (availableApps && !availableApps[val]) return; // server lacks this CLI
    setAppDefault(val);
    localStorage.setItem(APP_KEY, val);
  }, [availableApps, hiddenApps]);

  const chooseComboApp = useCallback((role, app) => {
    if (hiddenApps.includes(app)) return; // operator hid this app
    if (availableApps && !availableApps[app]) return; // server lacks this CLI
    setComboApps((c) => {
      const next = { ...c, [role]: app };
      localStorage.setItem(COMBO_APPS_KEY, JSON.stringify(next));
      return next;
    });
  }, [availableApps, hiddenApps]);

  // --- worker presets -------------------------------------------------------

  const fetchPresets = useCallback(async () => {
    setPresetsState('loading');
    try {
      const res = await authFetch('/api/worker-presets');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setPresets(data.presets || []);
      setPresetsState('ready');
    } catch {
      // Fallback: the classic workerA/workerB drafts keep working; the modal
      // must never break because the preset API is unavailable.
      setPresets([]);
      setPresetsState('error');
    }
  }, []);

  // Fetch once when combo mode first becomes visible in the modal.
  useEffect(() => {
    if (openMenuOpen && launchMode === 'combo' && presetsState === 'idle') fetchPresets();
  }, [openMenuOpen, launchMode, presetsState, fetchPresets]);

  const addSelectedWorker = useCallback((presetId) => {
    const p = presets.find((x) => x.id === presetId);
    if (!p) return;
    setSelectedWorkers((rows) => {
      if (rows.some((r) => r.role === p.role)) return rows; // roles are unique per launch
      if (rows.length >= MAX_COMBO_WORKERS) return rows;
      const visible = COMBO_WORKER_APPS.filter((a) => !hiddenApps.includes(a));
      // 'claude' is only a safe fallback when it isn't itself hidden -- with
      // every combo-eligible app hidden (issue #105 edge case: an operator
      // who only contracted GitHub Copilot, which can't join combos), there
      // is no valid app to assign, so refuse to add the row rather than
      // silently reintroducing a hidden app (see the コンボ起動 disabled
      // check below, which this also protects).
      if (visible.length === 0) return rows;
      return [...rows, {
        uid: ++workerUidRef.current,
        presetId: p.id,
        name: p.name,
        role: p.role,
        app: visible.includes(p.app) ? p.app : visible[0],
        model: p.model || '',
      }];
    });
  }, [presets, hiddenApps]);

  const updateSelectedWorker = useCallback((uid, patch) => {
    setSelectedWorkers((rows) => rows.map((r) => (r.uid === uid ? { ...r, ...patch } : r)));
  }, []);

  const removeSelectedWorker = useCallback((uid) => {
    setSelectedWorkers((rows) => rows.filter((r) => r.uid !== uid));
  }, []);

  const moveSelectedWorker = useCallback((uid, dir) => {
    setSelectedWorkers((rows) => {
      const i = rows.findIndex((r) => r.uid === uid);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= rows.length) return rows;
      const next = rows.slice();
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }, []);

  const openPresetManage = useCallback(() => {
    setEditingPresetId(null);
    // '' when every combo-eligible app is hidden: no picker button will show
    // as active (visibleComboApps is empty too), and the server rejects an
    // empty/missing app on save, so this can never silently smuggle a hidden
    // app into a saved preset.
    const fallbackApp = COMBO_WORKER_APPS.find((a) => !hiddenApps.includes(a)) || '';
    setPresetForm({ name: '', role: '', app: fallbackApp, model: '' });
    setPresetFormError(null);
    setManageOpen(true);
  }, [hiddenApps]);

  const startEditPreset = useCallback((p) => {
    setEditingPresetId(p.id);
    // A preset saved before its app was hidden must not silently carry the
    // hidden id back into the form (see openPresetManage's identical
    // fallback) -- otherwise saving without touching the app row would
    // re-persist a hidden app indefinitely, even though no button for it
    // renders in this same form.
    const visibleComboAppsNow = COMBO_WORKER_APPS.filter((a) => !hiddenApps.includes(a));
    const app = visibleComboAppsNow.includes(p.app) ? p.app : (visibleComboAppsNow[0] || '');
    setPresetForm({ name: p.name, role: p.role, app, model: p.model || '' });
    setPresetFormError(null);
  }, [hiddenApps]);

  const savePreset = useCallback(async () => {
    setPresetFormError(null);
    const body = {
      name: presetForm.name.trim(),
      role: presetForm.role.trim(),
      app: presetForm.app,
      model: presetForm.model.trim() || null,
    };
    try {
      const res = await authFetch(editingPresetId ? `/api/worker-presets/${editingPresetId}` : '/api/worker-presets', {
        method: editingPresetId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error || `HTTP ${res.status}`);
      }
      // Back to the create form, refreshed library.
      setEditingPresetId(null);
      setPresetForm({ name: '', role: '', app: presetForm.app, model: '' });
      fetchPresets();
    } catch (err) {
      setPresetFormError(err.message);
    }
  }, [presetForm, editingPresetId, fetchPresets]);

  const deletePreset = useCallback(async (p) => {
    if (!window.confirm(`プリセット「${p.name}」(${p.role}) を削除しますか?`)) return;
    try {
      const res = await authFetch(`/api/worker-presets/${p.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error || `HTTP ${res.status}`);
      }
      // Deleting a preset must not touch rows already selected for a launch
      // (they are snapshots); only the library shrinks.
      fetchPresets();
    } catch (err) {
      setPresetFormError(err.message);
    }
  }, [fetchPresets]);

  // gpg/sshAgent/tools はディレクトリ別に記憶し、記憶が無い場合のみ
  // Settings > 一般のグローバル既定値を使う。ディレクトリ移動時と
  // グローバル既定値の変更時に再読込するが、記憶済みの場所は上書きしない。
  useEffect(() => {
    if (hasSandboxOptsMemory(currentPath)) {
      setSandboxOpts(loadSandboxOpts(currentPath, sandboxDefaults));
    } else {
      setSandboxOpts(defaultSandboxOpts(sandboxDefaults || loadSandboxDefaults()));
    }
  }, [currentPath, sandboxDefaults]);

  const updateSandboxOpts = useCallback((path, next) => {
    setSandboxOpts(next);
    saveSandboxOpts(path, next);
  }, []);

  // sandboxOpts with any host-unavailable tool forced off -- the shape every
  // launch payload uses, so a toggle remembered on a Linux host cannot ride
  // along on a macOS host where the server would drop it anyway.
  const effectiveSandboxOpts = useMemo(
    () => sanitizeSandboxOpts(sandboxOpts, toolsAvailable),
    [sandboxOpts, toolsAvailable],
  );
  const toolDisabled = (id) => toolsAvailable ? toolsAvailable[id] === false : false;

  const fetchDirs = useCallback(async (path) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ path });
      if (showHidden) params.set('showHidden', '1');
      const res = await authFetch(`/api/dirs?${params}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const err = new Error(body.error || `HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      const data = await res.json();
      setCurrentPath(data.current);
      setParentPath(data.parent);
      setDirs(data.dirs);
      setFiles(data.files || []);
    } catch (err) {
      setError(err.message);
      // A remembered path (localStorage) or restored tab can fall outside a
      // newly-narrowed browseRoots: the listing 403s and the Up/Home buttons
      // alone cannot recover from it. Jump to the server's allowed start
      // once, rather than leaving the browser stuck on an empty error view.
      if (err.status === 403 && initialBrowsePath && path !== initialBrowsePath) {
        setCurrentPath(initialBrowsePath);
      }
    } finally {
      setLoading(false);
    }
  }, [showHidden, initialBrowsePath]);

  useEffect(() => {
    authFetch('/api/dirs/home').then(r => r.json()).then(data => {
      setHomeDir(data.home);
      if (data.initialBrowsePath) setInitialBrowsePath(data.initialBrowsePath);
      // Present-but-unusable browseRoots: the server refuses all directory
      // and file access (503) until it is fixed -- say so instead of
      // rendering an empty browser.
      if (data.browseRootsInvalid) {
        setError('sandbox.config.json の "browseRoots" が不正です (ディレクトリパスの配列で指定してください)。サーバー設定を修正するまでファイル閲覧は無効です。');
      }
      if (!initialPath && !localStorage.getItem(LAST_DIR_KEY)) {
        // browseRoots (issue #189): when set, home() itself may sit outside
        // the allowed roots -- start browsing at initialBrowsePath instead
        // (falls back to data.home on an older server that doesn't send it).
        setCurrentPath(data.initialBrowsePath || data.home);
      }
      // Seed the app picker from the server's configured default, but only
      // if the user hasn't explicitly picked one on this browser yet.
      if (!localStorage.getItem(APP_KEY) && ['opencode', 'copilot', 'codex', 'commandcode', 'claude'].includes(data.defaultApp)) {
        setAppDefault(data.defaultApp);
      }
      // Server-enforced sandbox: force the toggle on and lock it.
      if (data.forceSandbox) {
        setForceSandbox(true);
        setSandboxDefault(true);
      }
      // No sandbox backend on the server host: the sandbox choice (and combo
      // mode, which always requires it) cannot work. Correct a remembered
      // sandbox default the same way stale app defaults are corrected
      // below. Missing field = older server: leave everything enabled.
      if (typeof data.sandboxAvailable === 'boolean') {
        setSandboxAvailable(data.sandboxAvailable);
        if (data.sandboxAvailable === false) {
          // forceSandbox keeps the toggle locked on (launches fail
          // server-side with the warning note); only correct the free
          // choice, otherwise the checkmark would sit on 通常起動 while
          // every launch is forced sandboxed.
          if (!data.forceSandbox) {
            setSandboxDefault(false);
            try { localStorage.setItem(SANDBOX_KEY, '0'); } catch { /* ignore */ }
          }
          setLaunchMode('single');
        }
      }
      // Apps hidden via sandbox.config.json's hiddenApps (issue #105): read
      // before the availability reconciliation below so a default that
      // points at a hidden (even if installed) app is also corrected.
      const hidden = Array.isArray(data.hiddenApps) ? data.hiddenApps : [];
      setHiddenApps(hidden);

      // Server-side install detection: grey out picker entries for CLIs that
      // don't exist here, and correct a stale default (localStorage
      // ccserver-app-default, or the server's defaultApp) that points at an
      // uninstalled OR hidden app -- the launch button label and modal
      // checkmark must never advertise an app that cannot start or cannot be
      // shown.
      if (data.availableApps) {
        setAvailableApps(data.availableApps);
        const isPickable = (a) => isAppSelectable(a, data.availableApps, hidden);
        const avail = ALL_APPS.filter(isPickable);
        // The server's defaultApp seeding above runs in the same effect tick,
        // so appDefault is still the stale pre-seeding value here -- evaluate
        // the effective default (server's when the browser hasn't chosen yet,
        // else the remembered one) before testing availability.
        const effectiveDefault = ALL_APPS.includes(data.defaultApp) && !localStorage.getItem(APP_KEY)
          ? data.defaultApp
          : appDefault;
        if (avail.length > 0 && !isPickable(effectiveDefault)) {
          setAppDefault(avail[0]);
        }
        // Same rule for the combo modal's role selections: workerA and the
        // orchestrator start as claude, workerB as opencode -- a role whose
        // default points at a missing/hidden CLI must not stay
        // selected-active (the launch would be refused server-side, or the
        // picker would show no active button at all). Combo only offers
        // claude/opencode/codex, so the fallback is restricted to those.
        const comboAvail = COMBO_WORKER_APPS.filter(isPickable);
        if (comboAvail.length > 0) {
          setComboApps((c) => {
            const next = {
              workerA: isPickable(c.workerA) ? c.workerA : comboAvail[0],
              workerB: isPickable(c.workerB) ? c.workerB : comboAvail[0],
              orchestrator: isPickable(c.orchestrator) ? c.orchestrator : comboAvail[0],
            };
            // Write the corrected picks through so a reload keeps them.
            localStorage.setItem(COMBO_APPS_KEY, JSON.stringify(next));
            return next;
          });
        }
      }

      // Opt-in tools the server host cannot provision (rtk / code-review-graph
      // are unavailable on macOS -- seatbelt has no provisioner). The toggles
      // render disabled-with-an-explanation and effectiveSandboxOpts (below)
      // forces the flags false in every launch payload, so a remembered
      // per-directory selection from a Linux host can't smuggle one through.
      if (data.toolsAvailable && typeof data.toolsAvailable === 'object') {
        setToolsAvailable(data.toolsAvailable);
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    fetchDirs(currentPath);
  }, [currentPath, fetchDirs]);

  // Remembering the path is keyed on currentPath ONLY -- deliberately not on
  // fetchDirs. fetchDirs' identity changes when /api/dirs/home resolves
  // (initialBrowsePath), which re-runs the listing effect for the SAME path;
  // folding the write in there re-wrote the (unchanged) path after that
  // resolution and could clobber a concurrently-set value.
  useEffect(() => {
    localStorage.setItem(LAST_DIR_KEY, currentPath);
  }, [currentPath]);

  const navigateTo = useCallback((path) => {
    setCurrentPath(path);
  }, []);

  const navigateUp = useCallback(() => {
    if (parentPath) setCurrentPath(parentPath);
  }, [parentPath]);

  const closeFolderForm = useCallback(() => {
    setCreatingFolder(false);
    setNewFolderName('');
    setInitGit(false);
  }, []);

  const handleCreateFolder = useCallback(async () => {
    if (!newFolderName.trim()) return;
    try {
      const res = await authFetch('/api/dirs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parent: currentPath, name: newFolderName.trim(), gitInit: initGit }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        // git-init failure keeps the directory server-side ({error, path}):
        // navigate there so the user can run `git init` manually, but keep
        // the error visible instead of silently pretending nothing happened.
        if (body.path) {
          closeFolderForm();
          setCurrentPath(body.path);
          setError(body.error || `HTTP ${res.status}`);
          return;
        }
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      closeFolderForm();
      setCurrentPath(data.path);
    } catch (err) {
      setError(err.message);
    }
  }, [currentPath, newFolderName, initGit, closeFolderForm]);

  const closePreview = useCallback(() => setPreviewFile(null), []);

  const handleDownload = useCallback((file) => {
    const a = document.createElement('a');
    const token = getToken();
    const tokenParam = token ? `&token=${encodeURIComponent(token)}` : '';
    a.href = `/api/files?path=${encodeURIComponent(file.path)}${tokenParam}`;
    a.download = file.name;
    a.click();
  }, []);

  const uploadFiles = useCallback(async (fileList) => {
    if (!fileList || fileList.length === 0) return;
    setUploading(true);
    setUploadProgress(`Uploading ${fileList.length} file(s)...`);
    setError(null);
    try {
      const formData = new FormData();
      formData.append('destination', currentPath);
      for (const file of fileList) {
        formData.append('files', file);
      }
      const res = await authFetch('/api/files', { method: 'POST', body: formData });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setUploadProgress(`Uploaded ${data.uploaded.length} file(s)`);
      fetchDirs(currentPath);
      setTimeout(() => setUploadProgress(''), 3000);
    } catch (err) {
      setError(err.message);
      setUploadProgress('');
    } finally {
      setUploading(false);
    }
  }, [currentPath, fetchDirs]);

  const handleFileInputChange = useCallback((e) => {
    uploadFiles(e.target.files);
    e.target.value = '';
  }, [uploadFiles]);

  const handleDragEnter = useCallback((e) => {
    e.preventDefault();
    dragCountRef.current++;
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    dragCountRef.current--;
    if (dragCountRef.current <= 0) {
      dragCountRef.current = 0;
      setDragOver(false);
    }
  }, []);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    dragCountRef.current = 0;
    setDragOver(false);
    uploadFiles(e.dataTransfer.files);
  }, [uploadFiles]);

  // Under $HOME subdirectories the breadcrumb root renders as `~` (title
  // carries the real path); at $HOME itself and elsewhere the drive/root
  // prefix is shown, so $HOME's parents stay reachable. Navigation always
  // uses the real paths.
  const homeBase = homeDir && homeDir !== '/'
    && currentPath.startsWith(homeDir + '/')
    ? (homeDir.endsWith('/') ? homeDir.slice(0, -1) : homeDir)
    : null;
  const pathRoot = homeBase || (currentPath.match(/^([a-zA-Z]:\\|\/)/)?.[0] || '/');
  const breadcrumbs = currentPath.slice(homeBase ? homeBase.length : pathRoot.length).split(/[/\\]/).filter(Boolean);

  // Apps hidden via sandbox.config.json's hiddenApps (issue #105): filtered
  // out of every picker list below entirely -- unlike availableApps===false
  // (not installed, which still shows greyed-out with a tooltip), a hidden
  // app never renders at all.
  const visibleApps = ALL_APPS.filter((a) => !hiddenApps.includes(a));
  const visibleComboApps = COMBO_WORKER_APPS.filter((a) => !hiddenApps.includes(a));
  // Guards the toolbar's quick-launch button and the in-modal single-launch
  // "起動" button (issue #105): unlike the picker items, which block their
  // own onClick via chooseApp, these two fire onOpen directly with whatever
  // appDefault currently holds -- if it's stale (hidden after being saved,
  // or still mid-flight before the /api/dirs/home reconciliation effect
  // above corrects it) they'd launch a hidden or uninstalled app with no
  // guard at all, unlike every other launch affordance this feature added.
  const effectiveAppHidden = hiddenApps.includes(appDefault) || (availableApps && !availableApps[appDefault]);
  // Safety net for issue #105's combo-mode edge case: when every combo-
  // eligible app is hidden (e.g. an operator who only contracted GitHub
  // Copilot, which can't join combos), the reconciliation effect above has
  // nothing to correct comboApps.workerA/workerB/orchestrator to, so they
  // can still hold a stale/default hidden app id even though the role
  // pickers above render zero buttons for it. Without this check, コンボ起動
  // would silently launch that hidden app -- the one screen where a
  // rendering-vs-launch-value mismatch could defeat the hide entirely.
  const comboHasHiddenAppSelected = COMBO_ROLES.some((role) => !visibleComboApps.includes(comboApps[role]))
    || selectedWorkers.some((r) => !visibleComboApps.includes(r.app));

  // Sandbox choice + gpg/sshAgent suboptions for the single-launch pane.
  // Sandbox choice unavailable when no sandbox backend exists on the server host
  // (combo mode is covered separately at its own toggle/button). Under
  // forceSandbox the toggle stays locked on -- launches will fail
  // server-side, and the note below says so.
  const sandboxChoiceDisabled = sandboxAvailable === false && !forceSandbox;
  // Contradictory server config (forceSandbox but no sandbox backend): no
  // launch can succeed, so the launch buttons are disabled as well
  // (fail-closed UI).
  // null (fetch pending / older server) keeps everything enabled.
  const launchesBlocked = forceSandbox && sandboxAvailable === false;
  const sandboxPicker = (
    <>
      <div className="open-menu-sep" />
      <div
        className={`open-menu-item${forceSandbox ? ' open-menu-item-disabled' : ''}`}
        onClick={() => chooseSandbox(false)}
        title={forceSandbox ? 'サーバー設定でサンドボックス外の起動は禁止されています' : ''}
      >
        <span className="open-menu-check">{!sandboxDefault ? '✓' : ''}</span>
        通常起動
      </div>
      <div
        className={`open-menu-item${sandboxChoiceDisabled ? ' open-menu-item-disabled' : ''}`}
        onClick={() => chooseSandbox(true)}
          title={forceSandbox ? 'サーバー設定で強制' : (sandboxChoiceDisabled ? 'このサーバーではサンドボックス機能が利用できないため使えません' : '')}
      >
        <span className="open-menu-check">{sandboxDefault ? '✓' : ''}</span>
        🔒 サンドボックスで起動
      </div>
      <div className="open-menu-suboptions">
        <label className="open-menu-suboption">
          <input
            type="checkbox"
            checked={sandboxOpts.gpg}
            onChange={(e) => updateSandboxOpts(currentPath, { ...sandboxOpts, gpg: e.target.checked })}
          />
          GPG署名を使う
        </label>
        <label className="open-menu-suboption">
          <input
            type="checkbox"
            checked={sandboxOpts.sshAgent}
            onChange={(e) => updateSandboxOpts(currentPath, { ...sandboxOpts, sshAgent: e.target.checked })}
          />
          ssh-agentを転送する
        </label>
        <label className={`open-menu-suboption${authMode !== 'passkey' ? ' open-menu-suboption-disabled' : ''}`} title={authMode !== 'passkey' ? 'パスキーログイン限定機能です' : ''}>
          <input
            type="checkbox"
            disabled={authMode !== 'passkey'}
            checked={authMode !== 'passkey' ? false : sandboxOpts.gpgVault}
            onChange={(e) => updateSandboxOpts(currentPath, { ...sandboxOpts, gpgVault: e.target.checked })}
          />
          GPG Vaultで署名・SSH pushする
        </label>
        <label className={`open-menu-suboption${toolDisabled('rtk') ? ' open-menu-suboption-disabled' : ''}`} title={toolDisabled('rtk') ? TOOL_UNAVAILABLE_NOTE : ''}>
          <input
            type="checkbox"
            disabled={toolDisabled('rtk')}
            checked={toolDisabled('rtk') ? false : sandboxOpts.tools.rtk}
            onChange={(e) => updateSandboxOpts(currentPath, { ...sandboxOpts, tools: { ...sandboxOpts.tools, rtk: e.target.checked } })}
          />
          rtk を導入する (sandbox 内にインストール){toolDisabled('rtk') ? `（${TOOL_UNAVAILABLE_NOTE}）` : ''}
        </label>
        <label className={`open-menu-suboption${toolDisabled('codeReviewGraph') ? ' open-menu-suboption-disabled' : ''}`} title={toolDisabled('codeReviewGraph') ? TOOL_UNAVAILABLE_NOTE : ''}>
          <input
            type="checkbox"
            disabled={toolDisabled('codeReviewGraph')}
            checked={toolDisabled('codeReviewGraph') ? false : sandboxOpts.tools.codeReviewGraph}
            onChange={(e) => updateSandboxOpts(currentPath, { ...sandboxOpts, tools: { ...sandboxOpts.tools, codeReviewGraph: e.target.checked } })}
          />
          code-review-graph MCP を導入する{toolDisabled('codeReviewGraph') ? `（${TOOL_UNAVAILABLE_NOTE}）` : ''}
        </label>
      </div>
      <p className="open-menu-note">
        {forceSandbox && sandboxAvailable === false
          ? FORCE_SANDBOX_UNAVAILABLE_NOTE
          : forceSandbox
            ? 'サンドボックスがサーバー設定 (forceSandbox) で強制されています。通常起動はできません。'
            : sandboxAvailable === false
              ? SANDBOX_UNAVAILABLE_NOTE
              : `サンドボックス: 隣接プロジェクトを隔離し、内部に rootless docker を用意。初期値は一般設定で変更でき、このディレクトリ (${displayPath(currentPath, homeDir)}) に記憶されます。`}
      </p>
    </>
  );

  return (
    <div
      className="directory-browser"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <div className="browser-header">
        <div className="browser-header-title">
          <h1>Select a Directory</h1>
          <p className="subtitle">Choose a working directory</p>
          {sandboxAvailable === false && (
            <div className={`directory-warning-banner${forceSandbox ? ' is-error' : ''}`} role="alert">
              {forceSandbox
                ? FORCE_SANDBOX_UNAVAILABLE_NOTE
                : SANDBOX_UNAVAILABLE_NOTE}
            </div>
          )}
        </div>
      </div>

      <nav className="breadcrumbs">
        <button
          className="breadcrumb-item"
          onClick={() => navigateTo(pathRoot)}
          title={homeBase || undefined}
        >
          {homeBase ? '~' : pathRoot}
        </button>
        {breadcrumbs.map((segment, i) => {
          const sep = homeBase ? '/' : (pathRoot.includes('\\') ? '\\' : '/');
          // Join through the separator too: pathRoot (e.g. the $HOME base
          // "/home/ast", or "/") must not glue onto the first segment --
          // "/home/ast" + "dev" became "/home/astdev".
          const path = [pathRoot, ...breadcrumbs.slice(0, i + 1)].join(sep);
          return (
            <span key={path}>
              <span className="breadcrumb-sep">/</span>
              <button className="breadcrumb-item" onClick={() => navigateTo(path)}>
                {segment}
              </button>
            </span>
          );
        })}
      </nav>

      <div className="browser-toolbar">
        <div className="toolbar-nav">
          <button className="btn btn-secondary" onClick={navigateUp} disabled={!parentPath}>
            Up
          </button>
          {/* browseRoots (issue #189): home() may sit outside the allowed
              roots, where navigating would just 403 -- prefer the server's
              initialBrowsePath (== home() when unrestricted). */}
          <button
            className="btn btn-secondary"
            onClick={() => { const target = initialBrowsePath || homeDir; if (target) navigateTo(target); }}
            disabled={!(initialBrowsePath || homeDir)}
          >
            Home
          </button>
          <button className="btn btn-secondary" onClick={() => { fetchDirs(currentPath); }} disabled={loading}>
            Refresh
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => {
              setCreatingFolder(true);
              setNewFolderName('');
              setInitGit(false);
            }}
            title="Make a directory (optionally as a git repository)"
          >
            New Folder
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
          >
            Upload
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={handleFileInputChange}
            style={{ display: 'none' }}
          />
          <label className="toggle-hidden">
            <input
              type="checkbox"
              checked={showHidden}
              onChange={(e) => setShowHidden(e.target.checked)}
            />
            Show hidden
          </label>
        </div>
        <div className="toolbar-launch-group">
          <button
            className="btn btn-secondary launch-btn"
            onClick={() => onOpenShell(currentPath)}
            disabled={launchesBlocked}
            title={launchesBlocked ? LAUNCHES_BLOCKED_TITLE : ''}
          >
            Terminal
          </button>
          <div className="open-split">
            <button
              className="btn btn-primary open-split-main"
              onClick={() => onOpen(currentPath, { sandbox: sandboxDefault, sandboxOpts: effectiveSandboxOpts, app: appDefault, model: modelForApp(appDefault), permissionMode: permissionModeForApp(appDefault) })}
              disabled={effectiveAppHidden || launchesBlocked}
              title={effectiveAppHidden ? `${APP_LABELS[appDefault] || appDefault}は起動できません (非表示または未インストール)。起動方法を選択してください。` : (launchesBlocked ? LAUNCHES_BLOCKED_TITLE : (sandboxDefault ? 'サンドボックスで起動' : '通常起動'))}
            >
              {sandboxDefault ? '🔒 ' : ''}{appDefault === 'claude' ? 'Claude Code' : appDefault === 'copilot' ? 'GitHub Copilot' : appDefault === 'codex' ? 'OpenAI Codex' : appDefault === 'commandcode' ? 'Command Code' : 'opencode'}
            </button>
            <button
              className="btn btn-primary open-split-caret"
              onClick={() => setOpenMenuOpen(true)}
              title="起動方法を選択"
              aria-label="起動方法を選択"
            >
              &#9662;
            </button>
          </div>
        </div>
      </div>

      {openMenuOpen && (
        // Modal instead of an anchored dropdown: a dropdown positioned off
        // .open-split (position: absolute; right: 0) has no way to know
        // when it no longer fits a narrow viewport, and reliably ran off
        // the right edge on iPhone. A centered, viewport-relative modal
        // (same pattern as the close/resume dialogs below) sidesteps that
        // entirely.
        <div className="resume-overlay" onClick={closeOpenMenu}>
          <div className="resume-dialog open-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>起動方法を選択</h3>
            <div className="launch-mode-toggle">
              <button
                className={`launch-mode-btn${launchMode === 'single' ? ' active' : ''}`}
                onClick={() => setLaunchMode('single')}
              >
                通常起動
              </button>
              <button
                className={`launch-mode-btn${launchMode === 'combo' ? ' active' : ''}`}
                onClick={() => { if (sandboxAvailable === false) return; setLaunchMode('combo'); }}
                disabled={sandboxAvailable === false}
                title={sandboxAvailable === false ? COMBO_UNAVAILABLE_TITLE : ''}
              >
                コンボ起動
              </button>
            </div>

            {launchMode === 'single' ? (
              <>
                <div className="open-menu-label">アプリ</div>
                {visibleApps.map((app) => (
                  <div
                    key={app}
                    className={`open-menu-item${availableApps && !availableApps[app] ? ' open-menu-item-disabled' : ''}`}
                    onClick={() => chooseApp(app)}
                    title={availableApps && !availableApps[app] ? 'サーバーに未インストール' : ''}
                  >
                    <span className="open-menu-check">{appDefault === app ? '✓' : ''}</span>
                    {APP_LABELS[app]}
                  </div>
                ))}
                {modelInputForApp(appDefault) && (
                  <div className="open-menu-model-row">
                    <input
                      type="text"
                      className="open-menu-model-input"
                      placeholder={appDefault === 'codex' ? 'Codexモデル (空=既定)' : 'Command Codeモデル (空=既定)'}
                      value={appDefault === 'codex' ? codexModel : commandcodeModel}
                      onChange={(e) => {
                        if (appDefault === 'codex') { setCodexModel(e.target.value); localStorage.setItem('ccserver-codex-model', e.target.value); }
                        else { setCommandcodeModel(e.target.value); localStorage.setItem('ccserver-commandcode-model', e.target.value); }
                      }}
                      autoComplete="off"
                      autoCorrect="off"
                      spellCheck={false}
                    />
                  </div>
                )}
                {appDefault === 'commandcode' && !effectiveAppHidden && (
                  <>
                    <div className="open-menu-label">許可モード</div>
                    <div className="open-menu-app-row">
                      {PERMISSION_MODES.map((mode) => (
                        <button
                          key={mode}
                          className={`open-menu-app-btn${commandcodePermissionMode === mode ? ' active' : ''}`}
                          onClick={() => choosePermissionMode(mode)}
                          title={mode === 'yolo' ? '--yolo: 全ての許可プロンプトを回避' : mode === 'auto-accept' ? '--auto-accept: 自動承認モードで開始' : '既定の許可プロンプト動作'}
                        >
                          {PERMISSION_MODE_LABELS[mode]}
                        </button>
                      ))}
                    </div>
                    {commandcodePermissionMode === 'yolo' && (
                      <p className="open-menu-note">
                        yolo モード: 全ての許可プロンプトを回避します。破壊的なコマンドも確認なしに実行されるため、信頼できる作業でのみ使ってください。
                      </p>
                    )}
                  </>
                )}
                {sandboxPicker}
              </>
            ) : (
              <>
                <p className="open-menu-note">
                  コンボ起動: 1つのプロジェクトディレクトリで動く2つのワーカーと、
                  それらをMCP経由で操作するオーケストレーターをセットで起動します。
                  全セッション常時サンドボックスです ({displayPath(currentPath, homeDir)})。
                </p>
                {/* Worker presets (shared server-side library). Selected rows
                    are a launch-time snapshot: editing/deleting a preset later
                    never changes them, and launched groups are independent. */}
                {presetsState === 'ready' && (
                  <>
                    <div className="open-menu-label">Worker プリセット</div>
                    <div className="open-menu-presets-row">
                      <select
                        className="open-menu-preset-select"
                        value=""
                        onChange={(e) => { if (e.target.value) addSelectedWorker(e.target.value); }}
                        disabled={selectedWorkers.length >= MAX_COMBO_WORKERS || visibleComboApps.length === 0}
                        title={visibleComboApps.length === 0 ? 'コンボに参加できるアプリ (claude/opencode/codex) がすべて非表示に設定されています' : ''}
                      >
                        <option value="">
                          {visibleComboApps.length === 0
                            ? 'コンボ対応アプリが非表示です'
                            : selectedWorkers.length >= MAX_COMBO_WORKERS ? `上限 (${MAX_COMBO_WORKERS})` : 'プリセットを追加…'}
                        </option>
                        {presets.map((p) => (
                          <option key={p.id} value={p.id} disabled={selectedWorkers.some((r) => r.role === p.role)}>
                            {p.name}（{p.role}）
                          </option>
                        ))}
                      </select>
                      <button type="button" className="btn btn-secondary open-menu-manage-btn" onClick={openPresetManage}>
                        プリセット管理
                      </button>
                    </div>
                    {selectedWorkers.length > 0 && (
                      <div className="open-menu-selected-workers">
                        {selectedWorkers.map((r, i) => (
                          <div key={r.uid} className="open-menu-selected-worker">
                            <span className="open-menu-selected-worker-name" title={r.role}>{r.name}</span>
                            <span className="open-menu-selected-worker-role">{r.role}</span>
                            <span className="open-menu-app-row open-menu-selected-worker-apps">
                              {visibleComboApps.map((app) => (
                                <button
                                  key={app}
                                  type="button"
                                  className={`open-menu-app-btn${r.app === app ? ' active' : ''}${availableApps && !availableApps[app] ? ' open-menu-item-disabled' : ''}`}
                                  onClick={() => {
                                    if (availableApps && !availableApps[app]) return; // server lacks this CLI
                                    updateSelectedWorker(r.uid, { app });
                                  }}
                                  title={availableApps && !availableApps[app] ? 'サーバーに未インストール' : ''}
                                >
                                  {app === 'claude' ? 'Claude Code' : app === 'opencode' ? 'opencode' : 'OpenAI Codex'}
                                </button>
                              ))}
                            </span>
                            <input
                              type="text"
                              className="open-menu-model-input open-menu-selected-worker-model"
                              placeholder="モデル (空=既定)"
                              value={r.model}
                              onChange={(e) => updateSelectedWorker(r.uid, { model: e.target.value })}
                              autoComplete="off"
                              autoCorrect="off"
                              spellCheck={false}
                            />
                            <span className="open-menu-selected-worker-actions">
                              <button type="button" className="btn btn-secondary" onClick={() => moveSelectedWorker(r.uid, -1)} disabled={i === 0} title="上へ">&#8593;</button>
                              <button type="button" className="btn btn-secondary" onClick={() => moveSelectedWorker(r.uid, 1)} disabled={i === selectedWorkers.length - 1} title="下へ">&#8595;</button>
                              <button type="button" className="btn btn-secondary" onClick={() => removeSelectedWorker(r.uid)} title="除去">&#10005;</button>
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
                {presetsState === 'error' && (
                  <p className="open-menu-note">プリセット一覧を取得できませんでした。従来どおりワーカーA/Bを指定して起動できます。</p>
                )}
                {selectedWorkers.length > 0 && (
                  <p className="open-menu-note">
                    プリセットから {selectedWorkers.length} 人追加されています。
                    この場合、下のワーカーA/ワーカーBのドラフトは起動されません（プリセットの選択リストのみが起動します）。
                  </p>
                )}
                <div className="open-menu-label">ワーカーA</div>
                <div className="open-menu-app-row">
                  {visibleComboApps.map((app) => (
                    <button
                      key={app}
                      className={`open-menu-app-btn${comboApps.workerA === app ? ' active' : ''}${availableApps && !availableApps[app] ? ' open-menu-item-disabled' : ''}`}
                      onClick={() => chooseComboApp('workerA', app)}
                      title={availableApps && !availableApps[app] ? 'サーバーに未インストール' : ''}
                    >
                      {app === 'claude' ? 'Claude Code' : app === 'opencode' ? 'opencode' : 'OpenAI Codex'}
                    </button>
                  ))}
                </div>
                <div className="open-menu-model-row">
                  <input
                    type="text"
                    className="open-menu-model-input"
                    placeholder="モデル (空=既定/保存済み設定)"
                    value={comboModels.workerA}
                    onChange={(e) => setComboModels((c) => ({ ...c, workerA: e.target.value }))}
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                </div>
                <div className="open-menu-label">ワーカーB</div>
                <div className="open-menu-app-row">
                  {visibleComboApps.map((app) => (
                    <button
                      key={app}
                      className={`open-menu-app-btn${comboApps.workerB === app ? ' active' : ''}${availableApps && !availableApps[app] ? ' open-menu-item-disabled' : ''}`}
                      onClick={() => chooseComboApp('workerB', app)}
                      title={availableApps && !availableApps[app] ? 'サーバーに未インストール' : ''}
                    >
                      {app === 'claude' ? 'Claude Code' : app === 'opencode' ? 'opencode' : 'OpenAI Codex'}
                    </button>
                  ))}
                </div>
                <div className="open-menu-model-row">
                  <input
                    type="text"
                    className="open-menu-model-input"
                    placeholder="モデル (空=既定/保存済み設定)"
                    value={comboModels.workerB}
                    onChange={(e) => setComboModels((c) => ({ ...c, workerB: e.target.value }))}
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                </div>
                <div className="open-menu-suboptions">
                  <label className="open-menu-suboption">
                    <input
                      type="checkbox"
                      checked={sandboxOpts.gpg}
                      onChange={(e) => updateSandboxOpts(currentPath, { ...sandboxOpts, gpg: e.target.checked })}
                    />
                    GPG署名を使う (両ワーカー共通)
                  </label>
                  <label className="open-menu-suboption">
                    <input
                      type="checkbox"
                      checked={sandboxOpts.sshAgent}
                      onChange={(e) => updateSandboxOpts(currentPath, { ...sandboxOpts, sshAgent: e.target.checked })}
                    />
                    ssh-agentを転送する (両ワーカー共通)
                  </label>
                  <label className={`open-menu-suboption${authMode !== 'passkey' ? ' open-menu-suboption-disabled' : ''}`} title={authMode !== 'passkey' ? 'パスキーログイン限定機能です' : ''}>
                    <input
                      type="checkbox"
                      disabled={authMode !== 'passkey'}
                      checked={authMode !== 'passkey' ? false : sandboxOpts.gpgVault}
                      onChange={(e) => updateSandboxOpts(currentPath, { ...sandboxOpts, gpgVault: e.target.checked })}
                    />
                    GPG Vaultで署名・SSH pushする (両ワーカー共通)
                  </label>
                  <label className={`open-menu-suboption${toolDisabled('rtk') ? ' open-menu-suboption-disabled' : ''}`} title={toolDisabled('rtk') ? TOOL_UNAVAILABLE_NOTE : ''}>
                    <input
                      type="checkbox"
                      disabled={toolDisabled('rtk')}
                      checked={toolDisabled('rtk') ? false : sandboxOpts.tools.rtk}
                      onChange={(e) => updateSandboxOpts(currentPath, { ...sandboxOpts, tools: { ...sandboxOpts.tools, rtk: e.target.checked } })}
                    />
                    rtk を導入する (両ワーカー共通){toolDisabled('rtk') ? `（${TOOL_UNAVAILABLE_NOTE}）` : ''}
                  </label>
                  <label className={`open-menu-suboption${toolDisabled('codeReviewGraph') ? ' open-menu-suboption-disabled' : ''}`} title={toolDisabled('codeReviewGraph') ? TOOL_UNAVAILABLE_NOTE : ''}>
                    <input
                      type="checkbox"
                      disabled={toolDisabled('codeReviewGraph')}
                      checked={toolDisabled('codeReviewGraph') ? false : sandboxOpts.tools.codeReviewGraph}
                      onChange={(e) => updateSandboxOpts(currentPath, { ...sandboxOpts, tools: { ...sandboxOpts.tools, codeReviewGraph: e.target.checked } })}
                    />
                    code-review-graph MCP を導入する (両ワーカー共通){toolDisabled('codeReviewGraph') ? `（${TOOL_UNAVAILABLE_NOTE}）` : ''}
                  </label>
                </div>
                {(['workerA', 'workerB']).map((role) => (
                  <div key={role} className="open-menu-role-sandbox">
                    <label className="open-menu-suboption">
                      <input
                        type="checkbox"
                        checked={comboRoleSandbox[role] !== null}
                        onChange={(e) => setComboRoleSandbox((s) => ({
                          ...s,
                          [role]: e.target.checked ? { ...effectiveSandboxOpts } : null,
                        }))}
                      />
                      {role} のサンドボックスを個別設定
                    </label>
                    {comboRoleSandbox[role] !== null && (
                      <div className="open-menu-suboptions">
                        <label className="open-menu-suboption">
                          <input
                            type="checkbox"
                            checked={comboRoleSandbox[role].gpg}
                            onChange={(e) => setComboRoleSandbox((s) => ({
                              ...s,
                              [role]: { ...s[role], gpg: e.target.checked },
                            }))}
                          />
                          {role} GPG
                        </label>
                        <label className="open-menu-suboption">
                          <input
                            type="checkbox"
                            checked={comboRoleSandbox[role].sshAgent}
                            onChange={(e) => setComboRoleSandbox((s) => ({
                              ...s,
                              [role]: { ...s[role], sshAgent: e.target.checked },
                            }))}
                          />
                          {role} ssh-agent
                        </label>
                        <label className={`open-menu-suboption${authMode !== 'passkey' ? ' open-menu-suboption-disabled' : ''}`} title={authMode !== 'passkey' ? 'パスキーログイン限定機能です' : ''}>
                          <input
                            type="checkbox"
                            disabled={authMode !== 'passkey'}
                            checked={authMode !== 'passkey' ? false : comboRoleSandbox[role].gpgVault}
                            onChange={(e) => setComboRoleSandbox((s) => ({
                              ...s,
                              [role]: { ...s[role], gpgVault: e.target.checked },
                            }))}
                          />
                          {role} GPG Vault
                        </label>
                        <label className={`open-menu-suboption${toolDisabled('rtk') ? ' open-menu-suboption-disabled' : ''}`} title={toolDisabled('rtk') ? TOOL_UNAVAILABLE_NOTE : ''}>
                          <input
                            type="checkbox"
                            disabled={toolDisabled('rtk')}
                            checked={toolDisabled('rtk') ? false : comboRoleSandbox[role].tools.rtk}
                            onChange={(e) => setComboRoleSandbox((s) => ({
                              ...s,
                              [role]: { ...s[role], tools: { ...s[role].tools, rtk: e.target.checked } },
                            }))}
                          />
                          {role} rtk を導入{toolDisabled('rtk') ? `（${TOOL_UNAVAILABLE_NOTE}）` : ''}
                        </label>
                        <label className={`open-menu-suboption${toolDisabled('codeReviewGraph') ? ' open-menu-suboption-disabled' : ''}`} title={toolDisabled('codeReviewGraph') ? TOOL_UNAVAILABLE_NOTE : ''}>
                          <input
                            type="checkbox"
                            disabled={toolDisabled('codeReviewGraph')}
                            checked={toolDisabled('codeReviewGraph') ? false : comboRoleSandbox[role].tools.codeReviewGraph}
                            onChange={(e) => setComboRoleSandbox((s) => ({
                              ...s,
                              [role]: { ...s[role], tools: { ...s[role].tools, codeReviewGraph: e.target.checked } },
                            }))}
                          />
                          {role} code-review-graph MCP を導入{toolDisabled('codeReviewGraph') ? `（${TOOL_UNAVAILABLE_NOTE}）` : ''}
                        </label>
                      </div>
                    )}
                  </div>
                ))}
                <div className="open-menu-label">オーケストレーター</div>
                <div className="open-menu-app-row">
                  {visibleComboApps.map((app) => (
                    <button
                      key={app}
                      className={`open-menu-app-btn${comboApps.orchestrator === app ? ' active' : ''}${availableApps && !availableApps[app] ? ' open-menu-item-disabled' : ''}`}
                      onClick={() => chooseComboApp('orchestrator', app)}
                      title={availableApps && !availableApps[app] ? 'サーバーに未インストール' : ''}
                    >
                      {app === 'claude' ? 'Claude Code' : app === 'opencode' ? 'opencode' : 'OpenAI Codex'}
                    </button>
                  ))}
                </div>
                <div className="open-menu-model-row">
                  <input
                    type="text"
                    className="open-menu-model-input"
                    placeholder="モデル (空=既定/保存済み設定)"
                    value={comboModels.orchestrator}
                    onChange={(e) => setComboModels((c) => ({ ...c, orchestrator: e.target.value }))}
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                </div>
                <div className="open-menu-role-sandbox">
                  <label className="open-menu-suboption">
                    <input
                      type="checkbox"
                      checked={comboRoleSandbox.orchestrator !== null}
                      onChange={(e) => setComboRoleSandbox((s) => ({
                        ...s,
                        orchestrator: e.target.checked ? { ...effectiveSandboxOpts } : null,
                      }))}
                    />
                    オーケストレーターのサンドボックスを個別設定
                  </label>
                  {comboRoleSandbox.orchestrator !== null && (
                    <div className="open-menu-suboptions">
                      <label className="open-menu-suboption">
                        <input
                          type="checkbox"
                          checked={comboRoleSandbox.orchestrator.gpg}
                          onChange={(e) => setComboRoleSandbox((s) => ({
                            ...s,
                            orchestrator: { ...s.orchestrator, gpg: e.target.checked },
                          }))}
                        />
                        オーケストレーター GPG
                      </label>
                      <label className="open-menu-suboption">
                        <input
                          type="checkbox"
                          checked={comboRoleSandbox.orchestrator.sshAgent}
                          onChange={(e) => setComboRoleSandbox((s) => ({
                            ...s,
                            orchestrator: { ...s.orchestrator, sshAgent: e.target.checked },
                          }))}
                        />
                        オーケストレーター ssh-agent
                      </label>
                      <label className={`open-menu-suboption${authMode !== 'passkey' ? ' open-menu-suboption-disabled' : ''}`} title={authMode !== 'passkey' ? 'パスキーログイン限定機能です' : ''}>
                        <input
                          type="checkbox"
                          disabled={authMode !== 'passkey'}
                          checked={authMode !== 'passkey' ? false : comboRoleSandbox.orchestrator.gpgVault}
                          onChange={(e) => setComboRoleSandbox((s) => ({
                            ...s,
                            orchestrator: { ...s.orchestrator, gpgVault: e.target.checked },
                          }))}
                        />
                        オーケストレーター GPG Vault
                      </label>
                      <label className={`open-menu-suboption${toolDisabled('rtk') ? ' open-menu-suboption-disabled' : ''}`} title={toolDisabled('rtk') ? TOOL_UNAVAILABLE_NOTE : ''}>
                        <input
                          type="checkbox"
                          disabled={toolDisabled('rtk')}
                          checked={toolDisabled('rtk') ? false : comboRoleSandbox.orchestrator.tools.rtk}
                          onChange={(e) => setComboRoleSandbox((s) => ({
                            ...s,
                            orchestrator: { ...s.orchestrator, tools: { ...s.orchestrator.tools, rtk: e.target.checked } },
                          }))}
                        />
                        オーケストレーター rtk を導入{toolDisabled('rtk') ? `（${TOOL_UNAVAILABLE_NOTE}）` : ''}
                      </label>
                      <label className={`open-menu-suboption${toolDisabled('codeReviewGraph') ? ' open-menu-suboption-disabled' : ''}`} title={toolDisabled('codeReviewGraph') ? TOOL_UNAVAILABLE_NOTE : ''}>
                        <input
                          type="checkbox"
                          disabled={toolDisabled('codeReviewGraph')}
                          checked={toolDisabled('codeReviewGraph') ? false : comboRoleSandbox.orchestrator.tools.codeReviewGraph}
                          onChange={(e) => setComboRoleSandbox((s) => ({
                            ...s,
                            orchestrator: { ...s.orchestrator, tools: { ...s.orchestrator.tools, codeReviewGraph: e.target.checked } },
                          }))}
                        />
                        オーケストレーター code-review-graph MCP を導入{toolDisabled('codeReviewGraph') ? `（${TOOL_UNAVAILABLE_NOTE}）` : ''}
                      </label>
                    </div>
                  )}
                </div>
                <p className="open-menu-note">
                  オーケストレーターは専用の隔離ディレクトリで動作し、プロジェクトへの
                  直接アクセスはありません。操作はすべてMCPツール経由です。
                </p>
                <div className="open-menu-label">オーケストレーターへの指示</div>
                <textarea
                  className="open-menu-instructions"
                  placeholder="既定テンプレートに追記されます（空欄でもテンプレートは常に適用されます）。オーケストレーター自身はこの内容を書き換えられません。"
                  value={orchestratorInstructions}
                  onChange={(e) => setOrchestratorInstructions(e.target.value)}
                  rows={5}
                />
              </>
            )}

            <div className="resume-actions">
              <button className="btn btn-secondary" onClick={closeOpenMenu}>キャンセル</button>
              {launchMode === 'combo' ? (
                <button
                  className="btn btn-primary"
                  disabled={comboHasHiddenAppSelected || sandboxAvailable === false}
                  title={sandboxAvailable === false ? COMBO_UNAVAILABLE_TITLE : (comboHasHiddenAppSelected ? '非表示に設定されたアプリが選択されています。ロールのアプリを選び直してください。' : '')}
                  onClick={() => {
                    // Build the payload BEFORE closing the menu: closeOpenMenu
                    // resets the draft model/sandbox state, and React state
                    // reads inside this handler only see the pre-update
                    // values. Only send options the user explicitly chose: an
                    // empty model is omitted (server falls back to the
                    // persisted role preference), and a null per-role sandbox
                    // means "inherit the group-level flags". `app` is always
                    // sent because it's a required choice in this UI.
                    const roleSpec = (role) => {
                      const spec = { app: comboApps[role] };
                      if (comboModels[role].trim()) spec.model = comboModels[role].trim();
                      if (comboRoleSandbox[role]) spec.sandboxOpts = sanitizeSandboxOpts(comboRoleSandbox[role], toolsAvailable);
                      return spec;
                    };
                    // Preset selections win: they launch as a canonical
                    // workers[] snapshot (name/role/app/model copied now --
                    // the server never re-reads the preset, so editing or
                    // deleting it cannot TOCTOU a running launch). With no
                    // selection, the legacy workerA/workerB payload keeps
                    // working exactly as before.
                    const cfg = selectedWorkers.length > 0
                      ? {
                          workers: selectedWorkers.map((r) => ({
                            name: r.name,
                            role: r.role,
                            app: r.app,
                            model: r.model.trim() ? r.model.trim() : null,
                          })),
                          orchestrator: { ...roleSpec('orchestrator'), instructions: orchestratorInstructions },
                          sandboxOpts: effectiveSandboxOpts,
                        }
                      : {
                          workerA: roleSpec('workerA'),
                          workerB: roleSpec('workerB'),
                          orchestrator: { ...roleSpec('orchestrator'), instructions: orchestratorInstructions },
                          sandboxOpts: effectiveSandboxOpts,
                        };
                    onOpenCombo(currentPath, cfg);
                    closeOpenMenu();
                  }}
                >
                  コンボ起動
                </button>
              ) : (
                <button
                  className="btn btn-primary"
                  onClick={() => { closeOpenMenu(); onOpen(currentPath, { sandbox: sandboxDefault, sandboxOpts: effectiveSandboxOpts, app: appDefault, model: modelForApp(appDefault), permissionMode: permissionModeForApp(appDefault) }); }}
                  disabled={effectiveAppHidden || launchesBlocked}
                  title={effectiveAppHidden ? `${APP_LABELS[appDefault] || appDefault}は起動できません (非表示または未インストール)` : (launchesBlocked ? LAUNCHES_BLOCKED_TITLE : '')}
                >
                  起動
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {openMenuOpen && manageOpen && (
        // Preset management dialog: stacked above the launch modal's own
        // overlay. CRUD here only affects the shared library and future
        // launches -- already-selected rows and running groups are snapshots.
        <div className="resume-overlay preset-manage-overlay" onClick={() => setManageOpen(false)}>
          <div className="resume-dialog preset-manage-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Worker プリセット管理">
            <h3>Worker プリセット管理</h3>
            <div className="preset-manage-list">
              {presets.length === 0 && (
                <div className="preset-manage-empty">プリセットはまだありません。最初の1件を作成してください。</div>
              )}
              {presets.map((p) => (
                <div key={p.id} className={`preset-manage-item${editingPresetId === p.id ? ' editing' : ''}`}>
                  <span className="preset-manage-item-name" title={p.name}>{p.name}</span>
                  <span className="preset-manage-item-role">{p.role}</span>
                  <span className="preset-manage-item-meta">
                    {COMBO_WORKER_APPS.includes(p.app) ? (p.app === 'claude' ? 'Claude Code' : p.app === 'opencode' ? 'opencode' : 'OpenAI Codex') : p.app}
                    {p.model ? ` · ${p.model}` : ''}
                  </span>
                  <button type="button" className="btn btn-secondary" onClick={() => startEditPreset(p)}>編集</button>
                  <button type="button" className="btn btn-secondary preset-manage-delete" onClick={() => deletePreset(p)}>削除</button>
                </div>
              ))}
            </div>
            <div className="preset-manage-form">
              <h4>{editingPresetId ? 'プリセットを編集' : '新規プリセット'}</h4>
              <label className="preset-form-row">
                <span>表示名</span>
                <input
                  type="text"
                  value={presetForm.name}
                  onChange={(e) => setPresetForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="例: 実装担当"
                  maxLength={80}
                  autoComplete="off"
                />
              </label>
              <label className="preset-form-row">
                <span>ロール</span>
                <input
                  type="text"
                  value={presetForm.role}
                  onChange={(e) => setPresetForm((f) => ({ ...f, role: e.target.value }))}
                  placeholder="workerImplement の形 (workerで始まる識別子)"
                  maxLength={80}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <div className="preset-form-row">
                <span>アプリ</span>
                <div className="open-menu-app-row">
                  {visibleComboApps.map((app) => (
                    <button
                      key={app}
                      type="button"
                      className={`open-menu-app-btn${presetForm.app === app ? ' active' : ''}${availableApps && !availableApps[app] ? ' open-menu-item-disabled' : ''}`}
                      onClick={() => {
                        if (availableApps && !availableApps[app]) return; // server lacks this CLI
                        setPresetForm((f) => ({ ...f, app }));
                      }}
                      title={availableApps && !availableApps[app] ? 'サーバーに未インストール' : ''}
                    >
                      {app === 'claude' ? 'Claude Code' : app === 'opencode' ? 'opencode' : 'OpenAI Codex'}
                    </button>
                  ))}
                </div>
              </div>
              <label className="preset-form-row">
                <span>モデル</span>
                <input
                  type="text"
                  value={presetForm.model}
                  onChange={(e) => setPresetForm((f) => ({ ...f, model: e.target.value }))}
                  placeholder="空 = アプリ既定"
                  maxLength={200}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              {presetFormError && <div className="preset-form-error">{presetFormError}</div>}
              <div className="resume-actions preset-form-actions">
                <button type="button" className="btn btn-primary" onClick={savePreset}>
                  {editingPresetId ? '更新して保存' : '作成'}
                </button>
                {editingPresetId && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => { setEditingPresetId(null); setPresetForm({ name: '', role: '', app: 'claude', model: '' }); setPresetFormError(null); }}
                  >
                    新規作成に切替
                  </button>
                )}
              </div>
            </div>
            <div className="resume-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setManageOpen(false)}>閉じる</button>
            </div>
          </div>
        </div>
      )}

      {uploadProgress && (
        <div className="upload-progress">{uploadProgress}</div>
      )}

      {creatingFolder && (
        <div className="new-folder-bar">
          <input
            type="text"
            className="new-folder-input"
            placeholder="Folder name"
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreateFolder();
              if (e.key === 'Escape') closeFolderForm();
            }}
            autoFocus
          />
          <label className="new-folder-git-check" title="Create a git repository in the new folder (needed for combo worktree isolation)">
            <input type="checkbox" checked={initGit} onChange={(e) => setInitGit(e.target.checked)} />
            git init
          </label>
          <button className="btn btn-primary" onClick={handleCreateFolder}>
            Create
          </button>
          <button className="btn btn-secondary" onClick={closeFolderForm}>
            Cancel
          </button>
        </div>
      )}

      <div className={`dir-list${dragOver ? ' drag-over' : ''}`}>
        {loading && <div className="loading">Loading...</div>}
        {error && <div className="error">Error: {error}</div>}
        {!loading && !error && dirs.length === 0 && files.length === 0 && (
          <div className="empty">No entries</div>
        )}
        {!loading &&
          !error &&
          dirs.map((dir) => (
            <div
              key={dir.path}
              className="dir-item"
              onClick={() => navigateTo(dir.path)}
              onDoubleClick={() => {
                if (launchesBlocked) return; // fail-closed UI: no launch can succeed
                onOpen(dir.path, {
                  sandbox: sandboxDefault,
                  sandboxOpts: sanitizeSandboxOpts(loadSandboxOpts(dir.path, sandboxDefaults), toolsAvailable),
                  app: appDefault,
                  model: modelForApp(appDefault),
                  permissionMode: permissionModeForApp(appDefault),
                });
              }}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter') navigateTo(dir.path);
              }}
            >
              <span className="dir-icon">&#128193;</span>
              <span className="dir-name">{dir.name}</span>
            </div>
          ))}
        {!loading &&
          !error &&
          files.map((file) => (
            <div key={file.path} className="file-item">
              {isPreviewable(file.name) ? (
                // Preview and download are sibling <button>s: real buttons get
                // Enter/Space and focus for free, and nothing interactive nests.
                <button
                  type="button"
                  className="file-open-btn"
                  onClick={() => setPreviewFile(file)}
                  title={`Preview ${file.name}`}
                >
                  <span className="file-icon">&#128196;</span>
                  <span className="file-name">{file.name}</span>
                  <span className="file-size">{formatSize(file.size)}</span>
                </button>
              ) : (
                <span className="file-label">
                  <span className="file-icon">&#128196;</span>
                  <span className="file-name">{file.name}</span>
                  <span className="file-size">{formatSize(file.size)}</span>
                </span>
              )}
              <button
                type="button"
                className="btn btn-secondary file-download-btn"
                onClick={() => handleDownload(file)}
                title="Download"
                aria-label={`Download ${file.name}`}
              >
                &#8595;
              </button>
            </div>
          ))}
      </div>

      {previewFile && (
        <Suspense fallback={null}>
          <FilePreview file={previewFile} onClose={closePreview} onDownload={handleDownload} />
        </Suspense>
      )}

      {dragOver && (
        <div className="drag-overlay">
          <div className="drag-overlay-text">Drop files to upload</div>
        </div>
      )}
    </div>
  );
}
