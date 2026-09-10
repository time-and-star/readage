import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';

test('ignores generated root-level development logs', async () => {
  const vite = await createServer({
    server: { middlewareMode: true },
  });

  try {
    const ignored = vite.config.server.watch?.ignored;
    assert.ok(Array.isArray(ignored));
    assert.ok(ignored.includes('**/tmp-*.out'));
    assert.ok(ignored.includes('**/tmp-*.err'));
  } finally {
    await vite.close();
  }
});
