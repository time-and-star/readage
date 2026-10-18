import assert from 'node:assert/strict';
import test from 'node:test';
import { readReadingBookmark, saveReadingBookmark } from '../src/lib/readingBookmark';
import { STORAGE_KEYS } from '../src/lib/storage';

test('immediately resuming a chapter reads the latest paragraph even while its write is queued', async () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
  const prior = { articleId: 'resume-A', paragraphIndex: 0, fraction: 0, anchorVersion: 2 as const, updatedAt: '2026-10-18T01:00:00Z' };
  const latest = { ...prior, paragraphIndex: 17, fraction: .42, updatedAt: '2026-10-18T02:00:00Z' };
  const other = { ...latest, articleId: 'resume-B', paragraphIndex: 8, updatedAt: '2026-10-18T03:00:00Z' };
  storage.setItem(STORAGE_KEYS.readingBookmarks, JSON.stringify({ [prior.articleId]: prior }));
  const previous = new Map(['window', 'navigator'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let unlock!: () => void;
  const locked = new Promise<void>(resolve => { unlock = resolve; });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: storage } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: async (_name: string, commit: () => unknown) => { await locked; return commit(); } } } });
  const pending: Promise<void>[] = [];
  try {
    pending.push(saveReadingBookmark(latest));
    assert.equal(JSON.parse(storage.getItem(STORAGE_KEYS.readingBookmarks)!)[prior.articleId].paragraphIndex, 0);
    assert.deepEqual(readReadingBookmark(prior.articleId), latest, 'resuming must not return the committed chapter start');
    pending.push(saveReadingBookmark(other));
    assert.deepEqual(readReadingBookmark(prior.articleId), latest);
    assert.deepEqual(readReadingBookmark(other.articleId), other);
    unlock(); await Promise.all(pending);
    assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEYS.readingBookmarks)!), { [prior.articleId]: latest, [other.articleId]: other });
  } finally {
    unlock(); await Promise.allSettled(pending);
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
