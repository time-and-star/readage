import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { WordProficiencyView } from '../src/lib/memoryV2/memorySystem';
import {
  RecommendationEngine,
  articleProficiencyCoverage,
  countUniqueReviewHits,
  rankCandidatesByReviewHits,
  scheduleReviewArticles,
  scoreArticlesForReview,
  type ArticleCandidate,
} from '../src/lib/memoryV2/recommendation';
import { buildCefrRecommendationProfile } from '../src/lib/userReadingProfile';

function candidate(id: string, lemmas: string[], level = 'B1'): ArticleCandidate {
  return {
    article: {
      id,
      title: id,
      content: [lemmas.join(' ')],
      level,
      topic: 'general',
    },
    lemmas,
  };
}

function proficiency(
  wordId: string,
  level: WordProficiencyView['level'] = 1,
  nextReview = '2099-01-01T00:00:00.000Z'
): WordProficiencyView {
  return {
    wordId,
    memoryScore: 50,
    level,
    stability: 1,
    difficulty: 5,
    nextReview,
    lastReview: null,
  };
}

describe('RecommendationEngine cold-start filtering', () => {
  it('counts distinct normalized words for memory scores and unknown-word totals', () => {
    const engine = new RecommendationEngine();
    const proficiencyMap = new Map<string, WordProficiencyView>([
      ['target', proficiency('target', 1, '2020-01-01T00:00:00.000Z')],
      ['steady', proficiency('steady', 4)],
      ['other-one', proficiency('other-one', 4)],
      ['other-two', proficiency('other-two', 4)],
      ['other-three', proficiency('other-three', 4)],
    ]);
    const repeated = candidate('article', [
      'Target', 'target', ' target ', 'STEADY', 'steady', 'fresh', 'FRESH', '',
    ]);
    const distinct = candidate('article', ['target', 'steady', 'fresh']);
    const now = new Date('2026-01-01T00:00:00.000Z');
    const score = engine.scoreArticle(repeated, proficiencyMap, now);

    assert.equal(score.dueWordsCount, 1);
    assert.equal(score.learningZoneCount, 1);
    assert.equal(score.consolidationZoneCount, 1);
    assert.equal(score.unknownWordsCount, 1);
    assert.equal(score.score, engine.scoreArticle(distinct, proficiencyMap, now).score);
    assert.equal(articleProficiencyCoverage(repeated.lemmas, proficiencyMap), 2 / 3);
  });

  it('cannot meet the minimum learning-word count by repeating one word', () => {
    const engine = new RecommendationEngine();
    const proficiencyMap = new Map<string, WordProficiencyView>([
      ['target', proficiency('target')],
      ...Array.from({ length: 4 }, (_, index) => {
        const wordId = `other-${index}`;
        return [wordId, proficiency(wordId, 4)] as const;
      }),
    ]);
    const repeated = candidate('one-learning-word', [
      'target', 'target', 'target', 'target', 'target',
    ]);

    assert.equal(engine.scoreArticle(repeated, proficiencyMap).learningZoneCount, 1);
    assert.deepEqual(engine.filterCandidates([repeated], proficiencyMap), []);
  });

  it('keeps local candidates when the proficiency map is empty', () => {
    const engine = new RecommendationEngine();
    const candidates = [
      candidate('first-local', ['alpha', 'beta', 'gamma', 'delta']),
      candidate('second-local', ['epsilon', 'zeta', 'eta', 'theta']),
    ];

    assert.deepEqual(
      engine.filterCandidates(candidates, new Map()).map((item) => item.article.id),
      ['first-local', 'second-local']
    );
  });

  it('keeps candidates while the user has too little proficiency data for reliable filtering', () => {
    const engine = new RecommendationEngine();
    const candidates = [
      candidate('low-coverage-local', [
        'known',
        'unknown-1',
        'unknown-2',
        'unknown-3',
        'unknown-4',
        'unknown-5',
      ]),
    ];
    const proficiencyMap = new Map<string, WordProficiencyView>([
      ['known', proficiency('known', 4)],
      ['unrelated-1', proficiency('unrelated-1', 4)],
      ['unrelated-2', proficiency('unrelated-2', 4)],
      ['unrelated-3', proficiency('unrelated-3', 4)],
    ]);

    assert.deepEqual(engine.filterCandidates(candidates, proficiencyMap), candidates);
  });

  it('keeps candidates when the map is large but article lemma coverage is still low', () => {
    const engine = new RecommendationEngine();
    const proficiencyMap = new Map<string, WordProficiencyView>(
      Array.from({ length: 12 }, (_, index) => {
        const wordId = `tracked-${index + 1}`;
        return [wordId, proficiency(wordId, 4)] as const;
      })
    );
    const candidates = [
      candidate('mostly-untracked-local', [
        'tracked-1',
        'fresh-1',
        'fresh-2',
        'fresh-3',
        'fresh-4',
        'fresh-5',
        'fresh-6',
        'fresh-7',
        'fresh-8',
        'fresh-9',
      ]),
    ];

    // Coverage is 1/10 = 0.1, below the 0.2 threshold → cold-start keep.
    assert.deepEqual(engine.filterCandidates(candidates, proficiencyMap), candidates);

    const ranked = engine.recommend(candidates, proficiencyMap, 1);
    assert.equal(ranked[0]?.articleId, 'mostly-untracked-local');
    assert.ok(ranked[0]!.score > 0);
  });

  it('preserves unknown-ratio and learning-zone constraints once proficiency data is mature', () => {
    const engine = new RecommendationEngine();
    const proficiencyMap = new Map<string, WordProficiencyView>([
      ['learning-1', proficiency('learning-1', 1)],
      ['learning-2', proficiency('learning-2', 1)],
      ['learning-3', proficiency('learning-3', 1)],
      ['learning-4', proficiency('learning-4', 1)],
      ['learning-5', proficiency('learning-5', 1)],
      ['mastered-1', proficiency('mastered-1', 4)],
      ['mastered-2', proficiency('mastered-2', 4)],
      ['mastered-3', proficiency('mastered-3', 4)],
      ['mastered-4', proficiency('mastered-4', 4)],
      ['mastered-5', proficiency('mastered-5', 4)],
    ]);
    const candidates = [
      candidate('too-many-unknown', [
        'learning-1',
        'learning-2',
        'learning-3',
        'learning-4',
        'learning-5',
        'unknown-1',
        'unknown-2',
        'unknown-3',
      ]),
      candidate('too-few-learning-zone-words', [
        'mastered-1',
        'mastered-2',
        'mastered-3',
        'mastered-4',
        'mastered-5',
      ]),
      candidate('eligible', [
        'learning-1',
        'learning-2',
        'learning-3',
        'learning-4',
        'learning-5',
      ]),
    ];

    assert.deepEqual(
      engine.filterCandidates(candidates, proficiencyMap).map((item) => item.article.id),
      ['eligible']
    );
  });

  it('ranks empty-proficiency libraries with a non-zero cold-start score', () => {
    const engine = new RecommendationEngine({
      userLevel: 'B1',
      preferredTopics: ['idioms'],
    });
    const candidates = [
      candidate('level-match', ['alpha', 'beta', 'gamma']),
      {
        ...candidate('topic-and-level', ['delta', 'epsilon', 'zeta']),
        article: {
          id: 'topic-and-level',
          title: 'topic-and-level',
          content: ['delta epsilon zeta'],
          level: 'B1',
          topic: 'idioms',
        },
      },
    ];

    const ranked = engine.recommend(candidates, new Map(), 2);
    assert.equal(ranked.length, 2);
    assert.equal(ranked[0]?.articleId, 'topic-and-level');
    assert.ok(ranked[0]!.score > ranked[1]!.score);
    assert.match(ranked[0]!.reason, /冷启动|匹配/);
  });

  it('keeps a due-word article ahead of low-coverage cold-start candidates', () => {
    const proficiencyMap = new Map<string, WordProficiencyView>([
      ['due', proficiency('due', 1, '2020-01-01T00:00:00.000Z')],
      ...Array.from({ length: 5 }, (_, index) => {
        const wordId = `mastered-${index}`;
        return [wordId, proficiency(wordId, 4)] as const;
      }),
    ]);
    const ranked = new RecommendationEngine().recommend(
      [
        candidate('due-article', ['due']),
        candidate('untracked-article', ['untracked']),
      ],
      proficiencyMap,
      2,
      new Date('2026-01-01T00:00:00.000Z'),
    );

    assert.deepEqual(
      ranked.map((item) => item.articleId),
      ['due-article', 'untracked-article'],
    );
  });
});

