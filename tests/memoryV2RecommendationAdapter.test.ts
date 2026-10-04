import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Article } from '../src/types';
import type { WordProficiencyView } from '../src/lib/memoryV2/memorySystem';
import {
  createMemoryV2Adapter,
  memoryV2RecommendationProvider,
  rankMagazineLemmaCandidates,
} from '../src/lib/memoryV2RecommendationAdapter';
import { memoryV2 } from '../src/lib/memoryV2/hooks';
import type { ArticleCandidate } from '../src/lib/memoryV2/recommendation';

const originalGetSystem = memoryV2.getSystem;
const originalGetUserId = memoryV2.getUserId;

function article(
  id: string,
  word: string,
  status: Article['status'] = 'In Progress'
): Article {
  return {
    id,
    title: `${word} article`,
    description: `An article about ${word}`,
    date: '2026-07-24',
    status,
    content: [word],
    level: 'B1',
  };
}

function proficiency(wordId: string): WordProficiencyView {
  return {
    wordId,
    memoryScore: 45,
    level: 1,
    stability: 1,
    difficulty: 5,
    nextReview: '2020-01-01T00:00:00.000Z',
    lastReview: null,
  };
}

function installMemorySystemStub(options: {
  dueWords: WordProficiencyView[];
  confirmationWords?: WordProficiencyView[];
  allProficiency: WordProficiencyView[];
  onGetDueWords?: (limit: number) => void;
}): void {
  const fakeSystem = {
    async getDueWords(_userId: string, _now: Date, limit: number) {
      options.onGetDueWords?.(limit);
      return options.dueWords;
    },
    async getConfirmationWords() {
      return options.confirmationWords ?? [];
    },
    async getAllWordProficiency() {
      return options.allProficiency;
    },
  };

  (memoryV2 as unknown as { getSystem: () => typeof fakeSystem }).getSystem = () => fakeSystem;
  (memoryV2 as unknown as { getUserId: () => string }).getUserId = () => 'test-user';
}

afterEach(() => {
  (memoryV2 as unknown as { getSystem: typeof originalGetSystem }).getSystem = originalGetSystem;
  (memoryV2 as unknown as { getUserId: typeof originalGetUserId }).getUserId = originalGetUserId;
});

