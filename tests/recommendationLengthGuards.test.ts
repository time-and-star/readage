import assert from 'node:assert/strict';
import test from 'node:test';

import { enrichArticleOnImport } from '../src/lib/articleImport/enrichment';
import {
  RecommendationEngine,
  scoreArticlesForReview,
  type ArticleCandidate,
} from '../src/lib/memoryV2/recommendation';
import type { WordProficiencyView } from '../src/lib/memoryV2/memorySystem';
import { buildCefrRecommendationProfile } from '../src/lib/userReadingProfile';

function candidate(
  id: string,
  level: string,
  wordCount: number,
  lemmas = ['target']
): ArticleCandidate {
  return {
    article: {
      id,
      title: id,
      content: [Array.from({ length: wordCount }, () => 'word').join(' ')],
      level,
    },
    lemmas,
  };
}

function proficiency(wordId: string): WordProficiencyView {
  return {
    wordId,
    memoryScore: 20,
    level: 1,
    stability: 1,
    difficulty: 5,
    nextReview: '2020-01-01T00:00:00.000Z',
    lastReview: null,
  };
}

const assessedB1 = buildCefrRecommendationProfile('B1', { confidence: 'high', useLevelFilter: true });

test('rating failure preserves the article source level', async () => {
  const result = await enrichArticleOnImport(
    { title: 'Source level', content: ['A short article.'], level: 'C1' },
    {
      skipTranslation: true,
      fetcher: async () => new Response('invalid', { status: 401 }),
    },
  );

  assert.equal(result.level, 'C1');
  assert.equal(result.levelRating.level, 'C1');
  assert.match(result.levelRating.summary, /C1/);
  assert.doesNotMatch(result.levelRating.summary, /默认 B1/);
});

test('recommendation scoring falls back to actual body word count', () => {
  const engine = new RecommendationEngine({
    cefrProfile: assessedB1,
    allowedBands: ['B1'],
  });
  const short = candidate('short', 'B1', 220);
  const long = candidate('long', 'B1', 1_200);

  const ranked = engine.recommend([long, short], new Map(), 2);

  assert.deepEqual(ranked.map((row) => row.articleId), ['short', 'long']);
});

test('review hits cannot keep an overlong or out-of-band article eligible', () => {
  const engine = new RecommendationEngine({
    cefrProfile: assessedB1,
    allowedBands: ['B1', 'B2'],
    cefrHardFilter: true,
  });
  const suitable = candidate('suitable', 'B1', 300);
  const long = candidate('long-review', 'B1', 10_196);
  const tooHard = candidate('too-hard', 'C1', 300);
  const proficiencyMap = new Map([['target', proficiency('target')]]);

  const ranked = scoreArticlesForReview(
    [long, tooHard, suitable],
    ['target'],
    proficiencyMap,
    engine,
    5,
  );

  assert.deepEqual(ranked.map((row) => row.articleId), ['suitable']);
});
