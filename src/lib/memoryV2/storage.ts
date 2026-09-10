/**
 * 存储层接口
 * 定义了 Memory V2.2 系统需要的所有存储操作
 */

import {
  RawWordEvent,
  ArticleWordEvidence,
  DailyWordEvidence,
  WordMemoryState,
  FinalizationTask,
} from './types';

export interface MemoryStorage {
  /** Optional durable replay support; old injected stores remain compatible. */
  getMeta?<T>(key: string): Promise<T | null>;
  setMeta?(key: string, value: unknown): Promise<void>;
  getWordDailyEvidence?(userId: string, wordId: string): Promise<DailyWordEvidence[]>;
  // ==================== 原始事件 ====================

  /**
   * 保存原始事件
   */
  saveRawEvent(event: RawWordEvent): Promise<void>;

  /**
   * 批量保存原始事件
   */
  saveRawEvents(events: RawWordEvent[]): Promise<void>;

  /**
   * 获取指定日期的原始事件
   */
  getRawEventsByDate(
    userId: string,
    wordId: string,
    localDate: string
  ): Promise<RawWordEvent[]>;

  /**
   * 获取指定日期范围内的原始事件
   */
  getRawEventsByDateRange(
    userId: string,
    wordId: string,
    startDate: string,
    endDate: string
  ): Promise<RawWordEvent[]>;

  /**
   * Delete raw events for one word on one local date (post-finalization cleanup).
   */
  deleteRawEventsByDate(
    userId: string,
    wordId: string,
    localDate: string
  ): Promise<void>;

  // ==================== 文章级词据 ====================

  /**
   * 保存文章级词据
   */
  saveArticleEvidence(evidence: ArticleWordEvidence): Promise<void>;

  /**
   * 获取文章级词据
   */
  getArticleEvidence(
    userId: string,
    wordId: string,
    articleId: string,
    localDate: string
  ): Promise<ArticleWordEvidence | null>;

  /**
   * 获取指定日期的所有文章级词据
   */
  getArticleEvidencesByDate(
    userId: string,
    wordId: string,
    localDate: string
  ): Promise<ArticleWordEvidence[]>;

  // ==================== 每日词据 ====================

  /**
   * 保存每日词据
   */
  saveDailyEvidence(evidence: DailyWordEvidence): Promise<void>;

  /**
   * 获取每日词据
   */
  getDailyEvidence(
    userId: string,
    wordId: string,
    localDate: string
  ): Promise<DailyWordEvidence | null>;

  /**
   * 获取所有未结算的每日词据
   */
  getUnfinalizedDailyEvidence(userId: string): Promise<DailyWordEvidence[]>;

  /**
   * 获取指定日期的所有未结算每日词据
   */
  getUnfinalizedDailyEvidenceByDate(
    userId: string,
    localDate: string
  ): Promise<DailyWordEvidence[]>;

  /**
   * 标记每日词据为已结算
   */
  markDailyEvidenceFinalized(
    userId: string,
    wordId: string,
    localDate: string,
    finalizedAt: string
  ): Promise<void>;

  // ==================== 记忆状态 ====================

  /**
   * 保存记忆状态
   */
  saveMemoryState(state: WordMemoryState): Promise<void>;

  /**
   * 获取记忆状态
   */
  getMemoryState(userId: string, wordId: string): Promise<WordMemoryState | null>;

  /**
   * 批量获取记忆状态
   */
  getBatchMemoryStates(
    userId: string,
    wordIds: string[]
  ): Promise<Map<string, WordMemoryState>>;

  /**
   * 获取所有记忆状态
   */
  getAllMemoryStates(userId: string): Promise<WordMemoryState[]>;

  // ==================== 结算任务 ====================

  /**
   * 创建结算任务
   */
  createFinalizationTask(task: FinalizationTask): Promise<void>;

  /**
   * 获取待处理的结算任务
   */
  getPendingFinalizationTasks(userId: string): Promise<FinalizationTask[]>;

  /**
   * 删除结算任务
   */
  deleteFinalizationTask(userId: string, localDate: string): Promise<void>;
}
