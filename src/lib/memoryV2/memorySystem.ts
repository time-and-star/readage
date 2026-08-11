/**
 * Memory V2.2 核心协调模块
 * 统一管理事件记录、词据聚合、FSRS 更新和 MS 计算
 */

import {
  RawWordEvent,
  ArticleWordEvidence,
  DailyWordEvidence,
  WordMemoryState,
  MemoryScoreParams,
  DEFAULT_MS_PARAMS,
} from './types';
import { MemoryStorage } from './storage';
import {
  aggregateArticleEvidence,
  aggregateDailyEvidence,
  updateDailyEvidence,
  batchAggregateDailyEvidence,
} from './evidenceAggregation';
import {
  initializeWordMemory,
  finalizeDailyEvidence,
  batchFinalizeDailyEvidence,
  getPendingFinalizationDates,
} from './fsrsIntegration';
import {
  calculateMemoryScore,
  calculateBatchMemoryScores,
  scoreToLevel,
  scoreToLevelWithHysteresis,
} from './memoryScore';
import { prepareRmeEvent, projectRmeProfile, rmeProfileForState } from './rmeV4Bridge';
import { stageFromConfidence } from '../memoryV4';

export interface WordProficiencyView {
  wordId: string;
  memoryScore: number;
  level: 0 | 1 | 2 | 3 | 4;
  stability: number;
  difficulty: number;
  nextReview: string;
  lastReview: string | null;
  confidence?: number;
  opportunityScore?: number;
  memoryStage?: 0 | 1 | 2 | 3 | 4;
  isIntroduced?: boolean;
  status?: 'introduced' | 'learning' | 'mastered';
}

export interface WordProficiencyStats {
  total: number;
  byLevel: Record<number, number>;
  averageScore: number;
  introducedCount: number;
  learningCount: number;
  masteredCount: number;
  dueCount: number;
}

export const DEFAULT_REVIEW_QUEUE_LIMIT = 5;

function addRmeProjection(
  state: WordMemoryState,
  view: WordProficiencyView,
  now: Date,
): WordProficiencyView {
  const projected = projectRmeProfile(rmeProfileForState(state), state, now);
  return {
    ...view,
    confidence: projected.confidence,
    opportunityScore: projected.opportunityScore,
    memoryStage: stageFromConfidence(projected.confidence),
  };
}

export class MemorySystemV2 {
  constructor(
    private storage: MemoryStorage,
    private params: MemoryScoreParams = DEFAULT_MS_PARAMS
  ) {}

  /**
   * 记录原始事件
   * 实时更新文章级和每日级词据
   */
  async recordEvent(event: RawWordEvent): Promise<void> {
    const { userId, wordId, articleId, localDate } = event;
    const currentState = await this.storage.getMemoryState(userId, wordId);
    const prepared = prepareRmeEvent(currentState, event);
    const normalizedEvent = prepared.event;

    // 1. 保存原始事件
    await this.storage.saveRawEvent(normalizedEvent);

    // 2. 获取当天该单词在该文章中的所有事件
    const articleEvents = await this.storage.getRawEventsByDate(userId, wordId, localDate);
    const articleSpecificEvents = articleEvents.filter((e) => e.articleId === articleId);

    // 3. 聚合文章级词据
    const articleEvidence = aggregateArticleEvidence(articleSpecificEvents);
    if (articleEvidence) {
      await this.storage.saveArticleEvidence(articleEvidence);
    }

    // 4. 获取当天所有文章的词据
    const allArticleEvidences = await this.storage.getArticleEvidencesByDate(
      userId,
      wordId,
      localDate
    );

    // 5. 聚合或更新每日词据
    let dailyEvidence = await this.storage.getDailyEvidence(userId, wordId, localDate);

    if (!dailyEvidence) {
      // 首次创建
      dailyEvidence = aggregateDailyEvidence(allArticleEvidences);
    } else if (articleEvidence) {
      // 更新现有词据
      dailyEvidence = updateDailyEvidence(dailyEvidence, articleEvidence);
    }

    if (dailyEvidence) {
      await this.storage.saveDailyEvidence(dailyEvidence);
    }

    if (prepared.state) {
      await this.storage.saveMemoryState(prepared.state);
    }
  }

