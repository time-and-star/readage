import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeArticleSessions,
  STORAGE_KEYS,
  readStorage,
  writeStorage,
  commitPersistentUpdate,
  mergeChatMessages,
} from '../src/lib/storage';

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

test('concurrent operations rebase on the latest stored value without losing either update', async () => {
  const storage = new MemoryStorage();
  await Promise.all([
    commitPersistentUpdate<string[]>(storage, 'events', [], previous => [...previous, 'tab-a']),
    commitPersistentUpdate<string[]>(storage, 'events', [], previous => [...previous, 'tab-b']),
  ]);
  assert.deepEqual(JSON.parse(storage.getItem('events')!), ['tab-a', 'tab-b']);
});

test('stale chat snapshots keep messages added by another tab', () => {
  const a = { id: 'a', sender: 'user' as const, text: 'First', timestamp: '2026-09-09T01:00:00Z' };
  const b = { ...a, id: 'b', text: 'Second', timestamp: '2026-09-09T01:01:00Z' };
  const c = { ...a, id: 'c', text: 'Third', timestamp: '2026-09-09T01:02:00Z' };
  assert.deepEqual(mergeChatMessages([a, b], [a, c]), [a, b, c]);
});

test('failed persistence can be retried without double applying the operation', async () => {
  const storage = new MemoryStorage();
  const write = storage.setItem.bind(storage);
  storage.setItem = () => { throw new Error('quota'); };
  await assert.rejects(commitPersistentUpdate<number>(storage, 'count', 0, count => count + 1), /quota/);
  storage.setItem = write;
  await commitPersistentUpdate<number>(storage, 'count', 0, count => count + 1);
  assert.equal(storage.getItem('count'), '1');
});

test('corrupted persisted data is not silently overwritten', async () => {
  const storage = new MemoryStorage();
  storage.setItem('events', '{broken');
  await assert.rejects(commitPersistentUpdate<string[]>(storage, 'events', [], previous => [...previous, 'new']));
  assert.equal(storage.getItem('events'), '{broken');
});

test('uses versioned keys and falls back safely for missing or corrupt JSON', () => {
  const storage = new MemoryStorage();
  assert.match(STORAGE_KEYS.events, /^english-ai:v2:/);
  assert.deepEqual(readStorage(storage, STORAGE_KEYS.events, []), []);

  storage.setItem(STORAGE_KEYS.events, '{bad json');
  assert.deepEqual(readStorage(storage, STORAGE_KEYS.events, []), []);
});

test('round-trips persisted application state', () => {
  const storage = new MemoryStorage();
  const sessions = {
    articleA: {
      articleId: 'articleA',
      chatMessages: [],
      clickCount: 1,
      discussionCount: 2,
      lastOpenedAt: '2026-07-23T08:00:00.000Z',
    },
  };

  assert.equal(writeStorage(storage, STORAGE_KEYS.sessions, sessions), true);
  assert.deepEqual(readStorage(storage, STORAGE_KEYS.sessions, {}), sessions);
});


test('removes retired composition data from persisted article sessions', () => {
  const storage = new MemoryStorage();
  storage.setItem(STORAGE_KEYS.sessions, JSON.stringify({
    articleA: {
      articleId: 'articleA',
      chatMessages: [],
      writingDraft: 'legacy draft',
      writingFeedback: 'legacy feedback',
      writingCount: 3,
      clickCount: 1,
      discussionCount: 2,
      lastOpenedAt: '2026-07-23T08:00:00.000Z',
    },
  }));

  const sessions = readStorage(storage, STORAGE_KEYS.sessions, {}, normalizeArticleSessions);
  assert.deepEqual(sessions.articleA, {
    articleId: 'articleA',
    chatMessages: [],
    clickCount: 1,
    discussionCount: 2,
    lastOpenedAt: '2026-07-23T08:00:00.000Z',
  });
  assert.equal('writingDraft' in sessions.articleA, false);
  assert.equal('writingFeedback' in sessions.articleA, false);
  assert.equal('writingCount' in sessions.articleA, false);
});

test('write failures do not crash the application', () => {
  const storage = new MemoryStorage();
  storage.setItem = () => {
    throw new Error('quota exceeded');
  };

  assert.equal(writeStorage(storage, STORAGE_KEYS.events, [{ id: '1' }]), false);
});


test('normalizes parsed storage before it reaches application state', () => {
  const storage = new MemoryStorage();
  const fallback = { safe: true };
  storage.setItem(STORAGE_KEYS.proficiency, 'null');

  const normalized = readStorage(
    storage,
    STORAGE_KEYS.proficiency,
    fallback,
    (value, safeFallback) => value && typeof value === 'object' ? value as typeof fallback : safeFallback
  );

  assert.equal(normalized, fallback);
});
