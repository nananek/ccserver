// Shared tab-icon rendering for the top-level tab bar (App.jsx) and the group
// sub-tab bar (GroupTabView.jsx): one helper so the per-app/per-kind glyphs
// can't drift between the two. Mirrors the original inline App.jsx conditions
// exactly -- including a shell tab that also carries an app label rendering
// both icons (the pre-refactor behavior).
const shellIcon = <svg className="tab-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3.5 5l4 3-4 3"/><path d="M8.5 12h4"/></svg>;
const opencodeIcon = <svg className="tab-icon" viewBox="0 0 16 16" fill="currentColor"><path fillRule="evenodd" d="M4 3h8v10H4V3zm7 1H5v8h6V4z"/><path opacity="0.45" d="M6 7h4v4H6V7z"/></svg>;
const claudeIcon = <svg className="tab-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M8 2v12M3.2 5l9.6 6M12.8 5l-9.6 6"/></svg>;

export default function TabIcon({ type, app, shell }) {
  if (type === 'browser') {
    return <svg className="tab-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M2 3.5A1.5 1.5 0 013.5 2h3l1.5 2h4.5A1.5 1.5 0 0114 5.5v7a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 12.5z"/></svg>;
  }
  if (type === 'monitor') {
    return <svg className="tab-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="12" height="10" rx="1.5"/><path d="M5 14h6M8 12v2M4.5 8.5V9M6.5 6.5V9M8.5 5V9M10.5 7V9"/></svg>;
  }
  if (type === 'group') {
    return <svg className="tab-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><rect x="1.5" y="2.5" width="5" height="4.5" rx="1"/><rect x="9.5" y="2.5" width="5" height="4.5" rx="1"/><rect x="1.5" y="9.5" width="5" height="4" rx="1"/><rect x="9.5" y="9.5" width="5" height="4" rx="1"/></svg>;
  }
  if (type === 'terminal') {
    const icons = [];
    if (shell) icons.push(shellIcon);
    if (app === 'opencode') icons.push(opencodeIcon);
    if (app === 'claude' && !shell) icons.push(claudeIcon);
    return <>{icons}</>;
  }
  return null;
}