describe('MemoryV2RecommendationAdapter targeted review', () => {
  it('prioritizes unique Opportunity Coverage without bypassing candidate filters', async () => {
    installMemorySystemStub({
      dueWords: [],
      allProficiency: [
        { ...proficiency('urgent'), opportunityScore: 90 },
        { ...proficiency('steady'), opportunityScore: 30 },
      ],
    });

    const ranked = await createMemoryV2Adapter().recommendCandidates(
      [
        { article: article('repeat-one', 'urgent'), lemmas: ['urgent', 'urgent', 'urgent'] },
        { article: article('broad-coverage', 'urgent'), lemmas: ['urgent', 'steady'] },
      ],
      { limit: 2, applyHardFilters: false },
    );

    assert.deepEqual(ranked.map((item) => item.articleId), ['broad-coverage', 'repeat-one']);
  });

  it('uses the assessed CEFR profile for local ranking', async () => {
    installMemorySystemStub({ dueWords: [], allProficiency: [] });

    const selected = await memoryV2RecommendationProvider(
      { topic: '', reviewWords: [], excludeArticleIds: [] },
      [
        { ...article('c1-article', 'c1'), level: 'C1' },
        { ...article('b2-article', 'b2'), level: 'B2' },
      ],
      {
        cefrProfile: {
          userLevel: 'B1',
          useLevelFilter: true,
          confidence: 'high',
          idealBands: ['B1', 'B2'],
          stretchBand: 'B2',
          cefrWeight: 1.3,
          preferShorter: true,
        },
      }
    );

    assert.equal(selected?.id, 'b2-article');
  });

  it('enables V5 multi-objective ranking only when a V5 profile is supplied', async () => {
    installMemorySystemStub({
      dueWords: [],
      allProficiency: [{ ...proficiency('urgent'), opportunityScore: 40 }],
    });

    const ranked = await createMemoryV2Adapter({
      v5Profile: {
        userLevel: 'B1',
        goal: 'ielts',
        preferredTopics: ['environment'],
      },
    }).recommendCandidates([
      {
        article: { ...article('memory', 'urgent'), topic: 'finance' },
        lemmas: ['urgent'],
      },
      {
        article: { ...article('interest', 'other'), topic: 'environment' },
        lemmas: ['other'],
      },
    ], { limit: 2, applyHardFilters: false });

    assert.equal(ranked[0]?.articleId, 'interest');
  });

  it('uses unique review hits in the full catalog path', async () => {
    installMemorySystemStub({ dueWords: [], allProficiency: [] });

    const spam: ArticleCandidate = {
      article: article('spam', 'alpha'),
      lemmas: ['alpha', 'alpha', 'alpha', 'alpha'],
    };
    const coverage: ArticleCandidate = {
      article: article('coverage', 'alpha'),
      lemmas: ['alpha', 'beta'],
    };

    const ranked = await rankMagazineLemmaCandidates([spam, coverage], {
      reviewWords: ['alpha', 'beta'],
      cefrProfile: {
        userLevel: 'B1',
        useLevelFilter: true,
        confidence: 'high',
        idealBands: ['B1', 'B2'],
        stretchBand: 'B2',
        cefrWeight: 1.3,
        preferShorter: true,
      },
      limit: 2,
    });

    assert.deepEqual(ranked.map((item) => item.articleId), ['coverage', 'spam']);
  });

  it('provider prioritizes the requested reviewWords instead of the system due words', async () => {
    let dueWordQueries = 0;
    installMemorySystemStub({
      dueWords: [proficiency('other')],
      allProficiency: [proficiency('target'), proficiency('other')],
      onGetDueWords: () => {
        dueWordQueries += 1;
      },
    });

    const selected = await memoryV2RecommendationProvider(
      {
        topic: '',
        reviewWords: ['target'],
        excludeArticleIds: [],
      },
      [article('target-article', 'target'), article('other-article', 'other')]
    );

    assert.equal(selected?.id, 'target-article');
    assert.equal(dueWordQueries, 0, 'explicit reviewWords must not trigger a due-word query');
  });

  it('falls back to querying due words when no explicit target words are provided', async () => {
    const requestedLimits: number[] = [];
    installMemorySystemStub({
      dueWords: [proficiency('other')],
      allProficiency: [proficiency('other')],
      onGetDueWords: (limit) => {
        requestedLimits.push(limit);
      },
    });

    const recommendations = await createMemoryV2Adapter().recommendForReview(
      [article('other-article', 'other')],
      [],
      5
    );

    assert.equal(recommendations[0]?.articleId, 'other-article');
    assert.deepEqual(requestedLimits, [10]);
  });

  it('allows a same-article reread for confirmation targets', async () => {
    const target = {
      ...proficiency('target'),
    };
    installMemorySystemStub({
      dueWords: [],
      confirmationWords: [target],
      allProficiency: [target],
    });

    const recommendations = await createMemoryV2Adapter().recommendForReview(
      [article('already-seen', 'target'), article('new-context', 'target')],
      [],
      5,
    );

    assert.deepEqual(recommendations.map((item) => item.articleId), ['already-seen', 'new-context']);

    const explicitRecommendations = await createMemoryV2Adapter().recommendForReview(
      [article('already-seen', 'target'), article('new-context', 'target')],
      ['target'],
      5,
    );
    assert.deepEqual(explicitRecommendations.map((item) => item.articleId), ['already-seen', 'new-context']);
  });

  it('keeps the legacy numeric targetReviewCount API compatible', async () => {
    const requestedLimits: number[] = [];
    installMemorySystemStub({
      dueWords: [proficiency('other')],
      allProficiency: [proficiency('other')],
      onGetDueWords: (limit) => {
        requestedLimits.push(limit);
      },
    });

    const recommendations = await createMemoryV2Adapter().recommendForReview(
      [article('other-article', 'other')],
      1,
      5
    );

    assert.equal(recommendations[0]?.articleId, 'other-article');
    assert.deepEqual(requestedLimits, [1]);
  });

  it('prefers higher unique review-word coverage even when general score favors another article', async () => {
    installMemorySystemStub({
      dueWords: [],
      allProficiency: [
        proficiency('alpha'),
        proficiency('beta'),
        proficiency('gamma'),
      ],
    });

    // Many learning-zone fillers boost the generic engine score for one-hit articles.
    const oneHitBloated: Article = {
      ...article('one-hit', 'alpha'),
      content: [
        'alpha learning1 learning2 learning3 learning4 learning5 learning6 learning7 learning8',
      ],
      status: 'In Progress',
    };
    const threeHitLean: Article = {
      ...article('three-hit', 'alpha'),
      content: ['alpha beta gamma'],
      status: 'In Progress',
    };

    const recommendations = await createMemoryV2Adapter({
      strategy: 'review-first',
    }).recommendForReview([oneHitBloated, threeHitLean], ['alpha', 'beta', 'gamma'], 2);

    assert.equal(recommendations[0]?.articleId, 'three-hit');
    assert.ok(
      (recommendations[0]?.dueWordsCount ?? 0) >= 3
      || (recommendations[0]?.reason ?? '').includes('3')
    );
  });

  it('keeps Completed articles out of normal recommendations but allows a targeted reread', async () => {
    installMemorySystemStub({
      dueWords: [],
      allProficiency: [proficiency('target')],
    });

    const selected = await memoryV2RecommendationProvider(
      {
        topic: '',
        reviewWords: [],
        excludeArticleIds: [],
      },
      [
        article('done-target', 'target', 'Completed'),
        {
          ...article('fresh-other', 'other'),
          content: ['other filler words for length'],
        },
      ]
    );

    // Normal recommendations still skip completed history.
    assert.notEqual(selected?.id, 'done-target');

    const reread = await memoryV2RecommendationProvider(
      {
        topic: '',
        reviewWords: ['target'],
        excludeArticleIds: [],
      },
      [
        article('done-target', 'target', 'Completed'),
        article('fresh-other', 'other'),
      ],
    );
    assert.equal(reread?.id, 'done-target');
  });

  it('never returns an article listed in excludeArticleIds', async () => {
    installMemorySystemStub({
      dueWords: [],
      allProficiency: [proficiency('target'), proficiency('other')],
    });

    const selected = await memoryV2RecommendationProvider(
      {
        topic: '',
        reviewWords: ['target'],
        excludeArticleIds: ['best-hit'],
      },
      [
        { ...article('best-hit', 'target'), status: 'In Progress' },
        { ...article('second-hit', 'target'), status: 'In Progress', content: ['target and more'] },
      ]
    );

    assert.equal(selected?.id, 'second-hit');
  });
});
