import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAppPath,
  parseAppPath,
  readAppHistoryIndex,
  readAppHistoryPreviousPath,
  resolveInitialAppRoute,
  withAppHistoryIndex,
} from '../src/lib/appRoutes';

test('opens the library at root and parses supported page paths', () => {
  assert.deepEqual(parseAppPath('/'), { kind: 'library' });
  assert.deepEqual(parseAppPath('/recommend'), { kind: 'recommendation' });
  assert.deepEqual(parseAppPath('/flashcards'), { kind: 'flashcards' });
  assert.deepEqual(parseAppPath('/learning/flashcards'), { kind: 'flashcards' });
  assert.deepEqual(parseAppPath('/library'), { kind: 'library' });
  assert.deepEqual(parseAppPath('/assessment'), { kind: 'learning' });
  assert.deepEqual(parseAppPath('/learning'), { kind: 'learning' });
  assert.deepEqual(parseAppPath('/settings/dictionaries'), { kind: 'dictionary-settings' });
  assert.deepEqual(parseAppPath('/settings/dictionaries/try/fr'), { kind: 'dictionary-trial' });
  assert.deepEqual(parseAppPath('/settings/dictionaries/try/ja'), { kind: 'dictionary-trial', language: 'ja' });
  assert.deepEqual(parseAppPath('/history'), { kind: 'learning-records' });
});

test('round-trips encoded article ids', () => {
  const route = { kind: 'reading' as const, articleId: 'magazine/issue 1' };

  assert.equal(buildAppPath(route), '/read/magazine%2Fissue%201');
  assert.deepEqual(parseAppPath(buildAppPath(route)), route);
});

test('reading study list and article/book details survive refresh and encoded ids', () => {
  assert.deepEqual(parseAppPath('/learning/articles/'), { kind: 'learning-records' });
  assert.equal(buildAppPath({ kind: 'learning-records' }), '/learning/articles');
  const route = { kind: 'learning-records' as const, articleId: 'novel/第一章 1' };
  assert.deepEqual(parseAppPath(buildAppPath(route)), route);
  assert.deepEqual(parseAppPath('/learning/articles/%E0%A4%A'), { kind: 'learning' });
  assert.deepEqual(parseAppPath('/learning/articles/a/b'), { kind: 'learning' });
});

test('normalizes trailing slashes and falls back unknown paths to library', () => {
  assert.deepEqual(parseAppPath('/library/'), { kind: 'library' });
  assert.deepEqual(parseAppPath('/not-a-page'), { kind: 'library' });
  assert.deepEqual(parseAppPath('/read/'), { kind: 'library' });
});

test('builds stable paths for every route kind', () => {
  assert.equal(buildAppPath({ kind: 'recommendation' }), '/recommend');
  assert.equal(buildAppPath({ kind: 'flashcards' }), '/learning/flashcards');
  assert.equal(buildAppPath({ kind: 'library' }), '/library');
  assert.equal(buildAppPath({ kind: 'learning' }), '/learning');
  assert.equal(buildAppPath({ kind: 'dictionary-settings' }), '/settings/dictionaries');
  assert.equal(buildAppPath({ kind: 'dictionary-trial' }), '/settings/dictionaries/try/fr');
  assert.equal(buildAppPath({ kind: 'dictionary-trial', language: 'ja' }), '/settings/dictionaries/try/ja');
});

test('experimental Bot deep links return to the library while Bot is disconnected', () => {
  for (const path of ['/settings/bot-avatar', '/settings/bot-avatar/']) {
    assert.deepEqual(parseAppPath(path), { kind: 'library' });
    assert.deepEqual(resolveInitialAppRoute(path), { kind: 'library' });
  }
});

test('Japanese dictionary trial deep links retain their language after refresh', () => {
  const route = { kind: 'dictionary-trial' as const, language: 'ja' as const };
  assert.deepEqual(resolveInitialAppRoute('/settings/dictionaries/try/ja/'), route);
  assert.deepEqual(parseAppPath(buildAppPath(route)), route);
  assert.equal(buildAppPath({ kind: 'dictionary-trial', language: 'fr' }), '/settings/dictionaries/try/fr');
  assert.deepEqual(parseAppPath('/settings/dictionaries/try/de'), { kind: 'library' });
});

test('dictionary settings deep links survive refresh and trailing slashes', () => {
  const route = { kind: 'dictionary-settings' as const };
  assert.deepEqual(resolveInitialAppRoute('/settings/dictionaries/'), route);
  assert.deepEqual(parseAppPath(buildAppPath(route)), route);
});

test('word-card inner pages and legacy bookmarks survive refresh and canonicalize under learning', () => {
  const route = { kind: 'flashcards' as const };
  for (const path of ['/flashcards', '/flashcards/', '/learning/flashcards', '/learning/flashcards/']) {
    const resolved = resolveInitialAppRoute(path);
    assert.deepEqual(resolved, route);
    assert.equal(buildAppPath(resolved), '/learning/flashcards');
  }
  assert.deepEqual(parseAppPath(buildAppPath(route)), route);
});

test('keeps deep links and canonicalizes retired test links to learning', () => {
  assert.deepEqual(resolveInitialAppRoute('/'), { kind: 'library' });
  assert.deepEqual(resolveInitialAppRoute('/library'), { kind: 'library' });
  for (const path of ['/assessment', '/assessment/']) {
    const route = resolveInitialAppRoute(path);
    assert.deepEqual(route, { kind: 'learning' });
    assert.equal(buildAppPath(route), '/learning');
  }
  for (const path of ['/history', '/history/']) {
    const route = resolveInitialAppRoute(path);
    assert.deepEqual(route, { kind: 'learning-records' });
    assert.equal(buildAppPath(route), '/learning/articles');
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

test('preserves the inner-page parent through refresh and overwrites it on the next push', () => {
  const entered = withAppHistoryIndex({ source: 'test' }, 2, '/learning');
  assert.equal(readAppHistoryPreviousPath(entered), '/learning');
  const refreshed = withAppHistoryIndex(entered, 2);
  assert.equal(readAppHistoryPreviousPath(refreshed), '/learning');
  assert.equal(readAppHistoryIndex(refreshed), 2);
  const next = withAppHistoryIndex(refreshed, 3, '/learning/flashcards');
  assert.equal(readAppHistoryPreviousPath(next), '/learning/flashcards');
  assert.equal(next.source, 'test');
  assert.equal(readAppHistoryPreviousPath(null), null);
  assert.equal(readAppHistoryPreviousPath({ __englishAiHistory: { index: 2 } }), null);
  assert.equal(readAppHistoryPreviousPath({ __englishAiHistory: { previousPath: 7 } }), null);
  assert.equal(readAppHistoryPreviousPath({ __englishAiHistory: { previousPath: 'learning' } }), null);
});
