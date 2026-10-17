import test from 'node:test';
import assert from 'node:assert/strict';
import { OFFICIAL_LIBRARY_ORIGIN, libraryEditionState, nextLibraryOffset, resolveLibraryServer, selectLibraryItems } from '../src/lib/contentLibraryEntry';
import type { Article } from '../src/types';
import type { LibraryItem } from '../src/lib/contentLibraryProtocol';
const item: LibraryItem = { id: 'book:reading', title: 'Reading', filename: 'reading.epub', sha256: 'a'.repeat(64), kind: 'book', language: 'en', bytes: 1234, updatedAt: '2026-10-16T00:00:00Z', downloadPath: '/api/library/files/' + 'a'.repeat(64) };
const chapter = (index: number, totalCount = 2): Article => ({ id: `file-${item.sha256}-${index}`, title: `Chapter ${index}`, content: ['A complete paragraph.'], date: '', description: '', keyWords: [], source: 'user_input', status: 'Completed', importBatchId: `file-${item.sha256}`, distribution: { resourceId: item.id, title: item.title, serverUrl: 'https://library.example', version: item.sha256, totalCount } });
test('installed clients resolve the embedded official address without asking users; development loopback never becomes an Android default', () => {
  assert.equal(resolveLibraryServer({ configured: 'https://read.example/' }), 'https://read.example');
  assert.equal(resolveLibraryServer({ configured: 'https://read.example', android: true }), 'https://read.example');
  assert.equal(resolveLibraryServer({ development: true }), 'http://127.0.0.1:4175');
  assert.equal(resolveLibraryServer({ development: true, android: true }), OFFICIAL_LIBRARY_ORIGIN);
  assert.equal(resolveLibraryServer({ saved: 'http://127.0.0.1:4175', configured: 'https://read.example', android: true }), 'https://read.example');
  assert.equal(resolveLibraryServer({ saved: 'http://127.0.0.1:4175', configured: 'https://read.example' }), 'https://read.example');
  assert.equal(resolveLibraryServer({ saved: 'bad', configured: 'https://read.example' }), 'https://read.example');
  assert.equal(resolveLibraryServer({ saved: 'https://custom.example', configured: 'https://read.example' }), 'https://custom.example');
  assert.equal(resolveLibraryServer({}), 'https://readage.xyz');
  assert.equal(resolveLibraryServer({ android: true }), 'https://readage.xyz');
  assert.equal(resolveLibraryServer({ saved: 'http://127.0.0.1:4175' }), 'https://readage.xyz');
  assert.equal(resolveLibraryServer({ saved: 'http://127.0.0.1:4175', android: true }), 'https://readage.xyz');
  assert.equal(resolveLibraryServer({ configured: 'not a domain' }), 'https://readage.xyz');
});
test('update discovery distinguishes new, partial, complete and revised editions without changing saved learning records', () => {
  const first = chapter(0), second = chapter(1), snapshot = structuredClone([first, second]);
  assert.equal(libraryEditionState(item, []), 'new');
  assert.equal(libraryEditionState(item, [first]), 'partial');
  assert.equal(libraryEditionState(item, [first, first]), 'partial');
  assert.equal(libraryEditionState(item, [first, second]), 'saved');
  assert.equal(libraryEditionState({ ...item, sha256: 'b'.repeat(64) }, [first, second]), 'revision');
  assert.deepEqual([first, second], snapshot);
});
test('update and import entry scopes select the intended book or publication, with already saved editions available on request', () => {
  const magazine = { ...item, id: 'economist:2026.10.17', kind: 'magazine' as const, sha256: 'b'.repeat(64) };
  const another = { ...magazine, id: 'wired:2026.10.02' }; const all = [item, magazine, another];
  const history = [chapter(0), chapter(1)];
  assert.deepEqual(selectLibraryItems(all, history, { intent: 'updates' }, true), [magazine, another]);
  assert.deepEqual(selectLibraryItems(all, history, { intent: 'import' }, false), all);
  assert.deepEqual(selectLibraryItems(all, history, { intent: 'updates', kind: 'magazine', sourceId: 'economist' }, true), [magazine]);
  assert.deepEqual(selectLibraryItems(all, [chapter(0)], { intent: 'updates', resourceId: item.id }, true), [item]);
});
test('a different language keeps its own learning identity and remains available for import', () => {
  assert.equal(libraryEditionState({ ...item, language: 'fr' }, [chapter(0), chapter(1)]), 'new');
});
test('continued import starts at the first missing chapter instead of preparing an already imported prefix again', () => {
  assert.equal(nextLibraryOffset(item, [chapter(0)]), 1);
  assert.equal(nextLibraryOffset(item, [chapter(1)]), 0);
  assert.equal(nextLibraryOffset(item, [chapter(0), chapter(2)]), 1);
  assert.equal(nextLibraryOffset({ ...item, language: 'fr' }, [chapter(0)]), 0);
});