  /**
   * 批量记录事件（用于离线同步或批量导入）
   */
  async recordBatchEvents(events: RawWordEvent[]): Promise<void> {
    if (events.length === 0) return;

    const preparedEvents: RawWordEvent[] = [];
    const preparedStates = new Map<string, WordMemoryState | null>();
    for (const event of events) {
      const key = `${event.userId}:${event.wordId}`;
      const current = preparedStates.has(key)
        ? preparedStates.get(key) || null
        : await this.storage.getMemoryState(event.userId, event.wordId);
      const prepared = prepareRmeEvent(current, event);
      preparedEvents.push(prepared.event);
      preparedStates.set(key, prepared.state);
    }

    // 1. Persist the raw batch before rebuilding derived evidence.
    await this.storage.saveRawEvents(preparedEvents);

    for (const state of preparedStates.values()) {
      if (state) await this.storage.saveMemoryState(state);
    }

    // 2. Collect each affected user + word + date combination.
    const affectedWordDates = new Map<string, RawWordEvent>();
    for (const event of events) {
      const key = JSON.stringify([event.userId, event.wordId, event.localDate]);
      affectedWordDates.set(key, event);
    }

    // 3. Rebuild from all persisted events so existing same-day evidence is preserved.
    for (const event of affectedWordDates.values()) {
      const persistedEvents = await this.storage.getRawEventsByDate(
        event.userId,
        event.wordId,
        event.localDate
      );
      const dailyEvidence = batchAggregateDailyEvidence(persistedEvents).get(event.wordId);
      if (!dailyEvidence) continue;

      // 4. Persist the complete daily and per-article evidence.
      await this.storage.saveDailyEvidence(dailyEvidence);
      for (const articleEvidence of dailyEvidence.articleEvidence) {
        await this.storage.saveArticleEvidence(articleEvidence);
      }
    }
  }

  /**
   * 结算历史未结算的日期
   * 在应用启动或用户进入新一天时调用
   */
  async finalizeHistoricalDates(userId: string, userTimezone: string): Promise<void> {
    // 1. 获取所有未结算的每日词据
    const unfinalizedEvidences = await this.storage.getUnfinalizedDailyEvidence(userId);

    // 2. 找出需要结算的日期
    const pendingDates = getPendingFinalizationDates(unfinalizedEvidences, userTimezone);

    if (pendingDates.length === 0) return;

    // 3. 按日期结算
    for (const localDate of pendingDates) {
      await this.finalizeDate(userId, localDate, userTimezone);
    }
  }

  /**
   * 结算指定日期的所有单词
   */
  private async finalizeDate(
    userId: string,
    localDate: string,
    userTimezone: string
  ): Promise<void> {
    // 1. 获取该日期的所有未结算词据
    const dailyEvidences = await this.storage.getUnfinalizedDailyEvidenceByDate(
      userId,
      localDate
    );

    if (dailyEvidences.length === 0) return;

    // 2. 获取所有涉及单词的记忆状态
    const wordIds = dailyEvidences.map((e) => e.wordId);
    const memoryStates = await this.storage.getBatchMemoryStates(userId, wordIds);

    // 3. 批量结算并更新 FSRS
    const updatedStates = batchFinalizeDailyEvidence(
      memoryStates,
      new Map(dailyEvidences.map((e) => [e.wordId, e])),
      userId,
      userTimezone
    );

    // 4. 保存更新后的记忆状态
    for (const state of updatedStates.values()) {
      await this.storage.saveMemoryState(state);
    }

    // 5. 标记所有词据为已结算，并清理已结算日的 raw events 以控制存储体积
    const now = new Date().toISOString();
    for (const evidence of dailyEvidences) {
      await this.storage.deleteRawEventsByDate(userId, evidence.wordId, localDate);
      await this.storage.markDailyEvidenceFinalized(
        userId,
        evidence.wordId,
        localDate,
        now
      );
    }
  }

  /**
   * 获取单词的熟练度视图（包含实时 MS 和等级）
   */
  async getWordProficiency(
    userId: string,
    wordId: string,
    currentTime: Date = new Date()
  ): Promise<WordProficiencyView | null> {
    const memoryState = await this.storage.getMemoryState(userId, wordId);

    if (!memoryState) {
      return null;
    }

    const memoryScore = calculateMemoryScore(memoryState, this.params, currentTime);
    const level = scoreToLevel(memoryScore);

    return addRmeProjection(memoryState, {
      wordId,
      memoryScore,
      level,
      stability: memoryState.stability,
      difficulty: memoryState.difficulty,
      nextReview: memoryState.nextReview,
      lastReview: memoryState.lastReview,
      isIntroduced: memoryState.fsrsReviews.length === 0,
      status: memoryState.fsrsReviews.length === 0
        ? 'introduced'
        : level === 4 ? 'mastered' : 'learning',
    }, currentTime);
  }

