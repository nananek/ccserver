// Whether `app` can actually be launched right now: installed on this host
// (or availableApps not fetched yet, in which case nothing is disabled --
// the old-server / not-yet-loaded fallback) AND not hidden via
// sandbox.config.json's hiddenApps (issue #105). Shared by every
// picker/predicate that needs this definition (App.jsx's UsageWidget
// visibility, UsageWidget's own tab picker, DirectoryBrowser's launch
// pickers, MetaLaunchDialog's app picker) so "installed AND not hidden"
// can't drift between them.
export function isAppSelectable(app, availableApps, hiddenApps) {
  if (hiddenApps && hiddenApps.includes(app)) return false;
  return !availableApps || availableApps[app] !== false;
}

// Whether `app` should show up in a picker/tab list, covering opencode Go's
// special rule on top of isAppSelectable's claude/codex rule. Shared by
// App.jsx's UsageWidget visibility and UsageWidget's own tab picker so the
// two definitions can't drift (previously duplicated in each file).
//
// opencode Go is NOT the opencode CLI install flag (a Go subscription needs
// no binary): hidden via hiddenApps 'opencode' (issue #105), else toggle on +
// Go API key present, reported as availableApps.opencodeGo. Whole object
// missing (fetch pending/failed) -> assume visible, the pre-existing loading
// convention. But a PRESENT object without the opencodeGo key means an older
// server that predates Go support entirely: the Go tab must stay hidden
// there (old servers ignore ?app=opencode and would serve Claude data under
// the (opencode) badge). New servers always send the key (see routes/dirs.js).
export function isAppVisible(app, availableApps, hiddenApps) {
  if (app === 'opencode') {
    if (hiddenApps?.includes('opencode')) return false;
    if (!availableApps) return true;
    return availableApps.opencodeGo === true;
  }
  return isAppSelectable(app, availableApps, hiddenApps);
}
