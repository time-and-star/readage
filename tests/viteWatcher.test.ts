import assert from 'node:assert/strict';
import test from 'node:test';
import { VITE_WATCH_IGNORED } from '../src/viteWatchConfig';

test('ignores generated root-level development logs', () => {
  assert.ok(VITE_WATCH_IGNORED.includes('**/tmp-*.out'));
  assert.ok(VITE_WATCH_IGNORED.includes('**/tmp-*.err'));
});
