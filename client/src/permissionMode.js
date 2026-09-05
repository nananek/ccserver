// Mirrors server/ws/appLaunch.js's PERMISSION_MODES -- client (vite bundle)
// and server (node) ship separately, so this is kept in sync by hand, same
// as ALL_APPS in DirectoryBrowser.jsx duplicates appLaunch.js's APPS. Shared
// by every picker/badge that needs the mode list, labels, or "is this an
// elevated (permission-bypassing) mode" check, so they can't drift apart
// (see PR#108 review).
export const PERMISSION_MODES = ['standard', 'auto-accept', 'yolo'];

export const PERMISSION_MODE_LABELS = { standard: '標準', 'auto-accept': '自動承認', yolo: 'yolo' };

export function isElevatedPermissionMode(mode) {
  return mode === 'yolo' || mode === 'auto-accept';
}
