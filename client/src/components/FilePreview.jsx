import { useState, useEffect } from 'react';
import { authFetch } from '../auth.js';
import { formatSize } from '../formatSize.js';
import PreviewDialog from './PreviewDialog.jsx';

// UTF-8 byte length of a JS string (TextEncoder is universal in browsers;
// Buffer is not).
function utf8ByteLength(str) {
  return new TextEncoder().encode(str).length;
}

/**
 * Modal viewer for a text or markdown file in the directory browser. Fetches
 * `/api/files/content` and renders the result through PreviewDialog (dialog
 * chrome, focus trap, Rendered/Source toggle, sanitized markdown all live
 * there).
 * @param {{ file: { name: string, path: string, size?: number }, onClose: () => void, onDownload: (file: object) => void }} props
 */
export default function FilePreview({ file, onClose, onDownload }) {
  const [state, setState] = useState({ status: 'loading', data: null, error: null });
  const [showSource, setShowSource] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading', data: null, error: null });
    setShowSource(false);
    (async () => {
      try {
        const params = new URLSearchParams({ path: file.path });
        const res = await authFetch(`/api/files/content?${params}`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        const data = await res.json();
        if (!cancelled) setState({ status: 'ready', data, error: null });
      } catch (err) {
        if (!cancelled) setState({ status: 'error', data: null, error: err.message });
      }
    })();
    return () => { cancelled = true; };
  }, [file.path]);

  const data = state.data;
  const isMarkdown = data?.kind === 'markdown';
  const size = data?.size ?? file.size;

  return (
    <PreviewDialog
      title={file.name}
      titleHint={file.path}
      meta={typeof size === 'number' && <span className="file-preview-meta">{formatSize(size)}</span>}
      status={state.status}
      error={state.error}
      content={data?.content}
      isMarkdown={isMarkdown}
      showSource={showSource}
      onToggleSource={setShowSource}
      contentLabel="File content"
      truncatedNotice={data?.truncated && (
        <>Showing the first {formatSize(utf8ByteLength(data.content))} of this file. Download it to see the rest.</>
      )}
      actions={(
        <button
          type="button"
          className="btn btn-secondary file-preview-icon-btn"
          onClick={() => onDownload(file)}
          title="Download"
          aria-label="Download"
        >
          &#8595;
        </button>
      )}
      onClose={onClose}
    />
  );
}
