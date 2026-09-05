// Whether `app` can actually be launched right now: installed on this host
// (or availableApps not fetched yet, in which case nothing is disabled --
// the old-server / not-yet-loaded fallback) AND not hidden via
// sandbox.config.json's hiddenApps (issue #105). Shared by every
// picker/predicate that needs this definition (App.jsx's Usage-button
// visibility, UsageButton's own tab picker, DirectoryBrowser's launch
// pickers, MetaLaunchDialog's app picker) so "installed AND not hidden"
// can't drift between them.
export function isAppSelectable(app, availableApps, hiddenApps) {
  if (hiddenApps && hiddenApps.includes(app)) return false;
  return !availableApps || availableApps[app] !== false;
}
