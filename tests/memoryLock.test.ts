import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { withMemoryWriteLock } from '../src/lib/browserExtension/memoryLock';

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'window');
  Reflect.deleteProperty(globalThis, 'navigator');
});

test('rejects browser writes when Web Locks are unavailable', async () => {
  Object.defineProperty(globalThis, 'window', { value: {}, configurable: true });
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });

  assert.throws(
    () => withMemoryWriteLock(async () => undefined),
    /localhost or HTTPS/,
  );
});

test('runs non-browser writes without Web Locks for server-side tests', async () => {
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
  let called = false;
  await withMemoryWriteLock(async () => { called = true; });
  assert.equal(called, true);
});
