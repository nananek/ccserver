// Display order and timestamps for the group Docs / Files panels.
//
// Sorting lives in the client on purpose: the server (and the MCP list_docs /
// list_files tools that share its list functions) keep returning entries in
// their insertion order, which callers may already rely on.

const ts = (n) => (Number.isFinite(n) ? n : 0);

/**
 * A doc's first-publish time. `publishedAt` is the last publish (it moves on
 * every overwrite), so it is only a stand-in for a server that predates
 * `createdAt`.
 * @param {{ createdAt?: number, publishedAt?: number }} doc
 * @returns {number}
 */
export function docCreatedAt(doc) {
  return Number.isFinite(doc.createdAt) ? doc.createdAt : ts(doc.publishedAt);
}

/**
 * Docs, most recently updated first. Ties (same millisecond, or a server
 * without timestamps) fall back to creation time, then to the key so the
 * order is deterministic between polls.
 * @template {{ key: string, createdAt?: number, publishedAt?: number }} D
 * @param {D[]} docs
 * @returns {D[]}
 */
export function sortDocsNewestFirst(docs) {
  return [...docs].sort((a, b) =>
    ts(b.publishedAt) - ts(a.publishedAt)
    || docCreatedAt(b) - docCreatedAt(a)
    || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * Files, most recently added first. A file is never overwritten (every upload
 * or publish_file creates a new entry), so `publishedAt` is both its creation
 * and its last-update time.
 * @template {{ id: string, publishedAt?: number }} F
 * @param {F[]} files
 * @returns {F[]}
 */
export function sortFilesNewestFirst(files) {
  return [...files].sort((a, b) =>
    ts(b.publishedAt) - ts(a.publishedAt)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
