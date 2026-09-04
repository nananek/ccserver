import { useMemo, useRef, useCallback, useId, useEffect } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Markdown -> HTML happens entirely in the browser. marked does no sanitizing
// (dropped in v8), and the source is whatever sits on the server's disk, so
// every render goes through DOMPurify before it reaches innerHTML.
marked.use({
  gfm: true,
  breaks: false,
  renderer: {
    // Images are never fetched (see SANITIZE_OPTIONS); leave a marker so the
    // reader knows the source has one and where it points.
    image({ href, text }) {
      const label = text ? `[image: ${text}]` : '[image]';
      return `<span class="md-image-placeholder" title="${escapeHtml(href || '')}">${escapeHtml(label)}</span>`;
    },
  },
});

// <input type="image"> is a fetching element wearing an <input> tag: with its
// src stripped (FORBID_ATTR) it would fetch nothing, but it also renders as a
// broken image button, so drop it entirely. Other inputs (task-list
// checkboxes) stay.
DOMPurify.addHook('uponSanitizeElement', (node, data) => {
  if (data.tagName === 'input' && /^image$/i.test(node.getAttribute('type') || '')) {
    node.parentNode?.removeChild(node);
  }
});

// リンクは常に別タブで開く。ダイアログ内で同一タブ遷移するとSPAごと離脱してしまう。
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.hasAttribute('href')) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

const SANITIZE_OPTIONS = {
  USE_PROFILES: { html: true },
  // Opening a preview must not make the browser talk to anyone. DOMPurify's
  // defaults keep <img>, media and their URL attributes, so a markdown file
  // could hit tracking pixels or LAN services just by being viewed. Drop every
  // auto-fetching element and every attribute that carries a fetchable URL;
  // <a href> stays because it only loads on an explicit click. <style> and
  // style="" go too: a file's CSS would apply to the whole page.
  FORBID_TAGS: ['style', 'link', 'meta', 'base', 'img', 'picture', 'source', 'video', 'audio', 'track', 'iframe', 'frame', 'embed', 'object'],
  FORBID_ATTR: ['style', 'src', 'srcset', 'poster', 'background', 'ping', 'data', 'action', 'formaction'],
};

/**
 * Render markdown source to sanitized HTML that fetches nothing on its own.
 * @param {string} src Markdown source.
 * @returns {string} HTML safe to assign to innerHTML.
 */
export function renderMarkdown(src) {
  return DOMPurify.sanitize(marked.parse(src), SANITIZE_OPTIONS);
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Presentational modal dialog for viewing text/markdown content: dialog
 * chrome, focus trap, Escape/click-outside close, and the Rendered/Source
 * toggle. Fetching and content-type decisions belong to the caller
 * (FilePreview.jsx / DocPreview.jsx).
 * @param {{
 *   title: string,
 *   titleHint?: string,
 *   meta?: import('react').ReactNode,
 *   status: 'loading' | 'ready' | 'error',
 *   error?: string,
 *   content?: string,
 *   isMarkdown: boolean,
 *   truncatedNotice?: import('react').ReactNode,
 *   actions?: import('react').ReactNode,
 *   showSource: boolean,
 *   onToggleSource: (showSource: boolean) => void,
 *   onClose: () => void,
 *   contentLabel?: string,
 * }} props
 */
export default function PreviewDialog({
  title,
  titleHint,
  meta,
  status,
  error,
  content,
  isMarkdown,
  truncatedNotice,
  actions,
  showSource,
  onToggleSource,
  onClose,
  contentLabel = 'Content',
}) {
  const dialogRef = useRef(null);
  const titleId = useId();

  useEffect(() => {
    const d = dialogRef.current;
    if (d && !d.open) d.showModal();
  }, []);

  // Close through the element so the browser runs its close steps (focus
  // restore included); the `close` event then reports back via onClose.
  const requestClose = useCallback(() => {
    const d = dialogRef.current;
    if (d && d.open) d.close();
    else onClose();
  }, [onClose]);

  const handleKeyDown = useCallback((e) => {
    if (e.key !== 'Tab') return;
    const d = dialogRef.current;
    if (!d) return;
    const focusable = Array.from(d.querySelectorAll(FOCUSABLE));
    if (focusable.length === 0) {
      e.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !d.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !d.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  }, []);

  const html = useMemo(
    () => (isMarkdown && !showSource && status === 'ready' ? renderMarkdown(content) : null),
    [isMarkdown, showSource, status, content]
  );

  return (
    <dialog
      ref={dialogRef}
      className="file-preview-dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(e) => { if (e.target === e.currentTarget) requestClose(); }}
      onKeyDown={handleKeyDown}
    >
      <div className="file-preview-header">
        <span id={titleId} className="file-preview-title" title={titleHint}>{title}</span>
        {meta}
        {isMarkdown && (
          <div className="file-preview-toggle" role="group" aria-label="View mode">
            <button
              type="button"
              className={`btn btn-secondary${!showSource ? ' active' : ''}`}
              onClick={() => onToggleSource(false)}
              aria-pressed={!showSource}
            >
              Rendered
            </button>
            <button
              type="button"
              className={`btn btn-secondary${showSource ? ' active' : ''}`}
              onClick={() => onToggleSource(true)}
              aria-pressed={showSource}
            >
              Source
            </button>
          </div>
        )}
        {actions}
        <button
          type="button"
          className="btn btn-secondary file-preview-icon-btn"
          onClick={requestClose}
          title="Close"
          aria-label="Close"
        >
          &#10005;
        </button>
      </div>

      {truncatedNotice && (
        <div className="file-preview-notice">{truncatedNotice}</div>
      )}

      <div className="file-preview-body" tabIndex={0} aria-label={contentLabel}>
        {status === 'loading' && <div className="loading">Loading...</div>}
        {status === 'error' && <div className="error">Error: {error}</div>}
        {status === 'ready' && (
          html !== null
            ? <div className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />
            : <pre className="file-preview-text">{content}</pre>
        )}
      </div>
    </dialog>
  );
}
