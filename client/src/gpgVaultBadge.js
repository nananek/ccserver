// Shared by TerminalView.jsx (open tab header) and SessionList.jsx (sidebar,
// open + unopened sessions) -- one judgment so the two can't drift.
//
// Thanks to server/ws/gpgVaultRelay.js (an already-running gpgVault:true
// sandbox transparently reconnects to whichever vault generation is
// CURRENTLY unlocked, on its next signing/push attempt), "active" here
// genuinely means "will work right now", not just "was requested at
// launch" -- no need to compare unlock generations/timestamps client-side.
//
// session: { gpgVaultActive } -- from the WS `session` message
//          (TerminalView.jsx) or a GET /api/sessions element (SessionList.jsx).
// vaultStatus: useGpgVaultStatusContext().data (null = not yet loaded).
// Returns null (render nothing) or { state: 'active'|'inactive', reason }.
export function gpgVaultBadgeState(session, vaultStatus) {
  if (!vaultStatus?.exists) return null; // no vault at all: nothing to show
  if (!session?.gpgVaultActive) {
    return { state: 'inactive', reason: 'このセッションはGPGボルトなしで起動されました' };
  }
  if (!vaultStatus.unlocked) {
    return { state: 'inactive', reason: 'GPGボルトは現在ロックされています(署名/SSH pushは失敗します)' };
  }
  return { state: 'active', reason: 'GPGボルト有効 — コミット署名・SSH pushに使用できます' };
}
