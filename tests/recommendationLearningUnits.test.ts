import assert from 'node:assert/strict';
import test from 'node:test';
import type { Article } from '../src/types';
import { extractRecommendationLemmas } from '../src/lib/recommendationLearningUnits';
import { getArticleReviewWords } from '../src/lib/readingLearningTerms';
import { resolveRecommendationArticle } from '../src/lib/resolveRecommendation';

function article(content: string[], overrides: Partial<Article> = {}): Article {
  return {
    id: 'learning-units', title: 'Absent headline', description: '', date: '',
    status: 'In Progress', source: 'magazine', level: 'B1', content, ...overrides,
  };
}

test('recommendation coverage uses the same phrase units and boundaries as reading', () => {
  const current = article([
    'Practice over time. Economic policy changes. Economic policy changes.',
    'A trade, off topic does not contain the phrase.',
  ], { keyWords: ['economic policy'], embeddedReviewWords: ['over time', 'trade off'] });

  const lemmas = extractRecommendationLemmas(current);
  assert.ok(lemmas.includes('over time'));
  assert.ok(lemmas.includes('economic policy'));
  assert.equal(lemmas.filter((word) => word === 'economic policy').length, 1);
  assert.equal(lemmas.includes('economic'), false);
  assert.equal(lemmas.includes('policy'), false);
  assert.equal(lemmas.includes('trade off'), false);
  assert.deepEqual(getArticleReviewWords(current, current.keyWords), ['over time', 'economic policy']);
});

test('title and import furniture cannot create recommendation target hits', () => {
  const current = article([
    'Absent headline',
    'Read: unavailable vocabulary',
    'This article appears in the magazinearchive.',
    'This article was downloaded from https://example.test/phantom',
    'Next Section Menu Main Menu Previous',
    'The forest provides shelter. Shelter protects readers.',
  ], { keyWords: ['absent', 'unavailable', 'magazinearchive', 'phantom', 'shelter'] });

  const lemmas = extractRecommendationLemmas(current);
  for (const metadataOnlyWord of ['absent', 'headline', 'unavailable', 'magazinearchive', 'phantom', 'menu']) {
    assert.equal(lemmas.includes(metadataOnlyWord), false, metadataOnlyWord);
  }
  assert.equal(lemmas.filter((word) => word === 'shelter').length, 1);
  assert.deepEqual(getArticleReviewWords(current, current.keyWords), ['shelter']);
});

test('catalog history extras resolve word forms and preserve phrase coverage before ranking', async () => {
  const originalFetch = globalThis.fetch;
  const current = article([
    'Absent headline',
    'Read: unavailable vocabulary',
    'Running readers carry books over time.',
  ], { id: 'canonical-extra', embeddedReviewWords: ['over time'] });
  let ranked = false;
  globalThis.fetch = async (_input, init) => {
    const { words } = JSON.parse(String(init?.body)) as { words: string[] };
    return Response.json({ ok: true, lemmas: words.map((word) => ({ running: 'run', books: 'book' }[word] ?? word)) });
  };
  try {
    const result = await resolveRecommendationArticle(
      { topic: '', reviewWords: ['run', 'book', 'over time'], excludeArticleIds: [] },
      {
        library: [current], history: [current], useFullCatalog: true,
        loadLemmaIndex: async () => ({
          version: 5, fingerprint: 'learning-unit-test', builtAt: new Date().toISOString(),
          articleCount: 1, vocab: ['forest'],
          articles: [{ id: 'catalog-row', title: 'Forest', level: 'B1', lemmaIndices: [0] }],
        }),
        rankCatalog: async (candidates) => {
          const extras = candidates.filter((candidate) => candidate.article.id === current.id);
          assert.equal(extras.length, 1, 'library and history must not add duplicate extra rows');
          assert.ok(extras[0].lemmas.includes('run'));
          assert.ok(extras[0].lemmas.includes('book'));
          assert.ok(extras[0].lemmas.includes('over time'));
          for (const word of ['running', 'books', 'absent', 'unavailable']) {
            assert.equal(extras[0].lemmas.includes(word), false, word);
          }
          ranked = true;
          return [{
            articleId: current.id, score: 1, dueWordsCount: 3, learningZoneCount: 3,
            consolidationZoneCount: 0, unknownWordsCount: 0, averageMemoryScore: 0, reason: 'test',
          }];
        },
        localProvider: async () => assert.fail('catalog extra should win'),
        libraryFallback: () => assert.fail('catalog extra should win'),
        aiPost: async () => assert.fail('catalog extra should win'),
      },
    );
    assert.equal(ranked, true);
    assert.equal(result?.source, 'full_catalog');
    assert.equal(result?.article.id, current.id);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
