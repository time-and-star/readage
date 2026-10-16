import assert from 'node:assert/strict';
import test from 'node:test';
import type { Article } from '../src/types';
import { getArticleReviewWords } from '../src/lib/readingLearningTerms';

function article(content: string[], embeddedReviewWords: string[] = []): Article {
  return { id: 'a', title: 'An article', description: '', date: '', status: 'In Progress', source: 'magazine', content, embeddedReviewWords };
}

test('focus coverage shows the words actually present, not every requested review word', () => {
  const current = article(['The dense forest provided shelter. Dense trees blocked the path.'], [' dense ', 'DENSE', 'absent']);
  assert.deepEqual(getArticleReviewWords(current, ['shelter', 'uncovered']), ['dense', 'shelter']);
  assert.deepEqual(getArticleReviewWords(article(['Nothing matches here.']), ['absent']), []);
});

test('coverage follows reading word and phrase boundaries and ignores import furniture', () => {
  assert.deepEqual(getArticleReviewWords(article([
    'An article',
    'This article was downloaded from https://example.test/absent',
    'The crafty artist wrote art. A trade, off is different from a trade off.',
  ]), ['article', 'absent', 'art', 'trade off']), ['art', 'trade off']);
  assert.deepEqual(getArticleReviewWords(article(['The artist discussed a trade, off topic.']), ['art', 'trade off']), []);
});

test('level rewrites retain their own vocabulary treatment', () => {
  const current = article(['A dense forest.'], ['dense']);
  assert.deepEqual(getArticleReviewWords({ ...current, source: 'level_rewrite' }, ['dense']), []);
  assert.deepEqual(getArticleReviewWords({ ...current, generationKind: 'level-rewrite' }, ['dense']), []);
});
