import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultLibraryView, normalizeLibraryView } from '../src/lib/libraryView';

test('restores a chapter list and its search, level and scroll position', () => {
  const saved = { ...defaultLibraryView, tab: 'mine' as const, activeImportBatchId: 'book', topicQuery: 'chapter', levelFilter: 'B2', scrollY: 400 };
  assert.deepEqual(normalizeLibraryView(JSON.parse(JSON.stringify(saved))), saved);
});
test('restores an issue with its owning publication rather than an unrelated stored source', () => {
  const issue = { id: 'issue', sourceId: 'atlantic', title: 'July', issueLabel: '2026-07', importedAt: '', format: 'epub' as const, remotePath: '', articleCount: 10, status: 'ready' as const };
  assert.equal(normalizeLibraryView({ selectedIssue: issue, activeSourceId: 'wired' }).activeSourceId, 'atlantic');
  assert.deepEqual(normalizeLibraryView({ selectedIssue: issue }).selectedIssue, issue);
});
test('invalid saved directories fall back safely', () => {
  assert.deepEqual(normalizeLibraryView(null), defaultLibraryView);
  assert.deepEqual(normalizeLibraryView({ selectedIssue: { id: 'issue' }, topicQuery: 9, levelFilter: 'unknown', scrollY: Infinity }), defaultLibraryView);
});
test('a saved personal shelf never restores a magazine loading state and preserves catalog page count', () => {
  const issue = { id: 'issue', sourceId: 'atlantic', title: 'July', format: 'epub', status: 'ready' };
  const saved = normalizeLibraryView({ tab: 'mine', activeImportBatchId: 'book', activeSourceId: 'atlantic', selectedIssue: issue, catalogPages: 3 });
  assert.equal(saved.selectedIssue, null);
  assert.equal(saved.activeSourceId, null);
  assert.equal(saved.catalogPages, 3);
});