describe('review hit-rate ranking', () => {
  it('keeps exact review coverage ahead of a large unrelated due-word score before truncation', () => {
    const filler = Array.from({ length: 300 }, (_, index) => `filler${index}`);
    const targets = ['alpha', 'beta', 'gamma'];
    const proficiencyMap = new Map([...targets, ...filler].map((word) =>
      [word, proficiency(word, 1, '2020-01-01T00:00:00.000Z')] as const
    ));
    const ranked = scoreArticlesForReview([
      candidate('one-requested-many-due', ['alpha', ...filler]),
      candidate('three-requested', targets),
    ], targets, proficiencyMap, new RecommendationEngine(), 1);
    assert.equal(ranked[0]?.articleId, 'three-requested');
    assert.equal(ranked[0]?.reviewWordsCount, 3);
  });
  it('reports requested unique review hits separately from all due words', () => {
    const dueAt = '2020-01-01T00:00:00.000Z';
    const proficiencyMap = new Map<string, WordProficiencyView>([
      ['alpha', proficiency('alpha', 1, dueAt)],
      ['beta', proficiency('beta')],
      ['overdue', proficiency('overdue', 1, dueAt)],
      ['legacy', proficiency('legacy', 1, dueAt)],
    ]);
    const scores = scoreArticlesForReview(
      [candidate('review', ['alpha', 'ALPHA', 'beta', 'overdue', 'legacy'])],
      ['Alpha', ' alpha ', 'BETA', 'missing', ''],
      proficiencyMap,
      new RecommendationEngine(),
      1,
      new Date('2026-01-01T00:00:00.000Z'),
    );

    assert.equal(scores[0]?.reviewWordsCount, 2);
    assert.equal(scores[0]?.dueWordsCount, 3);
    assert.match(scores[0]?.reason ?? '', /^命中 2\/3 个复习词，/);
  });

  it('counts unique target hits, not repeated lemma occurrences', () => {
    const lemmas = ['target', 'target', 'target', 'other'];
    assert.equal(countUniqueReviewHits(lemmas, new Set(['target', 'miss'])), 1);
    assert.equal(countUniqueReviewHits(lemmas, ['target', 'other']), 2);
  });

  it('normalizes review targets before matching article lemmas', () => {
    assert.equal(countUniqueReviewHits(["cambodia's"], ['Cambodia’s']), 1);
    assert.equal(countUniqueReviewHits(['well being'], ['well-being']), 1);
  });

  it('prefers articles that cover more distinct review words over longer single-word spam', () => {
    const dueWords = [
      proficiency('alpha', 1, '2020-01-01T00:00:00.000Z'),
      proficiency('beta', 1, '2020-01-01T00:00:00.000Z'),
      proficiency('gamma', 1, '2020-01-01T00:00:00.000Z'),
    ];
    // Old bug: counting lemma occurrences favored "alpha" repeated many times.
    const spamOneWord = candidate('spam-one', [
      'alpha', 'alpha', 'alpha', 'alpha', 'alpha', 'alpha',
    ]);
    const highCoverage = candidate('high-coverage', ['alpha', 'beta', 'gamma', 'filler']);

    const ranked = scheduleReviewArticles(dueWords, [spamOneWord, highCoverage], 3);
    assert.equal(ranked[0]?.article.id, 'high-coverage');
    assert.equal(ranked[1]?.article.id, 'spam-one');
  });

  it('ranks by unique review hits first, then secondary engine score', () => {
    const targets = ['due-a', 'due-b', 'due-c'];
    const lowHitsHighSecondary = candidate('low-hits', ['due-a', 'x', 'y', 'z']);
    const highHits = candidate('high-hits', ['due-a', 'due-b', 'due-c', 'w']);

    const ranked = rankCandidatesByReviewHits(
      [lowHitsHighSecondary, highHits],
      targets,
      new Map([
        ['low-hits', 999],
        ['high-hits', 1],
      ])
    );

    assert.deepEqual(
      ranked.map((item) => item.article.id),
      ['high-hits', 'low-hits']
    );
  });

  it('drops articles with zero review-word hits', () => {
    const ranked = rankCandidatesByReviewHits(
      [candidate('miss', ['unrelated']), candidate('hit', ['due-a'])],
      ['due-a']
    );
    assert.deepEqual(
      ranked.map((item) => item.article.id),
      ['hit']
    );
  });

  it('uses CEFR as the tie-breaker when review hit counts are equal', () => {
    const profile = buildCefrRecommendationProfile('B2', { confidence: 'high', useLevelFilter: true });
    const engine = new RecommendationEngine({
      userLevel: 'B2',
      cefrProfile: profile,
    });
    const target = proficiency('target', 1, '2020-01-01T00:00:00.000Z');
    const scored = engine.recommend(
      [
        candidate('c1-hit', ['target', 'filler'], 'C1'),
        candidate('b2-hit', ['target', 'filler'], 'B2'),
      ],
      new Map([['target', target]]),
      2
    );

    assert.deepEqual(scored.map((item) => item.articleId), ['b2-hit', 'c1-hit']);
    assert.ok((scored[0]?.cefrScore ?? 0) > (scored[1]?.cefrScore ?? 0));
  });

  it('gives a measurable CEFR signal at cold start and penalizes far-higher text', () => {
    const profile = buildCefrRecommendationProfile('B1', { confidence: 'high', useLevelFilter: true });
    const engine = new RecommendationEngine({
      userLevel: 'B1',
      cefrProfile: profile,
    });
    const ranked = engine.recommend(
      [
        candidate('exact', ['alpha'], 'B1'),
        candidate('far-higher', ['beta'], 'C1'),
      ],
      new Map(),
      2
    );

    assert.equal(ranked[0]?.articleId, 'exact');
    assert.ok((ranked[0]?.score ?? 0) - (ranked[1]?.score ?? 0) >= 5);
  });

  it('prefers a manageable article length during assessed cold start', () => {
    const profile = buildCefrRecommendationProfile('B1', { confidence: 'high', useLevelFilter: true });
    const engine = new RecommendationEngine({
      cefrProfile: profile,
      allowedBands: ['B2'],
    });
    const short = candidate('short-b2', ['alpha'], 'B2');
    short.article.estimatedWordCount = 320;
    const long = candidate('long-b2', ['beta'], 'B2');
    long.article.estimatedWordCount = 2400;

    const ranked = engine.recommend([long, short], new Map(), 2);
    assert.deepEqual(ranked.map((item) => item.articleId), ['short-b2', 'long-b2']);
  });

  it('applies a CEFR hard window only when enough eligible candidates remain', () => {
    const profile = buildCefrRecommendationProfile('B1', { confidence: 'high', useLevelFilter: true });
    const engine = new RecommendationEngine({
      cefrProfile: profile,
      allowedBands: ['B2'],
      minCandidatesAfterCefrFilter: 2,
    });
    const eligible = [
      candidate('b2-1', ['a'], 'B2'),
      candidate('b2-2', ['b'], 'B2'),
      candidate('c1-1', ['c'], 'C1'),
    ];
    assert.deepEqual(
      engine.filterCandidates(eligible, new Map()).map((item) => item.article.id),
      ['b2-1', 'b2-2']
    );

    const sparse = [
      candidate('b2-only', ['a'], 'B2'),
      candidate('c1-1', ['b'], 'C1'),
      candidate('c1-2', ['c'], 'C1'),
    ];
    assert.deepEqual(engine.filterCandidates(sparse, new Map()), sparse);
  });

  it('keeps protected review-hit candidates outside the CEFR window', () => {
    const profile = buildCefrRecommendationProfile('B1', { confidence: 'high', useLevelFilter: true });
    const engine = new RecommendationEngine({
      cefrProfile: profile,
      allowedBands: ['B2'],
      cefrHardFilter: true,
      minCandidatesAfterCefrFilter: 1,
    });
    const review = candidate('review-c1', ['target'], 'C1');
    const normal = candidate('normal-b2', ['other'], 'B2');

    assert.deepEqual(
      engine.filterCandidates([review, normal], new Map(), {
        protectedArticleIds: new Set(['review-c1']),
      }).map((item) => item.article.id),
      ['review-c1', 'normal-b2']
    );
  });
});
