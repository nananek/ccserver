// Shared tab-icon rendering for the top-level tab bar (App.jsx) and the group
// sub-tab bar (GroupTabView.jsx): one helper so the per-app/per-kind glyphs
// can't drift between the two. Mirrors the original inline App.jsx conditions
// exactly -- including a shell tab that also carries an app label rendering
// both icons (the pre-refactor behavior).
const shellIcon = <svg className="tab-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3.5 5l4 3-4 3"/><path d="M8.5 12h4"/></svg>;
const opencodeIcon = <svg className="tab-icon" viewBox="0 0 16 16" fill="currentColor"><path fillRule="evenodd" d="M4 3h8v10H4V3zm7 1H5v8h6V4z"/><path opacity="0.45" d="M6 7h4v4H6V7z"/></svg>;
const claudeIcon = <svg className="tab-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M8 2v12M3.2 5l9.6 6M12.8 5l-9.6 6"/></svg>;
// GitHub Copilot: a robot head (circle + antenna + eyes), stroke style
// matching the other app icons.
const copilotIcon = <svg className="tab-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M8 2.5v2"/><path d="M4.5 5h7"/><circle cx="8" cy="9.5" r="4"/><path d="M5.8 8.2h.01M10.2 8.2h.01"/><path d="M5.8 11c1.2 1.1 3.2 1.1 4.4 0"/></svg>;
const codexIcon = <svg className="tab-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M3 4.5 8 2l5 2.5v7L8 14l-5-2.5z"/><path d="m3 4.5 5 2.7 5-2.7M8 7.2V14"/></svg>;
const commandcodeIcon = <svg className="tab-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="m3 5 4 3-4 3M9 11h4"/><path d="M2 3h12v10H2z"/></svg>;
// Meta agent: a key -- the session carries the privileged ccserver-meta MCP.
const metaIcon = <svg className="tab-icon tab-icon-meta" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><circle cx="5" cy="11" r="3"/><path d="M7.2 8.8 13.5 2.5"/><path d="M10.8 5.2l2.2 2.2"/><path d="M13.5 2.5V5"/></svg>;

export default function TabIcon({ type, app, shell, isMetaAgent }) {
  if (type === 'browser') {
    return <svg className="tab-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M2 3.5A1.5 1.5 0 013.5 2h3l1.5 2h4.5A1.5 1.5 0 0114 5.5v7a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 12.5z"/></svg>;
  }
  if (type === 'monitor') {
    return <svg className="tab-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="12" height="10" rx="1.5"/><path d="M5 14h6M8 12v2M4.5 8.5V9M6.5 6.5V9M8.5 5V9M10.5 7V9"/></svg>;
  }
  if (type === 'settings') {
    return <svg className="tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>;
  }
  // Cross-instance federation (plan Phase 1): two linked nodes, for the
  // top-level "Remote" tab. A remote terminal tab itself just gets the usual
  // per-app icon below, with its label carrying a "⇄ " prefix (see App.jsx's
  // openRemoteTerminalTab) -- the same convention shell ("$ ") and
  // meta-agent ("⌘ ") tabs already use instead of a distinct icon.
  if (type === 'remote') {
    return <svg className="tab-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><circle cx="4" cy="4" r="2"/><circle cx="12" cy="12" r="2"/><path d="M5.4 5.4l5.2 5.2"/></svg>;
  }
  if (type === 'group') {
    return <svg className="tab-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><rect x="1.5" y="2.5" width="5" height="4.5" rx="1"/><rect x="9.5" y="2.5" width="5" height="4.5" rx="1"/><rect x="1.5" y="9.5" width="5" height="4" rx="1"/><rect x="9.5" y="9.5" width="5" height="4" rx="1"/></svg>;
  }
  if (type === 'terminal') {
    const icons = [];
    if (isMetaAgent) icons.push(metaIcon);
    if (shell) icons.push(shellIcon);
    if (app === 'opencode') icons.push(opencodeIcon);
    if (app === 'copilot') icons.push(copilotIcon);
    if (app === 'codex') icons.push(codexIcon);
    if (app === 'commandcode') icons.push(commandcodeIcon);
    if (app === 'claude' && !shell) icons.push(claudeIcon);
    return <>{icons}</>;
  }
  return null;
}
