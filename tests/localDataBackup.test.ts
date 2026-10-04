import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyAppLocalStorage,
  collectAppLocalStorage,
  isAppStorageKey,
  LOCAL_BACKUP_FORMAT,
  LOCAL_BACKUP_VERSION,
  validateLocalDataBackup,
  importLocalDataBackup,
} from '../src/lib/localDataBackup';

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

test('isAppStorageKey only accepts english-ai:v2 namespace', () => {
  assert.equal(isAppStorageKey('english-ai:v2:articles'), true);
  assert.equal(isAppStorageKey('english-ai:v2'), true);
  assert.equal(isAppStorageKey('english-ai:v2:memory:raw:default-user:x:2026-01-01'), true);
  assert.equal(isAppStorageKey('other-app:data'), false);
  assert.equal(isAppStorageKey('english-ai:v1:articles'), false);
});

test('collect and apply localStorage backup round-trips app keys only', () => {
  const storage = new MemoryStorage();
  storage.setItem('english-ai:v2:articles', '[{"id":"a1"}]');
  storage.setItem('english-ai:v2:events', '[]');
  storage.setItem('unrelated', 'keep-me');

  const collected = collectAppLocalStorage(storage);
  assert.deepEqual(Object.keys(collected).sort(), [
    'english-ai:v2:articles',
    'english-ai:v2:events',
  ]);
  assert.equal(collected['english-ai:v2:articles'], '[{"id":"a1"}]');

  const other = new MemoryStorage();
  other.setItem('english-ai:v2:old', 'gone');
  other.setItem('unrelated', 'keep-me');
  const result = applyAppLocalStorage(collected, other);
  assert.equal(result.written, 2);
  assert.equal(result.removed, 1);
  assert.equal(other.getItem('english-ai:v2:articles'), '[{"id":"a1"}]');
  assert.equal(other.getItem('english-ai:v2:old'), null);
  assert.equal(other.getItem('unrelated'), 'keep-me');
});

test('validateLocalDataBackup accepts v1 payload and rejects foreign formats', () => {
  const valid = validateLocalDataBackup({
    format: LOCAL_BACKUP_FORMAT,
    version: LOCAL_BACKUP_VERSION,
    exportedAt: '2026-07-25T00:00:00.000Z',
    localStorage: {
      'english-ai:v2:articles': '[]',
      'ignored-key': 'nope',
    },
    indexedDb: null,
  });
  assert.equal(valid.format, LOCAL_BACKUP_FORMAT);
  assert.deepEqual(valid.localStorage, { 'english-ai:v2:articles': '[]' });

  assert.throws(
    () => validateLocalDataBackup({ format: 'other', version: 1, localStorage: {} }),
    /不是本应用/
  );
  assert.throws(
    () =>
      validateLocalDataBackup({
        format: LOCAL_BACKUP_FORMAT,
        version: 99,
        localStorage: {},
      }),
    /不支持的备份版本/
  );
});

test('import restores the previous localStorage namespace when replacement fails', async () => {
  const storage = new MemoryStorage();
  storage.setItem('english-ai:v2:articles', 'old');
  let writes = 0;
  const originalSetItem = storage.setItem.bind(storage);
  storage.setItem = (key, value) => {
    writes += 1;
    if (writes === 2) throw new Error('quota');
    originalSetItem(key, value);
  };
  Object.defineProperty(globalThis, 'window', { value: { localStorage: storage }, configurable: true });

  await assert.rejects(
    importLocalDataBackup({
      format: LOCAL_BACKUP_FORMAT,
      version: LOCAL_BACKUP_VERSION,
      localStorage: {
        'english-ai:v2:articles': 'new',
        'english-ai:v2:events': 'new-events',
      },
      indexedDb: null,
    }),
    /quota/
  );
  assert.equal(storage.getItem('english-ai:v2:articles'), 'old');
  assert.equal(storage.getItem('english-ai:v2:events'), null);
  delete (globalThis as { window?: unknown }).window;
});
