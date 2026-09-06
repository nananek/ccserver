import { useState, useEffect, useRef } from 'react';

// セッション名の編集ダイアログ。既存 resume-dialog パターンを流用する。
// 空のまま保存すると名前をクリアする (サーバー側の空=クリア仕様と一致)。
export default function SessionRenameDialog({ initialName, onSubmit, onClose }) {
  const [value, setValue] = useState(initialName || '');
  const [error, setError] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleSubmit = (e) => {
    e.preventDefault();
    const trimmed = value.replace(/[\u0000-\u001F\u007F\u0080-\u009F\u2028\u2029]/g, '').trim();
    if ([...trimmed].length > 64) {
      setError('名前は64文字以内で入力してください');
      return;
    }
    onSubmit?.(trimmed);
  };

  return (
    <div className="resume-overlay" onClick={onClose}>
      <div className="resume-dialog" role="dialog" aria-label="セッション名を設定" onClick={(e) => e.stopPropagation()}>
        <h3>セッション名を設定</h3>
        <form onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            type="text"
            className="session-rename-input"
            value={value}
            maxLength={64}
            placeholder="名前を入力 (空でクリア)"
            aria-label="セッション名"
            onChange={(e) => { setValue(e.target.value); setError(''); }}
          />
          {error && <p className="sandbox-prompt-warn">{error}</p>}
          <div className="resume-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              キャンセル
            </button>
            <button type="submit" className="btn btn-primary">
              保存
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