  /**
   * 批量获取多个单词的熟练度
   */
  async getBatchWordProficiency(
    userId: string,
    wordIds: string[],
    currentTime: Date = new Date()
  ): Promise<Map<string, WordProficiencyView>> {
    const memoryStates = await this.storage.getBatchMemoryStates(userId, wordIds);
    const scores = calculateBatchMemoryScores(
      Array.from(memoryStates.values()),
      this.params,
      currentTime
    );

    const proficiencies = new Map<string, WordProficiencyView>();

    for (const [wordId, memoryState] of memoryStates.entries()) {
      const memoryScore = scores.get(wordId) || 0;
      const level = scoreToLevel(memoryScore);

      proficiencies.set(wordId, addRmeProjection(memoryState, {
        wordId,
        memoryScore,
        level,
        stability: memoryState.stability,
        difficulty: memoryState.difficulty,
        nextReview: memoryState.nextReview,
        lastReview: memoryState.lastReview,
        isIntroduced: memoryState.fsrsReviews.length === 0,
        status: memoryState.fsrsReviews.length === 0
          ? 'introduced'
          : level === 4 ? 'mastered' : 'learning',
      }, currentTime));
    }

    return proficiencies;
  }

  /**
   * 获取所有单词的熟练度
   */
  async getAllWordProficiency(
    userId: string,
    currentTime: Date = new Date()
  ): Promise<WordProficiencyView[]> {
    const memoryStates = await this.storage.getAllMemoryStates(userId);
    const scores = calculateBatchMemoryScores(memoryStates, this.params, currentTime);

    return memoryStates.map((state) => {
      const memoryScore = scores.get(state.wordId) || 0;
      const level = scoreToLevel(memoryScore);

      return addRmeProjection(state, {
        wordId: state.wordId,
        memoryScore,
        level,
        stability: state.stability,
        difficulty: state.difficulty,
        nextReview: state.nextReview,
        lastReview: state.lastReview,
        isIntroduced: state.fsrsReviews.length === 0,
        status: state.fsrsReviews.length === 0
          ? 'introduced'
          : level === 4 ? 'mastered' : 'learning',
      }, currentTime);
    });
  }

  /**
   * 获取需要复习的单词
   */
  async getDueWords(
    userId: string,
    currentTime: Date = new Date(),
    limit?: number
  ): Promise<WordProficiencyView[]> {
    const allProficiency = await this.getAllWordProficiency(userId, currentTime);

    // 筛选出到期的单词
    const dueWords = allProficiency.filter((p) => {
      const nextReviewTime = new Date(p.nextReview);
      return p.isIntroduced !== true && nextReviewTime <= currentTime;
    });

    // 按到期时间排序（越早到期的越靠前）
    dueWords.sort((a, b) => {
      return (
        new Date(a.nextReview).getTime() - new Date(b.nextReview).getTime()
        || a.wordId.localeCompare(b.wordId)
      );
    });

    if (limit !== undefined) {
      return limit > 0 ? dueWords.slice(0, Math.floor(limit)) : [];
    }

    return dueWords;
  }

  /**
   * 获取熟练度统计
   */
  async getProficiencyStats(
    userId: string,
    currentTime: Date = new Date(),
  ): Promise<WordProficiencyStats> {
    const allProficiency = await this.getAllWordProficiency(userId, currentTime);
    const now = currentTime;

    const byLevel: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
    let totalScore = 0;
    let introducedCount = 0;
    let learningCount = 0;
    let masteredCount = 0;
    let dueCount = 0;

    for (const p of allProficiency) {
      byLevel[p.level]++;
      totalScore += p.memoryScore;
      if (p.isIntroduced) {
        introducedCount++;
      } else if (p.level === 4) {
        masteredCount++;
      } else {
        learningCount++;
      }

      if (!p.isIntroduced && new Date(p.nextReview) <= now) {
        dueCount++;
      }
    }

    return {
      total: allProficiency.length,
      byLevel,
      averageScore: allProficiency.length > 0 ? totalScore / allProficiency.length : 0,
      introducedCount,
      learningCount,
      masteredCount,
      dueCount,
    };
  }
}
