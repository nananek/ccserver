// localStorage に保存された列挙型プリファレンスの共通読み取り。
// useWidgetPrefs.js の loadWidgetOption / useSessionSidebarPrefs.js の loadMode と
// 同じ「読み取り→許可値検証→フォールバック」パターンの一本化。
// 未知の値 (古いビルドの保存値・手書き) は fallback に倒す。

// choices: [{ value, ... }] またはプリミティブ値の配列のいずれかを受け付ける。
export function isValidChoice(choices, v) {
  return choices.some((c) =>
    c != null && typeof c === 'object' && 'value' in c ? c.value === v : c === v
  );
}

export function loadEnumPref(key, choices, fallback) {
  try {
    const v = localStorage.getItem(key);
    return isValidChoice(choices, v) ? v : fallback;
  } catch {
    return fallback;
  }
}
