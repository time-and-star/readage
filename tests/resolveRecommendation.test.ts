import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Article } from '../src/types';
import { resolveRecommendationArticle } from '../src/lib/resolveRecommendation';
import { buildCefrRecommendationProfile } from '../src/lib/userReadingProfile';

function article(id: string, status: Article['status'] = 'Not Started'): Article {
  return {
    id,
    title: id,
    description: id,
    date: '2026-07-24',
    status,
    content: ['hello world'],
    level: 'B1',
  };
}

describe('resolveRecommendationArticle chain', () => {
  it('uses the entire article target pool even when the best overlap is beyond diagnostic limits', async () => {
    const targets = Array.from({ length: 60 }, (_, index) => `target${index}`);
    const resolved = await resolveRecommendationArticle(
      { topic: '', reviewWords: targets, excludeArticleIds: [] },
      {
        library: [], history: [], useFullCatalog: true,
        loadLemmaIndex: async () => ({
          version: 5, fingerprint: 'wide-target-pool', builtAt: new Date().toISOString(),
          articleCount: 2, vocab: targets,
          articles: [
            { id: 'early-one', title: 'Early', level: 'B1', wordCount: 200, lemmaIndices: [0] },
            { id: 'late-fifteen', title: 'Broad', level: 'B1', wordCount: 200,
              lemmaIndices: Array.from({ length: 15 }, (_, index) => index + 45) },
          ],
        }),
        rankCatalog: async (candidates, options) => {
          assert.deepEqual(options.reviewWords, targets);
          const targetSet = new Set(options.reviewWords);
          return candidates.map((candidate) => {
            const hits = candidate.lemmas.filter((word) => targetSet.has(word)).length;
            return {
              articleId: candidate.article.id, score: hits, reviewWordsCount: hits,
              dueWordsCount: hits, learningZoneCount: hits, consolidationZoneCount: 0,
              unknownWordsCount: 0, averageMemoryScore: 0, reason: '',
            };
          }).sort((a, b) => b.score - a.score);
        },
        loadArticleById: async (id) => article(id, 'In Progress'),
        localProvider: async () => assert.fail('catalog should find the broader match'),
        libraryFallback: () => assert.fail('catalog should find the broader match'),
        aiPost: async () => assert.fail('catalog should find the broader match'),
      },
    );
    assert.equal(resolved?.article.id, 'late-fifteen');
    assert.equal(resolved?.source, 'full_catalog');
  });

  it('uses fifteen concrete generation targets from a wider article search pool', async () => {
    const targets = Array.from({ length: 60 }, (_, index) => `target${index}`);
    const selected = targets.slice(0, 15);
    const resolved = await resolveRecommendationArticle(
      { topic: '', reviewWords: targets, excludeArticleIds: [] },
      {
        library: [], history: [], useFullCatalog: false,
        localProvider: async () => null, libraryFallback: () => null,
        aiPost: async (request) => {
          assert.deepEqual(request.reviewWords, selected);
          return { result: { title: 'Generated', description: 'Broad review',
            paragraphs: [selected.join(' ')], keyWords: [] } } as never;
        },
      },
    );
    assert.deepEqual(resolved?.article.embeddedReviewWords, selected);
  });

  it('returns Memory V2 local hits without calling AI or library fallback', async () => {
    let aiCalls = 0;
    let libraryCalls = 0;
    const local = article('local-hit');

    const resolved = await resolveRecommendationArticle(
      { topic: 'Idioms', reviewWords: [], excludeArticleIds: [] },
      {
        library: [local],
        history: [],
        useFullCatalog: false,
        localProvider: async () => local,
        libraryFallback: () => {
          libraryCalls += 1;
          return null;
        },
        aiPost: async () => {
          aiCalls += 1;
          throw new Error('AI should not run');
        },
      }
    );

    assert.equal(resolved?.source, 'local_memory');
    assert.equal(resolved?.article.id, 'local-hit');
    assert.equal(aiCalls, 0);
    assert.equal(libraryCalls, 0);
  });

  it('uses library fallback before AI when Memory V2 returns null', async () => {
    let aiCalls = 0;
    const libraryHit = article('library-hit');

    const resolved = await resolveRecommendationArticle(
      { topic: 'Idioms', reviewWords: [], excludeArticleIds: [] },
      {
        library: [libraryHit],
        history: [],
        useFullCatalog: false,
        localProvider: async () => null,
        libraryFallback: () => libraryHit,
        aiPost: async () => {
          aiCalls += 1;
          throw new Error('AI should not run when library has candidates');
        },
      }
    );

    assert.equal(resolved?.source, 'library_fallback');
    assert.equal(resolved?.article.id, 'library-hit');
    assert.equal(aiCalls, 0);
  });

  it('calls AI only when both Memory V2 and library fallback miss', async () => {
    let aiCalls = 0;

    const resolved = await resolveRecommendationArticle(
      { topic: 'Idioms', reviewWords: ['target'], excludeArticleIds: [] },
      {
        library: [],
        history: [],
        userLevel: 'C1',
        useFullCatalog: false,
        localProvider: async () => null,
        libraryFallback: () => null,
        aiPost: async () => {
          aiCalls += 1;
          return {
            result: {
              title: 'AI Article',
              description: 'Generated',
              paragraphs: ['Hello target.'],
              keyWords: ['target'],
            },
          } as never;
        },
      }
    );

    assert.equal(aiCalls, 1);
    assert.equal(resolved?.source, 'ai');
    assert.equal(resolved?.article.title, 'AI Article');
    assert.equal(resolved?.article.source, 'ai_generated');
    assert.equal(resolved?.article.level, 'C1');
    assert.deepEqual(resolved?.article.embeddedReviewWords, ['target']);
  });

  it('passes the same CEFR profile to catalog and local recommendation paths', async () => {
    const profile = buildCefrRecommendationProfile('B2', { confidence: 'high', useLevelFilter: true });
    let catalogProfile: unknown;
    let localProfile: unknown;

    const catalogArticle = article('catalog-article', 'In Progress');
    const resolvedCatalog = await resolveRecommendationArticle(
      { topic: 'Current Affairs', reviewWords: [], excludeArticleIds: [] },
      {
        library: [],
        history: [],
        userLevel: profile.userLevel,
        memoryOptions: { cefrProfile: profile },
        useFullCatalog: true,
        loadLemmaIndex: async () => ({
          version: 1 as const,
          fingerprint: 'profile-test',
          builtAt: new Date().toISOString(),
          articleCount: 1,
          vocab: ['policy'],
          articles: [{ id: 'catalog-article', title: 'Policy', level: 'B2', lemmaIndices: [0] }],
        }),
        rankCatalog: async (candidates, options) => {
          catalogProfile = options.cefrProfile;
          return [{
            articleId: candidates[0]!.article.id,
            score: 1,
            dueWordsCount: 0,
            learningZoneCount: 0,
            consolidationZoneCount: 0,
            unknownWordsCount: 0,
            averageMemoryScore: 0,
            reason: 'test',
          }];
        },
        loadArticleById: async () => catalogArticle,
        localProvider: async (_request, _library, options) => {
          localProfile = options.cefrProfile;
          return null;
        },
        libraryFallback: () => null,
        aiPost: async () => {
          throw new Error('AI should not run');
        },
      }
    );

    assert.equal(resolvedCatalog?.source, 'full_catalog');
    assert.equal(catalogProfile, profile);

    await resolveRecommendationArticle(
      { topic: '', reviewWords: [], excludeArticleIds: [] },
      {
        library: [],
        history: [],
        userLevel: profile.userLevel,
        memoryOptions: { cefrProfile: profile },
        useFullCatalog: false,
        localProvider: async (_request, _library, options) => {
          localProfile = options.cefrProfile;
          return article('local-profile-hit');
        },
        libraryFallback: () => null,
        aiPost: async () => {
          throw new Error('AI should not run');
        },
      }
    );

    assert.equal(localProfile, profile);
  });

  it('rethrows AbortError so callers can cancel without a false success', async () => {
    const abortError = new Error('Aborted');
    abortError.name = 'AbortError';

    await assert.rejects(
      () =>
        resolveRecommendationArticle(
          { topic: 'Idioms', reviewWords: [], excludeArticleIds: [] },
          {
            library: [],
            history: [],
            useFullCatalog: false,
            localProvider: async () => null,
            libraryFallback: () => null,
            aiPost: async () => {
              throw abortError;
            },
          }
        ),
      (error: unknown) => error instanceof Error && error.name === 'AbortError'
    );
  });

  it('auto-excludes history article ids so the same piece is never re-recommended', async () => {
    const seenInHistory = article('already-read', 'Completed');
    const fresh = article('fresh-local', 'In Progress');
    let receivedExclude: string[] = [];

    const resolved = await resolveRecommendationArticle(
      { topic: 'Idioms', reviewWords: [], excludeArticleIds: ['feed-seen'] },
      {
        library: [seenInHistory, fresh],
        history: [seenInHistory],
        useFullCatalog: false,
        localProvider: async (request) => {
          receivedExclude = request.excludeArticleIds;
          // Simulate provider respecting exclude list.
          if (request.excludeArticleIds.includes('fresh-local')) return null;
          if (request.excludeArticleIds.includes('already-read')) {
            return fresh;
          }
          return seenInHistory;
        },
        libraryFallback: (_library, _history, excluded) => {
          if (excluded.has('fresh-local')) return null;
          return fresh;
        },
        aiPost: async () => {
          throw new Error('AI should not run');
        },
      }
    );

    assert.ok(receivedExclude.includes('already-read'));
    assert.ok(receivedExclude.includes('feed-seen'));
    assert.equal(resolved?.article.id, 'fresh-local');
  });

  it('allows targeted review to reopen a completed history article', async () => {
    const reread = article('already-read', 'Completed');
    const resolved = await resolveRecommendationArticle(
      { topic: 'Idioms', reviewWords: ['x'], excludeArticleIds: [] },
      {
        library: [reread],
        history: [reread],
        useFullCatalog: false,
        localProvider: async (request) =>
          request.excludeArticleIds.includes('already-read') ? null : reread,
        libraryFallback: () => null,
        aiPost: async () => {
          throw new Error('AI should not run when a review reread is available');
        },
      }
    );

    assert.equal(resolved?.source, 'local_memory');
    assert.equal(resolved?.article.id, 'already-read');
  });

  it('ranks the full lemma catalog then hydrates only the winning article', async () => {
    const hydrated = article('mag:full-1', 'In Progress');
    hydrated.content = ['policy and trade shape markets'];
    let hydrateCalls = 0;
    let aiCalls = 0;

    const resolved = await resolveRecommendationArticle(
      { topic: 'Current Affairs', reviewWords: ['policy'], excludeArticleIds: [] },
      {
        library: [],
        history: [],
        useFullCatalog: true,
        loadLemmaIndex: async () => ({
          version: 1 as const,
          fingerprint: 'test',
          builtAt: new Date().toISOString(),
          articleCount: 2,
          vocab: ['policy', 'trade', 'markets', 'banana'],
          articles: [
            {
              id: 'mag:full-1',
              title: 'Trade',
              level: 'B2',
              topic: 'Current Affairs',
              lemmaIndices: [0, 1, 2],
            },
            {
              id: 'mag:full-2',
              title: 'Fruit',
              level: 'A2',
              topic: 'Food',
              lemmaIndices: [3],
            },
          ],
        }),
        loadArticleById: async (id) => {
          hydrateCalls += 1;
          return id === hydrated.id ? hydrated : null;
        },
        rankCatalog: async (candidates) =>
          candidates
            .map((candidate) => ({
              articleId: candidate.article.id,
              score: candidate.lemmas.includes('policy') ? 100 : 1,
              dueWordsCount: candidate.lemmas.includes('policy') ? 1 : 0,
              learningZoneCount: 0,
              consolidationZoneCount: 0,
              unknownWordsCount: 0,
              averageMemoryScore: 0,
              reason: 'test',
            }))
            .sort((a, b) => b.score - a.score),
        localProvider: async () => null,
        libraryFallback: () => null,
        aiPost: async () => {
          aiCalls += 1;
          throw new Error('AI should not run');
        },
      }
    );

    assert.equal(resolved?.source, 'full_catalog');
    assert.equal(resolved?.article.id, 'mag:full-1');
    assert.equal(hydrateCalls, 1);
    assert.equal(aiCalls, 0);
  });

  it('falls back when the catalog winner is outside recommendation bounds', async () => {
    const fallback = article('safe-fallback', 'In Progress');
    let hydrateCalls = 0;

    const resolved = await resolveRecommendationArticle(
      { topic: 'Current Affairs', reviewWords: ['target'], excludeArticleIds: [] },
      {
        library: [],
        history: [],
        userLevel: 'B1',
        useFullCatalog: true,
        loadLemmaIndex: async () => ({
          version: 1 as const,
          fingerprint: 'long-article-test',
          builtAt: new Date().toISOString(),
          articleCount: 1,
          vocab: ['target'],
          articles: [{
            id: 'catalog-long-c1',
            title: 'Long C1',
            level: 'C1',
            wordCount: 10_196,
            lemmaIndices: [0],
          }],
        }),
        rankCatalog: async (candidates) => [{
          articleId: candidates[0]!.article.id,
          score: 10_000,
          dueWordsCount: 1,
          learningZoneCount: 0,
          consolidationZoneCount: 0,
          unknownWordsCount: 0,
          averageMemoryScore: 0,
          reason: 'review hit',
        }],
        loadArticleById: async () => {
          hydrateCalls += 1;
          return { ...fallback, id: 'catalog-long-c1', level: 'C1', content: ['target'] };
        },
        localProvider: async () => null,
        libraryFallback: () => fallback,
        aiPost: async () => {
          throw new Error('AI should not run when fallback is available');
        },
      }
    );

    assert.equal(resolved?.source, 'library_fallback');
    assert.equal(resolved?.article.id, 'safe-fallback');
    assert.equal(hydrateCalls, 0);
  });
});
