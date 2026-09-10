import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAppPath,
  parseAppPath,
  readAppHistoryIndex,
  resolveInitialAppRoute,
  withAppHistoryIndex,
} from '../src/lib/appRoutes';

test('parses the landing, recommendation entry, and supported page paths', () => {
  assert.deepEqual(parseAppPath('/'), { kind: 'landing' });
  assert.deepEqual(parseAppPath('/recommend'), { kind: 'recommendation' });
  assert.deepEqual(parseAppPath('/library'), { kind: 'library' });
  assert.deepEqual(parseAppPath('/assessment'), { kind: 'learning' });
  assert.deepEqual(parseAppPath('/learning'), { kind: 'learning' });
  assert.deepEqual(parseAppPath('/history'), { kind: 'history' });
});

test('round-trips encoded article ids', () => {
  const route = { kind: 'reading' as const, articleId: 'magazine/issue 1' };

  assert.equal(buildAppPath(route), '/read/magazine%2Fissue%201');
  assert.deepEqual(parseAppPath(buildAppPath(route)), route);
});

test('normalizes trailing slashes and falls back unknown paths to landing', () => {
  assert.deepEqual(parseAppPath('/library/'), { kind: 'library' });
  assert.deepEqual(parseAppPath('/not-a-page'), { kind: 'landing' });
  assert.deepEqual(parseAppPath('/read/'), { kind: 'landing' });
});

test('builds stable paths for every route kind', () => {
  assert.equal(buildAppPath({ kind: 'landing' }), '/');
  assert.equal(buildAppPath({ kind: 'recommendation' }), '/recommend');
  assert.equal(buildAppPath({ kind: 'library' }), '/library');
  assert.equal(buildAppPath({ kind: 'learning' }), '/learning');
  assert.equal(buildAppPath({ kind: 'history' }), '/history');
});

test('keeps deep links and canonicalizes retired test links to learning', () => {
  assert.deepEqual(resolveInitialAppRoute('/'), { kind: 'landing' });
  assert.deepEqual(resolveInitialAppRoute('/library'), { kind: 'library' });
  for (const path of ['/assessment', '/assessment/']) {
    const route = resolveInitialAppRoute(path);
    assert.deepEqual(route, { kind: 'learning' });
    assert.equal(buildAppPath(route), '/learning');
  }
});

test('tracks only valid application history markers', () => {
  assert.equal(readAppHistoryIndex(null), null);
  assert.equal(readAppHistoryIndex({ __englishAiHistory: { index: -1 } }), null);
  assert.equal(readAppHistoryIndex({ __englishAiHistory: { index: 2 } }), 2);

  assert.deepEqual(
    withAppHistoryIndex({ source: 'test' }, 3),
    { source: 'test', __englishAiHistory: { index: 3 } },
  );
});
