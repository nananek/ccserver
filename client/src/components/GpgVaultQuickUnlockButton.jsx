import { useState, useCallback } from 'react';
import { useGpgVaultStatusContext } from './GpgVaultStatusProvider.jsx';
import { runGpgVaultStepUp } from '../gpgVaultStepUp.js';

// Top-bar shortcut for the common "vault exists but is locked, sandbox
// launch just failed with SPAWN_FAILED" moment -- reaching Settings > GPG連携
// for this one action was the UX complaint this button addresses. Renders
// nothing once the vault doesn't exist yet (nothing to unlock) or is already
// unlocked.
export default function GpgVaultQuickUnlockButton() {
  const vault = useGpgVaultStatusContext();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const handleUnlock = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await runGpgVaultStepUp({ optionsUrl: '/api/gpg-vault/unlock-options', verifyUrl: '/api/gpg-vault/unlock-verify' });
      await vault?.refresh();
    } catch (err) {
      setError(err.message || 'アンロックに失敗しました');
    } finally {
      setBusy(false);
    }
  }, [busy, vault]);

  if (!vault?.data?.exists || vault.data.unlocked) return null;

  // セキュリティ監査 F1.4: 修正前に作成されたVaultは無効化されており、
  // アンロックはできない。アンロックボタンの位置に警告を出して、設定画面での
  // 削除・再作成を促す。
  if (vault.data.legacyDisabled) {
    const message = 'GPG Vaultは修正前に作成されたため無効化されています (秘密鍵が漏洩した可能性があります)。'
      + '設定 > GPG連携 から削除して再作成してください。';
    return (
      <button
        type="button"
        className="btn gpg-vault-unlock-btn"
        onClick={() => window.alert(message)}
        title={message}
        aria-label="GPG Vaultは無効化されています"
      >
        ⚠️ GPG Vault 無効 (要再作成)
      </button>
    );
  }

  return (
    <button
      type="button"
      className="btn gpg-vault-unlock-btn"
      onClick={handleUnlock}
      disabled={busy}
      title={error || (busy ? 'アンロック中…' : 'GPG Vaultをアンロック')}
      aria-label="GPG Vaultをアンロック"
    >
      🔑 {busy ? 'アンロック中…' : 'Unlock GPG Vault'}
    </button>
  );
}
