import type { RmeExposureKind, RmeMemoryProfile } from '../memoryV4/types';
import type { FlashcardSchedulingPolicy } from '../flashcardScheduling';

/**
 * Memory Confidence Model V2.2
 * 每日词据聚合 + FSRS 双层记忆状态
 */

/** 原始事件类型 */
export type RawEventType = 'exposure' | 'click';

/** Optional RME-V4 signals collected during normal reading. */
export interface MemoryExposureSignals {
  /** Stable timestamp for all cumulative snapshots of one reading encounter. */
  exposureOccurredAt?: string;
  isRecommendation?: boolean;
  dwellTimeMs?: number;
  expectedDwellTimeMs?: number;
  contextText?: string;
}

/** 原始行为事件（完整保留） */
export interface RawWordEvent extends MemoryExposureSignals {
  userId: string;
  wordId: string;
  articleId: string;
  /** 文章中的具体出现位置 */
  occurrenceId: string;
  eventType: RawEventType;
  /** New lookups record assistance, without claiming an unsuccessful recall. */
  lookupOnly?: true;
  occurredAt: string;
  /** 用户时区计算的自然日（YYYY-MM-DD） */
  localDate: string;
  /** V4 classification and quality are optional for V2.2 compatibility. */
  rmeExposureKind?: RmeExposureKind;
  rmeQuality?: number;
  rmeIsValid?: boolean;
}

/** 文章级词据 */
export interface ArticleWordEvidence {
  userId: string;
  wordId: string;
  articleId: string;
  localDate: string;
  /** 有效曝光次数 */
  validExposureCount: number;
  /** 点击的occurrence数 */
  clickedOccurrenceCount: number;
  /** Missing on old data: all its clicks retain their historical failure meaning. */
  recallFailureCount?: number;
  /** Latest failure; assistance later that day must not move its recall time. */
  lastRecallFailureAt?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  /** Average RME quality of valid exposure events, when V4 metadata exists. */
  averageRmeQuality?: number;
}

/** 每日词据聚合 */
export interface DailyWordEvidence {
  userId: string;
  wordId: string;
  localDate: string;
  /** 文章证据列表 */
  articleEvidence: ArticleWordEvidence[];
  /** 当天涉及的文章数 */
  articleCount: number;
  /** 总有效曝光数 */
  validExposureCount: number;
  /** 总点击occurrence数 */
  clickedOccurrenceCount: number;
  recallFailureCount?: number;
  /** Legacy reading summary; Good here is exposure quality, never a verified FSRS success. */
  pendingGrade: 'Good' | 'Again' | null;
  /** Average quality across valid exposures for this day. */
  averageRmeQuality?: number;
  /** 最终结算时间（UTC ISO） */
  finalizedAt: string | null;
}

/** FSRS 评级 */
export type FsrsGrade = 'Again' | 'Good';

export type VerificationOutcome = 'recognized' | 'incorrect' | 'uncertain' | 'guessed' | 'skipped';
/** V6 separates a fresh recall from immediate rehearsal of an exposed answer. */
export interface FlashcardRecallEvidence {
  kind: 'independent_recall' | 'answer_rehearsal';
  answerExposedAt?: string;
  /** A completed task for a different word after this word's answer exposure. */
  interveningWord?: string;
}
export interface ReadingVerificationInput {
  attemptId: string;
  questionId: string;
  wordId: string;
  articleId: string;
  outcome: VerificationOutcome;
  selectedOptionId?: string;
  /** Retained to avoid reusing a generated test sentence on a later pause. */
  questionSentence?: string;
  /** The reading task is contextual choice evidence, distinct from free recall. */
  readingTask?: { type: 'context_choice'; contextVisible: true; answerExposed: boolean;
    mapping: 'hard_on_correct' | 'practice_only' };
  purpose?: 'delayed_verification' | 'immediate_practice';
  /** Frozen when a formal recall is first saved; absent on legacy journal entries. */
  scheduling?: FlashcardSchedulingPolicy;
}
/** Free recall from a flipped word card, stored in the existing recall journal. */
export interface FlashcardReviewInput extends Omit<ReadingVerificationInput, 'purpose'> {
  purpose: 'flashcard_review';
  rating: 1 | 2 | 3 | 4;
  /** V4 submission guard from the displayed card; never part of recall history. */
  expectedReps?: number;
  evidence?: FlashcardRecallEvidence;
}
/** An explicit correction replaces one saved recall, rather than adding another review. */
export interface FlashcardReviewCorrectionInput {
  correctionId: string;
  attemptId: string;
  wordId: string;
  rating: 1 | 2 | 3 | 4;
  expectedRevision: number;
}
export interface FlashcardReviewRevision {
  correctionId: string;
  revision: number;
  previousRating: 1 | 2 | 3 | 4;
  rating: 1 | 2 | 3 | 4;
  correctedAt: string;
}
export type ReadingVerificationEvidence = (ReadingVerificationInput | FlashcardReviewInput) & {
  userId: string;
  occurredAt: string;
  localDate: string;
  timezone: string;
  originalFlashcardRating?: 1 | 2 | 3 | 4;
  flashcardRevisions?: FlashcardReviewRevision[];
}

