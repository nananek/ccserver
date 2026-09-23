// Presentation for a session's activity level (server/ws/activity.js decides
// the level; this only says how to draw it). Shared by the session list and
// the combo group's sub-tab bar so the two can't drift apart -- the same
// pattern as gpgVaultBadge.js and SessionList's appLabel.
//
// Colour never carries the state on its own:
//   - each level has its own SHAPE (hollow / half-filled / filled dot), so it
//     survives a colour-blind viewer and a monochrome screenshot;
//   - each level has its own WORDS, which go into the row's aria-label (for
//     screen readers) and its title (for everyone else).
// Green-for-free / red-for-busy is also the opposite of the usual
// green-means-good reading, which is another reason the words matter.

const LEVELS = {
  idle: {
    className: 'is-idle',
    // "待機中" rather than "アイドル": the useful fact is that the agent is
    // waiting for YOU, not that it is doing nothing.
    label: '待機中',
    detail: '入力待ち',
  },
  low: {
    className: 'is-low',
    label: '低活動',
    detail: '稼働中だが画面はほとんど動いていない',
  },
  busy: {
    className: 'is-busy',
    label: '稼働中',
    detail: '出力が流れている',
  },
};

// Why the level came out that way, for the tooltip. Keeping this visible
// makes the thresholds tunable from real use instead of from guesses.
const REASONS = {
  marker: '稼働中の表示を検出',
  movement: '画面が更新されている',
  quiet: '画面が静止している',
};

export function activityLabel(level) {
  return LEVELS[level]?.label ?? null;
}

// Everything the UI needs for one session, or null when there is nothing to
// show (no live session, an exited one, or a plain shell -- the server
// reports level null for all three rather than guessing).
export function activityInfo(activity) {
  const level = activity?.level;
  const spec = LEVELS[level];
  if (!spec) return null;

  const parts = [`${spec.label} — ${spec.detail}`];
  const reason = REASONS[activity.reason];
  if (reason) parts.push(reason);
  if (typeof activity.changeRate === 'number' && activity.changeRate > 0) {
    parts.push(`画面更新 ${activity.changeRate} 行/秒`);
  }
  // An app whose "working" frame nobody has captured is judged from screen
  // movement alone. Say so rather than presenting it with the same
  // confidence as a marker-backed reading.
  if (activity.markerVerified === false) {
    parts.push('※ このCLIは稼働中表示が未検証のため、画面の動きだけで判定しています');
  }

  return {
    level,
    className: spec.className,
    label: spec.label,
    title: parts.join(' / '),
    // Appended to the row's own aria-label, which already names the session.
    ariaText: spec.label,
    // Marker-backed or movement-only. The dot is drawn slightly muted for
    // the latter -- enough to notice next to a confident one, not enough to
    // make those tabs look permanently suspect. The level itself is still
    // shown at full strength; only the certainty is hedged.
    verified: activity.markerVerified !== false,
  };
}
