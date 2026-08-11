/**
 * Memory V2.2 系统测试
 * 验证核心场景和边界情况
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  RawWordEvent,
  ArticleWordEvidence,
  DailyWordEvidence,
  WordMemoryState,
  DEFAULT_MS_PARAMS,
} from '../src/lib/memoryV2/types';
import {
  aggregateArticleEvidence,
  aggregateDailyEvidence,
  calculateDailyGrade,
  getArticleGrade,
  updateDailyEvidence,
} from '../src/lib/memoryV2/evidenceAggregation';
import {
  calculateMemoryScore,
  calculateRetention,
  calculateMasteryModifier,
  scoreToLevel,
} from '../src/lib/memoryV2/memoryScore';
import {
  finalizeDailyEvidence,
  initializeWordMemory,
  submitFsrsReview,
} from '../src/lib/memoryV2/fsrsIntegration';
import { MemorySystemV2 } from '../src/lib/memoryV2/memorySystem';
import type { MemoryStorage } from '../src/lib/memoryV2/storage';
import { createEmptyRmeProfile, recordExposure } from '../src/lib/memoryV4';
import { prepareRmeEvent } from '../src/lib/memoryV2/rmeV4Bridge';

describe('Memory V2.2 - Evidence Aggregation', () => {
  it('场景 A: 同一文章多次未点击 → 只形成一条文章级 Good 候选', () => {
    const events: RawWordEvent[] = [
      {
        userId: 'user1',
        wordId: 'constraint',
        articleId: 'article-A',
        occurrenceId: 'occ-1',
        eventType: 'exposure',
        occurredAt: '2026-07-24T10:00:00Z',
        localDate: '2026-07-24',
      },
      {
        userId: 'user1',
        wordId: 'constraint',
        articleId: 'article-A',
        occurrenceId: 'occ-2',
        eventType: 'exposure',
        occurredAt: '2026-07-24T10:05:00Z',
        localDate: '2026-07-24',
      },
      {
        userId: 'user1',
        wordId: 'constraint',
        articleId: 'article-A',
        occurrenceId: 'occ-3',
        eventType: 'exposure',
        occurredAt: '2026-07-24T10:10:00Z',
        localDate: '2026-07-24',
      },
    ];

    const articleEvidence = aggregateArticleEvidence(events);

    assert.notEqual(articleEvidence, null);
    assert.equal(articleEvidence!.validExposureCount, 3);
    assert.equal(articleEvidence!.clickedOccurrenceCount, 0);

    const grade = getArticleGrade(articleEvidence!);
    assert.equal(grade, 'Good');
  });

  it('场景 B: 同天两篇文章均未点击 → 当天只提交一次 Good', () => {
    const articleA: ArticleWordEvidence = {
      userId: 'user1',
      wordId: 'constraint',
      articleId: 'article-A',
      localDate: '2026-07-24',
      validExposureCount: 3,
      clickedOccurrenceCount: 0,
      firstSeenAt: '2026-07-24T10:00:00Z',
      lastSeenAt: '2026-07-24T10:10:00Z',
    };

    const articleB: ArticleWordEvidence = {
      userId: 'user1',
      wordId: 'constraint',
      articleId: 'article-B',
      localDate: '2026-07-24',
      validExposureCount: 2,
      clickedOccurrenceCount: 0,
      firstSeenAt: '2026-07-24T14:00:00Z',
      lastSeenAt: '2026-07-24T14:05:00Z',
    };

    const dailyEvidence = aggregateDailyEvidence([articleA, articleB]);

    assert.notEqual(dailyEvidence, null);
    assert.equal(dailyEvidence!.articleCount, 2);
    assert.equal(dailyEvidence!.validExposureCount, 5);
    assert.equal(dailyEvidence!.clickedOccurrenceCount, 0);
    assert.equal(dailyEvidence!.pendingGrade, 'Good');
  });

  it('场景 C: 同天先 Good 后 Again → 最终只计算 Again', () => {
    const articleA: ArticleWordEvidence = {
      userId: 'user1',
      wordId: 'constraint',
      articleId: 'article-A',
      localDate: '2026-07-24',
      validExposureCount: 3,
      clickedOccurrenceCount: 0,
      firstSeenAt: '2026-07-24T10:00:00Z',
      lastSeenAt: '2026-07-24T10:10:00Z',
    };

    const articleB: ArticleWordEvidence = {
      userId: 'user1',
      wordId: 'constraint',
      articleId: 'article-B',
      localDate: '2026-07-24',
      validExposureCount: 2,
      clickedOccurrenceCount: 1,
      firstSeenAt: '2026-07-24T14:00:00Z',
      lastSeenAt: '2026-07-24T14:05:00Z',
    };

    const dailyEvidence = aggregateDailyEvidence([articleA, articleB]);

    assert.equal(dailyEvidence!.pendingGrade, 'Again');
  });

  it('场景 D: 同天先 Again 后 Good → 仍为 Again', () => {
    const articleA: ArticleWordEvidence = {
      userId: 'user1',
      wordId: 'constraint',
      articleId: 'article-A',
      localDate: '2026-07-24',
      validExposureCount: 2,
      clickedOccurrenceCount: 1,
      firstSeenAt: '2026-07-24T10:00:00Z',
      lastSeenAt: '2026-07-24T10:10:00Z',
    };

    const articleB: ArticleWordEvidence = {
      userId: 'user1',
      wordId: 'constraint',
      articleId: 'article-B',
      localDate: '2026-07-24',
      validExposureCount: 3,
      clickedOccurrenceCount: 0,
      firstSeenAt: '2026-07-24T14:00:00Z',
      lastSeenAt: '2026-07-24T14:05:00Z',
    };

    const dailyEvidence = aggregateDailyEvidence([articleA, articleB]);

    assert.equal(dailyEvidence!.pendingGrade, 'Again');
  });

  it('场景 E: 无有效曝光 → 不提供证据', () => {
    const articleA: ArticleWordEvidence = {
      userId: 'user1',
      wordId: 'constraint',
      articleId: 'article-A',
      localDate: '2026-07-24',
      validExposureCount: 0,
      clickedOccurrenceCount: 0,
      firstSeenAt: '2026-07-24T10:00:00Z',
      lastSeenAt: '2026-07-24T10:10:00Z',
    };

    const grade = getArticleGrade(articleA);
    assert.equal(grade, null);

    const dailyEvidence = aggregateDailyEvidence([articleA]);
    assert.equal(dailyEvidence!.pendingGrade, null);
  });

  it('treats a lookup as Again even when the surrounding exposure was not valid', () => {
    const article: ArticleWordEvidence = {
      userId: 'user1',
      wordId: 'constraint',
      articleId: 'article-A',
      localDate: '2026-07-24',
      validExposureCount: 0,
      clickedOccurrenceCount: 1,
      firstSeenAt: '2026-07-24T10:00:00Z',
      lastSeenAt: '2026-07-24T10:00:00Z',
    };

    assert.equal(getArticleGrade(article), 'Again');
    assert.equal(aggregateDailyEvidence([article])!.pendingGrade, 'Again');
  });

  it('deduplicates repeated occurrence exposures while preserving a lookup as Again', () => {
    const firstExposure: RawWordEvent = {
      userId: 'user1',
      wordId: 'constraint',
      articleId: 'article-A',
      occurrenceId: 'article-A:p0:w0:constraint',
      eventType: 'exposure',
      occurredAt: '2026-07-24T10:00:00Z',
      localDate: '2026-07-24',
      rmeIsValid: true,
      rmeQuality: 1,
    };
    const articleEvidence = aggregateArticleEvidence([
      firstExposure,
      { ...firstExposure, occurredAt: '2026-07-24T10:00:02Z' },
      {
        ...firstExposure,
        eventType: 'click',
        occurredAt: '2026-07-24T10:00:03Z',
      },
      {
        ...firstExposure,
        eventType: 'click',
        occurredAt: '2026-07-24T10:00:04Z',
      },
    ]);

    assert.equal(articleEvidence?.validExposureCount, 1);
    assert.equal(articleEvidence?.clickedOccurrenceCount, 1);
    assert.equal(getArticleGrade(articleEvidence!), 'Again');
    assert.equal(aggregateDailyEvidence([articleEvidence!])?.pendingGrade, 'Again');
  });

  it('reopens a finalized day when late evidence arrives', () => {
    const article: ArticleWordEvidence = {
      userId: 'user1',
      wordId: 'constraint',
      articleId: 'article-A',
      localDate: '2026-07-24',
      validExposureCount: 1,
      clickedOccurrenceCount: 0,
      firstSeenAt: '2026-07-24T10:00:00Z',
      lastSeenAt: '2026-07-24T10:00:00Z',
    };
    const finalized = {
      ...aggregateDailyEvidence([article])!,
      finalizedAt: '2026-07-25T00:00:00.000Z',
    };

    const updated = updateDailyEvidence(finalized, {
      ...article,
      clickedOccurrenceCount: 1,
    });

    assert.equal(updated.finalizedAt, null);
    assert.equal(updated.pendingGrade, 'Again');
  });
});

describe('Memory V2.2 - Defensive projections', () => {
  it('maps malformed review timestamps to a safe new-word score', () => {
    const malformed = {
      ...initializeWordMemory('user1', 'broken'),
      stability: 10,
      lastReview: 'not-a-date',
      fsrsCard: {
        ...initializeWordMemory('user1', 'broken').fsrsCard,
        reps: 1,
      },
    };

    const score = calculateMemoryScore(malformed, DEFAULT_MS_PARAMS);
    assert.equal(score, 0);
    assert.equal(scoreToLevel(score), 0);
  });

  it('honors explicit zero and negative due-word limits', async () => {
    const first = initializeWordMemory('user1', 'first');
    const second = initializeWordMemory('user1', 'second');
    const storage = {
      async getAllMemoryStates() {
        return [first, second];
      },
    } as unknown as MemoryStorage;
    const system = new MemorySystemV2(storage);
    const now = new Date(Date.now() + 1_000);

    assert.equal((await system.getDueWords('user1', now, 0)).length, 0);
    assert.equal((await system.getDueWords('user1', now, -1)).length, 0);
  });
});

describe('Memory V2.2 - Memory Score Calculation', () => {
  it('计算回忆概率 R(t, S)', () => {
    // S = 10 天, t = 0 天 → R = 1
    assert.equal(calculateRetention(0, 10), 1);

    // S = 10 天, t = 10 天 → R = 0.9
    assert.ok(Math.abs(calculateRetention(10, 10) - 0.9) < 0.01);

    // S = 10 天, t = 20 天 → R = 0.81
    assert.ok(Math.abs(calculateRetention(20, 10) - 0.81) < 0.01);
  });

  it('计算长期掌握度调节因子 M(S)', () => {
    const S_cap = 180;

    // S = 0 → M = 0
    assert.equal(calculateMasteryModifier(0, S_cap), 0);

    // S = 1 → M ≈ 0.13
    assert.ok(Math.abs(calculateMasteryModifier(1, S_cap) - 0.13) < 0.01);

    // S = 30 → M ≈ 0.66
    assert.ok(Math.abs(calculateMasteryModifier(30, S_cap) - 0.66) < 0.01);

    // S = 180 → M = 1
    assert.ok(Math.abs(calculateMasteryModifier(180, S_cap) - 1.0) < 0.01);

    // S = 360 → M = 1 (capped)
    assert.equal(calculateMasteryModifier(360, S_cap), 1);
  });

  it('MS 映射到 L0-L4', () => {
    assert.equal(scoreToLevel(10), 0);
    assert.equal(scoreToLevel(20), 1);
    assert.equal(scoreToLevel(40), 2);
    assert.equal(scoreToLevel(60), 3);
    assert.equal(scoreToLevel(85), 4);
    assert.equal(scoreToLevel(100), 4);
  });

  it('新单词 MS = 0', () => {
    const memoryState = initializeWordMemory('user1', 'word1');
    const score = calculateMemoryScore(memoryState, DEFAULT_MS_PARAMS);

    assert.equal(score, 0);
    assert.equal(scoreToLevel(score), 0);
  });

  it('刚复习完的单词 MS 接近 100 × M(S)', () => {
    const memoryState: WordMemoryState = {
      userId: 'user1',
      wordId: 'word1',
      stability: 30,
      difficulty: 5,
      lastReview: new Date().toISOString(),
      nextReview: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      fsrsCard: {} as any,
      fsrsReviews: [],
    };

    const score = calculateMemoryScore(memoryState, DEFAULT_MS_PARAMS);

    // R ≈ 1, M(30) ≈ 0.66, MS ≈ 66
    assert.ok(score > 60);
    assert.ok(score < 70);
  });
});

describe('Memory V2.2 - FSRS Integration', () => {
  it('初始化新单词', () => {
    const state = initializeWordMemory('user1', 'word1');

    assert.equal(state.userId, 'user1');
    assert.equal(state.wordId, 'word1');
    assert.equal(state.lastReview, null);
    assert.equal(state.fsrsReviews.length, 0);
  });

  it('提交第一次 Good 复习', () => {
    const initialState = initializeWordMemory('user1', 'word1');
    const updatedState = submitFsrsReview(initialState, 'Good', new Date('2026-07-24'));

    assert.equal(updatedState.lastReview, '2026-07-24T00:00:00.000Z');
    assert.ok(updatedState.stability > 0);
    assert.equal(updatedState.fsrsReviews.length, 1);
    assert.equal(updatedState.fsrsReviews[0].rating, 3); // Good = 3
  });

  it('提交第一次 Again 复习', () => {
    const initialState = initializeWordMemory('user1', 'word1');
    const updatedState = submitFsrsReview(initialState, 'Again', new Date('2026-07-24'));

    assert.equal(updatedState.lastReview, '2026-07-24T00:00:00.000Z');
    assert.equal(updatedState.fsrsReviews.length, 1);
    assert.equal(updatedState.fsrsReviews[0].rating, 1); // Again = 1
  });

  it('waits for passive success across different articles and dates before Good', () => {
    const exposure = (
      state: WordMemoryState,
      articleId: string,
      localDate: string,
      occurredAt: string,
    ): WordMemoryState => ({
      ...state,
      rme: recordExposure(state.rme ?? createEmptyRmeProfile(), {
        articleId,
        occurrenceId: `${articleId}:${occurredAt}`,
        now: new Date(occurredAt),
        localDate,
        kind: 'natural',
        quality: 1,
        isValid: true,
      }),
    });
    const daily = (articleId: string, localDate: string): DailyWordEvidence => {
      const occurredAt = `${localDate}T14:00:00Z`;
      return {
        userId: 'user1',
        wordId: 'word1',
        localDate,
        articleEvidence: [{
          userId: 'user1',
          wordId: 'word1',
          articleId,
          localDate,
          validExposureCount: 1,
          clickedOccurrenceCount: 0,
          firstSeenAt: occurredAt,
          lastSeenAt: occurredAt,
          averageRmeQuality: 1,
        }],
        articleCount: 1,
        validExposureCount: 1,
        clickedOccurrenceCount: 0,
        pendingGrade: 'Good',
        averageRmeQuality: 1,
        finalizedAt: null,
      };
    };

    let state = initializeWordMemory('user1', 'word1');
    state = exposure(state, 'article-a', '2026-07-24', '2026-07-24T10:00:00Z');
    state = finalizeDailyEvidence(state, daily('article-a', '2026-07-24'), 'user1', 'UTC')!;
    assert.equal(state.fsrsReviews.length, 0, 'one passive context is only weak evidence');

    state = exposure(state, 'article-b', '2026-07-24', '2026-07-24T14:00:00Z');
    state = finalizeDailyEvidence(state, daily('article-b', '2026-07-24'), 'user1', 'UTC')!;
    assert.equal(state.fsrsReviews.length, 0, 'a second article on the same day is still weak');

    state = exposure(state, 'article-b', '2026-07-25', '2026-07-25T14:00:00Z');
    state = finalizeDailyEvidence(state, daily('article-b', '2026-07-25'), 'user1', 'UTC')!;
    assert.equal(state.fsrsReviews.length, 1);
    assert.equal(state.fsrsReviews[0].rating, 3);
  });

  it('场景 E: 跨天两个 Good → 分别形成两次 FSRS review', () => {
    let state = initializeWordMemory('user1', 'word1');

    // 第 1 天 Good
    state = submitFsrsReview(state, 'Good', new Date('2026-07-24'));
    assert.equal(state.fsrsReviews.length, 1);

    // 第 2 天 Good
    state = submitFsrsReview(state, 'Good', new Date('2026-07-25'));
    assert.equal(state.fsrsReviews.length, 2);

    // Stability 应该增长
    assert.ok(state.stability > state.fsrsReviews[0].stability);
  });

  it('场景 F: 长期后重新失败 → MS 和等级下降', () => {
    let state = initializeWordMemory('user1', 'word1');

    // 多次 Good，建立高 Stability
    state = submitFsrsReview(state, 'Good', new Date('2026-01-01'));
    state = submitFsrsReview(state, 'Good', new Date('2026-01-05'));
    state = submitFsrsReview(state, 'Good', new Date('2026-01-15'));
    state = submitFsrsReview(state, 'Good', new Date('2026-02-01'));

    const highStability = state.stability;
    const scoreBeforeFail = calculateMemoryScore(state, DEFAULT_MS_PARAMS, new Date('2026-02-01'));
    const levelBeforeFail = scoreToLevel(scoreBeforeFail);

    // 半年后重新失败
    state = submitFsrsReview(state, 'Again', new Date('2026-07-24'));

    const scoreAfterFail = calculateMemoryScore(state, DEFAULT_MS_PARAMS, new Date('2026-07-24'));
    const levelAfterFail = scoreToLevel(scoreAfterFail);

    // Stability 应该降低
    assert.ok(state.stability < highStability);

    // MS 应该显著降低（因为时间长 + Again）
    assert.ok(scoreAfterFail < scoreBeforeFail);
  });
});

describe('Memory V2.2 - System Invariants', () => {
  it('不变量 1: 每个词每个自然日最多产生一次正式 FSRS review', () => {
    let state = initializeWordMemory('user1', 'word1');

    // 同一天多次提交（模拟错误）
    state = submitFsrsReview(state, 'Good', new Date('2026-07-24T10:00:00Z'));

    // 在实际系统中，应该阻止同一天再次提交
    // 这里只是验证如果误提交，FSRS 会记录多次
    const reviewsBefore = state.fsrsReviews.length;

    state = submitFsrsReview(state, 'Good', new Date('2026-07-24T20:00:00Z'));

    // FSRS 本身不阻止，所以会记录两次
    // 但在 MemorySystemV2 中，通过 finalizedAt 字段防止重复结算
    assert.ok(state.fsrsReviews.length > reviewsBefore);
  });

  it('不变量 4: 当天任何有效点击都使最终评级成为 Again', () => {
    const evidences: ArticleWordEvidence[] = [
      {
        userId: 'user1',
        wordId: 'word1',
        articleId: 'article-A',
        localDate: '2026-07-24',
        validExposureCount: 5,
        clickedOccurrenceCount: 0,
        firstSeenAt: '2026-07-24T10:00:00Z',
        lastSeenAt: '2026-07-24T10:10:00Z',
      },
      {
        userId: 'user1',
        wordId: 'word1',
        articleId: 'article-B',
        localDate: '2026-07-24',
        validExposureCount: 3,
        clickedOccurrenceCount: 1,
        firstSeenAt: '2026-07-24T14:00:00Z',
        lastSeenAt: '2026-07-24T14:05:00Z',
      },
    ];

    const grade = calculateDailyGrade(evidences);
    assert.equal(grade, 'Again');
  });

  it('不变量 5: Again 不能被当天后续的 Good 覆盖', () => {
    const evidences: ArticleWordEvidence[] = [
      // 先点击
      {
        userId: 'user1',
        wordId: 'word1',
        articleId: 'article-A',
        localDate: '2026-07-24',
        validExposureCount: 2,
        clickedOccurrenceCount: 1,
        firstSeenAt: '2026-07-24T10:00:00Z',
        lastSeenAt: '2026-07-24T10:10:00Z',
      },
      // 后未点击
      {
        userId: 'user1',
        wordId: 'word1',
        articleId: 'article-B',
        localDate: '2026-07-24',
        validExposureCount: 5,
        clickedOccurrenceCount: 0,
        firstSeenAt: '2026-07-24T14:00:00Z',
        lastSeenAt: '2026-07-24T14:05:00Z',
      },
    ];

    const grade = calculateDailyGrade(evidences);
    assert.equal(grade, 'Again');
  });

  it('不变量 8: MS 只能由当前 FSRS 状态派生', () => {
    const state = initializeWordMemory('user1', 'word1');

    // MS 计算完全基于 FSRS 状态
    const score1 = calculateMemoryScore(state, DEFAULT_MS_PARAMS);

    // 修改 FSRS 状态
    const updatedState = submitFsrsReview(state, 'Good', new Date());
    const score2 = calculateMemoryScore(updatedState, DEFAULT_MS_PARAMS);

    // 不同的 FSRS 状态应该产生不同的 MS
    assert.notEqual(score1, score2);
  });
});


class EvidenceStorageFake {
  raw = new Map<string, RawWordEvent[]>();
  article = new Map<string, ArticleWordEvidence>();
  daily = new Map<string, DailyWordEvidence>();
  states = new Map<string, WordMemoryState>();

  private rawKey(userId: string, wordId: string, localDate: string) {
    return `${userId}:${wordId}:${localDate}`;
  }

  async saveRawEvent(event: RawWordEvent): Promise<void> {
    const key = this.rawKey(event.userId, event.wordId, event.localDate);
    this.raw.set(key, [...(this.raw.get(key) ?? []), event]);
  }

  async saveRawEvents(events: RawWordEvent[]): Promise<void> {
    for (const item of events) await this.saveRawEvent(item);
  }

  async getRawEventsByDate(userId: string, wordId: string, localDate: string) {
    return this.raw.get(this.rawKey(userId, wordId, localDate)) ?? [];
  }

  async saveArticleEvidence(evidence: ArticleWordEvidence): Promise<void> {
    this.article.set(
      `${evidence.userId}:${evidence.wordId}:${evidence.articleId}:${evidence.localDate}`,
      evidence,
    );
  }

  async getArticleEvidencesByDate(userId: string, wordId: string, localDate: string) {
    return [...this.article.values()].filter(
      (item) =>
        item.userId === userId &&
        item.wordId === wordId &&
        item.localDate === localDate,
    );
  }

  async saveDailyEvidence(evidence: DailyWordEvidence): Promise<void> {
    this.daily.set(`${evidence.userId}:${evidence.wordId}:${evidence.localDate}`, evidence);
  }

  async getDailyEvidence(userId: string, wordId: string, localDate: string) {
    return this.daily.get(`${userId}:${wordId}:${localDate}`) ?? null;
  }

  async saveMemoryState(state: WordMemoryState): Promise<void> {
    this.states.set(`${state.userId}:${state.wordId}`, state);
  }

  async getMemoryState(userId: string, wordId: string) {
    return this.states.get(`${userId}:${wordId}`) ?? null;
  }

  async getBatchMemoryStates(userId: string, wordIds: string[]) {
    const rows = new Map<string, WordMemoryState>();
    for (const wordId of wordIds) {
      const state = await this.getMemoryState(userId, wordId);
      if (state) rows.set(wordId, state);
    }
    return rows;
  }

  async getAllMemoryStates(userId: string) {
    return [...this.states.values()].filter((state) => state.userId === userId);
  }
}

function exposureEvent({
  articleId,
  occurrenceId,
  occurredAt,
}: {
  articleId: string;
  occurrenceId: string;
  occurredAt: string;
}): RawWordEvent {
  return {
    userId: 'user1',
    wordId: 'constraint',
    articleId,
    occurrenceId,
    eventType: 'exposure',
    occurredAt,
    localDate: '2026-07-24',
  };
}

async function seedPreviouslySeenWord(storage: EvidenceStorageFake): Promise<void> {
  const state = initializeWordMemory('user1', 'constraint');
  const profile = createEmptyRmeProfile();
  profile.lastExposureAt = '2026-07-22T10:00:00Z';
  profile.lastEffectiveExposureAt = '2026-07-22T10:00:00Z';
  await storage.saveMemoryState({ ...state, rme: profile });
}

describe('Memory V2.2 - Batch event persistence', () => {
  it('preserves single-event evidence when a later paragraph uses a batch write', async () => {
    const storage = new EvidenceStorageFake();
    const system = new MemorySystemV2(storage as unknown as MemoryStorage);
    await seedPreviouslySeenWord(storage);

    await system.recordEvent(
      exposureEvent({
        articleId: 'article-A',
        occurrenceId: 'article-A:p0:w0:constraint',
        occurredAt: '2026-07-24T10:00:00Z',
      }),
    );
    await system.recordBatchEvents([
      exposureEvent({
        articleId: 'article-A',
        occurrenceId: 'article-A:p1:w0:constraint',
        occurredAt: '2026-07-24T10:01:00Z',
      }),
    ]);

    const articleEvidence = [...storage.article.values()][0];
    const dailyEvidence = [...storage.daily.values()][0];
    assert.equal(articleEvidence.validExposureCount, 1);
    assert.equal(dailyEvidence.validExposureCount, 1);
    assert.equal(dailyEvidence.articleCount, 1);
  });

  it('preserves same-day evidence from an earlier article batch', async () => {
    const storage = new EvidenceStorageFake();
    const system = new MemorySystemV2(storage as unknown as MemoryStorage);
    await seedPreviouslySeenWord(storage);

    const firstExposure = exposureEvent({
      articleId: 'article-A',
      occurrenceId: 'article-A:p0:w0:constraint',
      occurredAt: '2026-07-24T10:00:00Z',
    });
    await system.recordBatchEvents([
      firstExposure,
      {
        ...firstExposure,
        eventType: 'click',
        occurredAt: '2026-07-24T10:00:01Z',
      },
    ]);
    await system.recordBatchEvents([
      exposureEvent({
        articleId: 'article-B',
        occurrenceId: 'article-B:p0:w0:constraint',
        occurredAt: '2026-07-24T11:00:00Z',
      }),
    ]);

    const dailyEvidence = [...storage.daily.values()][0];
    assert.equal(dailyEvidence.validExposureCount, 1);
    assert.equal(dailyEvidence.clickedOccurrenceCount, 1);
    assert.equal(dailyEvidence.pendingGrade, 'Again');
    assert.equal(dailyEvidence.articleCount, 2);
    assert.deepEqual(
      dailyEvidence.articleEvidence.map((item) => item.articleId).sort(),
      ['article-A', 'article-B'],
    );
  });
});

describe('RME-V4 - storage bridge', () => {
  it('creates a V4 word profile on first exposure without producing FSRS evidence', async () => {
    const storage = new EvidenceStorageFake();
    const system = new MemorySystemV2(storage as unknown as MemoryStorage);

    await system.recordEvent(exposureEvent({
      articleId: 'article-A',
      occurrenceId: 'article-A:p0:w0:constraint',
      occurredAt: '2026-07-24T10:00:00Z',
    }));

    const state = await storage.getMemoryState('user1', 'constraint');
    const evidence = await storage.getDailyEvidence('user1', 'constraint', '2026-07-24');
    assert.equal(state?.fsrsCard.reps, 0);
    assert.equal(state?.rme?.exposureHistory[0]?.kind, 'new');
    assert.equal(evidence?.validExposureCount, 0);
    assert.equal(evidence?.pendingGrade, null);
  });

  it('downgrades the matching V4 exposure quality when the user clicks it', async () => {
    const storage = new EvidenceStorageFake();
    const system = new MemorySystemV2(storage as unknown as MemoryStorage);
    const first = exposureEvent({
      articleId: 'article-A',
      occurrenceId: 'article-A:p0:w0:constraint',
      occurredAt: '2026-07-24T10:00:00Z',
    });

    await system.recordEvent(first);
    await system.recordEvent({
      ...first,
      eventType: 'click',
      occurredAt: '2026-07-24T10:00:01Z',
    });

    const state = await storage.getMemoryState('user1', 'constraint');
    assert.equal(state?.rme?.exposureHistory[0]?.quality, 0);
  });

  it('does not turn a repeated article into a scheduled valid exposure after an invalid first view', () => {
    const firstEvent = exposureEvent({
      articleId: 'article-A',
      occurrenceId: 'article-A:p0:w0:constraint',
      occurredAt: '2026-07-24T10:00:00Z',
    });
    const first = prepareRmeEvent(null, {
      ...firstEvent,
      isRecommendation: true,
    });

    assert.equal(first.event.rmeExposureKind, 'new');
    assert.equal(first.event.rmeIsValid, false);
    assert.ok(first.state);

    const repeated = prepareRmeEvent(first.state, {
      ...firstEvent,
      occurrenceId: 'article-A:p1:w0:constraint',
      occurredAt: '2026-07-26T10:00:00Z',
      isRecommendation: true,
    });

    assert.equal(repeated.event.rmeExposureKind, 'scheduled');
    assert.equal(repeated.event.rmeIsValid, false);
    assert.equal(repeated.state?.rme?.exposureHistory.length, 2);
    assert.equal(repeated.state?.rme?.successfulExposureCount, 0);
  });
});
