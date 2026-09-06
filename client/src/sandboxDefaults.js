// サンドボックス起動フラグ (gpg / sshAgent / rtk / code-review-graph) の
// グローバル既定値。Settings > 一般から変更でき、localStorage に永続化される。
// ディレクトリ別記憶 (ccserver-sandbox-opts:<path>) が無い場合の
// フォールバックとしてのみ使われ、既存の記憶は上書きしない。

export const SANDBOX_DEFAULT_GPG_KEY = 'ccserver-default-sandbox-gpg';
export const SANDBOX_DEFAULT_SSH_AGENT_KEY = 'ccserver-default-sandbox-ssh-agent';
export const SANDBOX_DEFAULT_RTK_KEY = 'ccserver-default-sandbox-rtk';
export const SANDBOX_DEFAULT_CRG_KEY = 'ccserver-default-sandbox-code-review-graph';

// すべて既定オフ。ツール導入は初回コスト (ダウンロード・pip) がかかるため
// 明示のオプトインとする。
export const SANDBOX_DEFAULTS = {
  gpg: false,
  sshAgent: false,
  rtk: false,
  codeReviewGraph: false,
};

function loadFlag(key, defaultValue) {
  try {
    const v = localStorage.getItem(key);
    if (v === null) return defaultValue;
    return v === '1';
  } catch {
    return defaultValue;
  }
}

export function loadSandboxDefaults() {
  return {
    gpg: loadFlag(SANDBOX_DEFAULT_GPG_KEY, SANDBOX_DEFAULTS.gpg),
    sshAgent: loadFlag(SANDBOX_DEFAULT_SSH_AGENT_KEY, SANDBOX_DEFAULTS.sshAgent),
    rtk: loadFlag(SANDBOX_DEFAULT_RTK_KEY, SANDBOX_DEFAULTS.rtk),
    codeReviewGraph: loadFlag(SANDBOX_DEFAULT_CRG_KEY, SANDBOX_DEFAULTS.codeReviewGraph),
  };
}

export function saveSandboxDefaults(next) {
  try {
    localStorage.setItem(SANDBOX_DEFAULT_GPG_KEY, next.gpg ? '1' : '0');
    localStorage.setItem(SANDBOX_DEFAULT_SSH_AGENT_KEY, next.sshAgent ? '1' : '0');
    localStorage.setItem(SANDBOX_DEFAULT_RTK_KEY, next.rtk ? '1' : '0');
    localStorage.setItem(SANDBOX_DEFAULT_CRG_KEY, next.codeReviewGraph ? '1' : '0');
  } catch {
    // ignore (private mode etc.)
  }
}

// グローバル既定値 (flat) から per-launch sandboxOpts 形状へ変換する。
export function defaultSandboxOpts(defaults = SANDBOX_DEFAULTS) {
  return {
    gpg: !!defaults.gpg,
    sshAgent: !!defaults.sshAgent,
    tools: {
      rtk: !!defaults.rtk,
      codeReviewGraph: !!defaults.codeReviewGraph,
    },
  };
}
