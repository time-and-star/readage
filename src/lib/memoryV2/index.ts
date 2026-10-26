/**
 * Memory V2.2 系统入口
 * 导出所有公共接口
 */

// 类型定义
export * from './types';

// Memory Score 计算
export {
  calculateMemoryScore,
  calculateLongTermMemoryScore,
  calculateRetention,
  calculateMasteryModifier,
  scoreToLevel,
  scoreToLevelWithHysteresis,
  calculateBatchMemoryScores,
} from './memoryScore';

// 词据聚合
export {
  aggregateArticleEvidence,
  aggregateDailyEvidence,
  getArticleGrade,
  calculateDailyGrade,
  updateDailyEvidence,
  batchAggregateDailyEvidence,
} from './evidenceAggregation';

// FSRS 集成
export {
  initializeWordMemory,
  submitFsrsReview,
  finalizeDailyEvidence,
  batchFinalizeDailyEvidence,
  shouldFinalize,
  getPendingFinalizationDates,
} from './fsrsIntegration';

// 存储接口
export type { MemoryStorage } from './storage';

// Storage implementations
export { LocalStorageMemoryStorage } from './localStorageImpl';
export {
  IndexedDbMemoryStorage,
  createPreferredMemoryStorage,
  migrateLocalStorageToIndexedDb,
} from './indexedDbImpl';
export { shouldTrackMemoryWord, isMemoryStopWord, MEMORY_STOP_WORDS } from './stopWords';

// 核心系统
export { MemorySystemV2 } from './memorySystem';
export type { WordProficiencyView } from './memorySystem';

// 推荐算法
export {
  RecommendationEngine,
  diversifyRecommendations,
  scheduleReviewArticles,
} from './recommendation';
export type {
  Article,
  ArticleCandidate,
  RecommendationScore,
  RecommendationParams,
} from './recommendation';

// React Hooks + Provider
export {
  useMemorySystem,
  useWordProficiency,
  useAllWordProficiency,
  useDueWords,
  useConfirmationWords,
  useProficiencyStats,
  useMemoryStorageError,
  memoryV2,
} from './hooks';
export { MemoryProvider, useMemoryStore } from './MemoryProvider';
export {
  MemoryV2Store,
  getDefaultMemoryStore,
  setDefaultMemoryStore,
} from './memoryStore';
export type { MemoryStoreSnapshot, MemoryStoreOptions } from './memoryStore';

// Date helpers
export {
  getLocalDateInTimeZone,
  getUtcInstantForLocalDayEnd,
  getSystemTimeZone,
} from './dateUtils';
