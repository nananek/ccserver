import { useState, useEffect } from 'react';
import { authFetch } from '../auth.js';
import PreviewDialog from './PreviewDialog.jsx';

function formatTime(ts) {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleString();
  } catch { return ''; }
}

/**
 * Read-only modal viewer for a group document board entry (publish_doc /
 * fetch_doc / list_docs). Fetches
 * `/api/groups/:id/docs/content?key=...` and renders it through
 * PreviewDialog. No download/copy action, no write path -- the board itself
 * is agent (MCP) write-only from the browser's perspective.
 * @param {{ groupId: string, docKey: string, onClose: () => void }} props
 */
export default function DocPreview({ groupId, docKey, onClose }) {
  const [state, setState] = useState({ status: 'loading', data: null, error: null });
  const [showSource, setShowSource] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading', data: null, error: null });
    setShowSource(false);
    (async () => {
      try {
        const params = new URLSearchParams({ key: docKey });
        const res = await authFetch(`/api/groups/${encodeURIComponent(groupId)}/docs/content?${params}`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.message || body.error || `HTTP ${res.status}`);
        }
        const data = await res.json();
        if (!cancelled) setState({ status: 'ready', data, error: null });
      } catch (err) {
        if (!cancelled) setState({ status: 'error', data: null, error: err.message });
      }
    })();
    return () => { cancelled = true; };
  }, [groupId, docKey]);

  const data = state.data;

  return (
    <PreviewDialog
      title={docKey}
      titleHint={docKey}
      meta={data && (
        <span className="file-preview-meta">{data.publishedBy} · {formatTime(data.publishedAt)}</span>
      )}
      status={state.status}
      error={state.error}
      content={data?.content}
      // Doc keys carry no extension to infer a "kind" from, and marked
      // renders plain text without breaking, so always offer the
      // Rendered/Source toggle rather than guessing.
      isMarkdown
      showSource={showSource}
      onToggleSource={setShowSource}
      contentLabel="Document content"
      onClose={onClose}
    />
  );
}
