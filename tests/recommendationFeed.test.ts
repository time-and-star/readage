import test from 'node:test';
import assert from 'node:assert/strict';
import type { Article } from '../src/types';
import {
  beginRecommendationPrefetch,
  collectExcludedArticleIds,
  consumeQueuedRecommendation,
  endRecommendationFeed,
  failRecommendationPrefetch,
  finishRecommendationPrefetch,
  getRecommendationRenderWindow,
  selectLibraryFallback,
  startRecommendationFeed,
} from '../src/lib/recommendationFeed';
function article(id: string, status: Article['status'] = 'In Progress'): Article {
  return {
    id,
    title: id,
    description: id,
    date: 'Today',
    status,
    source: id.startsWith('lib-') ? 'library' : 'ai_generated',
    content: ['Paragraph'],
  };
}

test('recommendation feed stores at most one prefetched article', () => {
  const started = startRecommendationFeed('current');
  const loading = beginRecommendationPrefetch(started);
  const withFirst = finishRecommendationPrefetch(loading, article('next-1'));
  const withSecond = finishRecommendationPrefetch(withFirst, article('next-2'));

  assert.equal(withFirst.queuedArticle?.id, 'next-1');
  assert.equal(withSecond.queuedArticle?.id, 'next-1');
  assert.equal(withSecond.isPrefetching, false);
});

test('duplicate recommendations are rejected within the current feed', () => {
  const started = startRecommendationFeed('current');
  const duplicate = finishRecommendationPrefetch(
    beginRecommendationPrefetch(started),
    article('current')
  );

  assert.equal(duplicate.queuedArticle, null);
  assert.equal(duplicate.isPrefetching, false);
});

test('consuming a queued article marks it seen and frees the prefetch slot', () => {
  const queued = finishRecommendationPrefetch(
    beginRecommendationPrefetch(startRecommendationFeed('current')),
    article('next')
  );
  const result = consumeQueuedRecommendation(queued);

  assert.equal(result.article?.id, 'next');
  assert.equal(result.state.queuedArticle, null);
  assert.deepEqual(result.state.seenArticleIds, ['current', 'next']);
});

test('recommendation render window keeps only the current and prefetched article', () => {
  assert.deepEqual(
    getRecommendationRenderWindow(article('current'), article('next')),
    [article('current'), article('next')]
  );
  assert.deepEqual(
    getRecommendationRenderWindow(article('current'), null),
    [article('current')]
  );
});

test('library fallback skips completed and already-seen articles in stable order', () => {
  const library = [article('lib-1'), article('lib-2'), article('lib-3')];
  const history = [article('lib-1', 'Completed')];

  assert.equal(
    selectLibraryFallback(library, history, new Set(['lib-2']))?.id,
    'lib-3'
  );
  assert.equal(
    selectLibraryFallback(library, [...history, article('lib-3', 'Completed')], new Set(['lib-2'])),
    null
  );
});

test('library fallback can skip candidates outside the active recommendation bounds', () => {
  const long = { ...article('long'), content: [Array.from({ length: 1200 }, () => 'word').join(' ')] };
  const short = { ...article('short'), content: ['word '.repeat(220)] };

  assert.equal(
    selectLibraryFallback(
      [long, short],
      [],
      new Set(),
      (candidate) => candidate.id === 'short',
    )?.id,
    'short',
  );
});

test('collectExcludedArticleIds merges feed excludes with every history id', () => {
  const history = [article('h1', 'Completed'), article('h2', 'In Progress')];
  const excluded = collectExcludedArticleIds(['feed-a', 'h1'], history);
  assert.deepEqual([...excluded].sort(), ['feed-a', 'h1', 'h2']);
});


test('failed prefetch frees the slot without ending the feed', () => {
  const loading = beginRecommendationPrefetch(startRecommendationFeed('current'));
  const failed = failRecommendationPrefetch(loading);

  assert.equal(failed.status, 'active');
  assert.equal(failed.isPrefetching, false);
  assert.equal(failed.queuedArticle, null);
});

test('ending the feed clears transient queue state', () => {
  const queued = finishRecommendationPrefetch(
    beginRecommendationPrefetch(startRecommendationFeed('current')),
    article('next')
  );
  const ended = endRecommendationFeed({ ...queued, isPrefetching: true });

  assert.equal(ended.status, 'ended');
  assert.equal(ended.queuedArticle, null);
  assert.equal(ended.isPrefetching, false);
  assert.deepEqual(ended.seenArticleIds, ['current']);
});
