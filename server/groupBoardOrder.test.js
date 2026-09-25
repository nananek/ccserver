import { test } from 'node:test';
import assert from 'node:assert/strict';
import { docCreatedAt, sortDocsNewestFirst, sortFilesNewestFirst } from '../client/src/groupBoardOrder.js';

const doc = (key, createdAt, publishedAt) => ({ key, createdAt, publishedAt });
const keys = (docs) => docs.map((d) => d.key);

test('sortDocsNewestFirst: last-updated first, whatever order the server listed them in', () => {
  // Server order is first-publish order: "old" was created first but touched last.
  const listed = [doc('old', 100, 900), doc('mid', 200, 300), doc('new', 400, 400)];
  assert.deepEqual(keys(sortDocsNewestFirst(listed)), ['old', 'new', 'mid']);
});

test('sortDocsNewestFirst: ties fall back to createdAt (newer first), then key', () => {
  const listed = [doc('b', 100, 500), doc('c', 300, 500), doc('a', 100, 500)];
  assert.deepEqual(keys(sortDocsNewestFirst(listed)), ['c', 'a', 'b']);
});

test('sortDocsNewestFirst: does not mutate its input, and tolerates missing timestamps', () => {
  const listed = [doc('x', undefined, undefined), doc('y', undefined, 50), doc('z', 10, 10)];
  const before = keys(listed);
  assert.deepEqual(keys(sortDocsNewestFirst(listed)), ['y', 'z', 'x']);
  assert.deepEqual(keys(listed), before);
  assert.deepEqual(sortDocsNewestFirst([]), []);
});

test('docCreatedAt: uses createdAt, else publishedAt (server without createdAt), else 0', () => {
  assert.equal(docCreatedAt({ createdAt: 5, publishedAt: 9 }), 5);
  assert.equal(docCreatedAt({ publishedAt: 9 }), 9);
  assert.equal(docCreatedAt({ createdAt: 0, publishedAt: 9 }), 0, 'a real 0 is not "missing"');
  assert.equal(docCreatedAt({}), 0);
});

test('sortFilesNewestFirst: newest upload first, ties by id, input untouched', () => {
  const listed = [
    { id: 'f1', publishedAt: 100 },
    { id: 'f3', publishedAt: 300 },
    { id: 'f2b', publishedAt: 200 },
    { id: 'f2a', publishedAt: 200 },
  ];
  assert.deepEqual(sortFilesNewestFirst(listed).map((f) => f.id), ['f3', 'f2a', 'f2b', 'f1']);
  assert.deepEqual(listed.map((f) => f.id), ['f1', 'f3', 'f2b', 'f2a']);
});