/** 单词记忆状态（FSRS 主记录） */
export interface WordMemoryState {
  userId: string;
  wordId: string;
  /** Actual lookup time, independent of the older matching exposure timestamp. */
  lastAssistedAt?: string;
  /** FSRS Stability (days) */
  stability: number;
  /** FSRS Difficulty */
  difficulty: number;
  /** 上次正式结算时间（UTC ISO） */
  lastReview: string | null;
  /** 下次建议复现时间（UTC ISO） */
  nextReview: string;
  /** 完整 FSRS 卡片状态 */
  fsrsCard: {
    due: string;
    stability: number;
    difficulty: number;
    elapsedDays: number;
    scheduledDays: number;
    learningSteps: number;
    reps: number;
    lapses: number;
    state: number;
    lastReview?: string;
    /** Product next-day confirmation survives any earlier V6 model reviews. */
    confirmationDue?: string;
  };
  /** FSRS 历史评审记录 */
  fsrsReviews: Array<{
    rating: number;
    state: number;
    due: string;
    stability: number;
    difficulty: number;
    elapsedDays: number;
    lastElapsedDays: number;
    scheduledDays: number;
    learningSteps: number;
    review: string;
    scheduling?: FlashcardSchedulingPolicy;
    evidence?: FlashcardRecallEvidence;
    /** False only for V6 practice; absent historical entries remain formal recalls. */
    modelApplied?: false;
    /** Exact pre-review state, including minute due dates and learning progress. */
    beforeCard?: WordMemoryState['fsrsCard'];
    source?: 'reading_lookup' | 'verification' | 'flashcard';
    localDate?: string;
    verificationAttemptIds?: string[];
    originalFlashcardRating?: 1 | 2 | 3 | 4;
    flashcardRevisions?: FlashcardReviewRevision[];
  }>;
  /** Audited old passive-reading decisions, excluded from FSRS recall history. */
  passiveReadingReviews?: WordMemoryState['fsrsReviews'];
  /** Additive RME-V4 profile; absent on legacy V2.2 states. */
  rme?: RmeMemoryProfile;
}

/** Memory Score 计算参数 */
export interface MemoryScoreParams {
  /** 满级稳定天数 */
  S_cap: number;
  /** 旧版当前记忆分的遗忘惩罚；长期熟练度不使用此参数 */
  gamma: number;
}

/** 默认参数 */
export const DEFAULT_MS_PARAMS: MemoryScoreParams = {
  S_cap: 180,
  gamma: 1.0,
};

/** 等级边界配置 */
export interface LevelBoundary {
  level: 0 | 1 | 2 | 3 | 4;
  minScore: number;
  maxScore: number;
  label: string;
}

export const LEVEL_BOUNDARIES: LevelBoundary[] = [
  { level: 0, minScore: 0, maxScore: 20, label: '没有稳定识别证据' },
  { level: 1, minScore: 20, maxScore: 40, label: '高度依赖帮助' },
  { level: 2, minScore: 40, maxScore: 60, label: '正在形成识别' },
  { level: 3, minScore: 60, maxScore: 85, label: '多数情况能够识别' },
  { level: 4, minScore: 85, maxScore: 100, label: '长期、稳定、低负荷识别' },
];

/** 等级显示缓存（用于滞后带平滑） */
export interface LevelDisplayCache {
  wordId: string;
  lastDisplayedLevel: 0 | 1 | 2 | 3 | 4;
  lastScore: number;
  updatedAt: string;
}

/** 结算任务 */
export interface FinalizationTask {
  userId: string;
  localDate: string;
  wordIds: string[];
  createdAt: string;
}
