export const RME_V4_VERSION = 4 as const;
export const RME_DAY_MS = 24 * 60 * 60 * 1000;
export const RME_HISTORY_LIMIT = 200;

export type RmeExposureKind = 'new' | 'confirmation' | 'natural' | 'scheduled' | 'forced';
export type RmeReviewGrade = 'Good' | 'Again';
export type RmeMemoryStage = 0 | 1 | 2 | 3 | 4;

export interface RmeExposure {
  articleId: string;
  occurrenceId: string;
  kind: RmeExposureKind;
  occurredAt: string;
  localDate: string;
  quality: number;
  isValid: boolean;
  /** Largest cumulative measured snapshot, retained after raw-event pruning. */
  dwellTimeMs?: number;
  expectedDwellTimeMs?: number;
}

export interface RmeExposureInput {
  articleId: string;
  occurrenceId: string;
  kind: RmeExposureKind;
  now: Date;
  localDate?: string;
  quality: number;
  isValid: boolean;
  contextText?: string;
  dwellTimeMs?: number;
  expectedDwellTimeMs?: number;
}

export interface RmeContextRecord {
  articleId: string;
  occurrenceId: string;
  kind: RmeExposureKind;
  occurredAt: string;
  localDate: string;
  quality: number;
  contextText?: string;
}

export interface RmeMemoryProfile {
  version: typeof RME_V4_VERSION;
  exposureHistory: RmeExposure[];
  contextHistory: RmeContextRecord[];
  successfulExposureCount: number;
  failedExposureCount: number;
  lastExposureAt: string | null;
  lastEffectiveExposureAt: string | null;
  lastEffectiveLocalDate: string | null;
  /** First exposure in the current pre-FSRS confirmation window. */
  firstUnconfirmedExposureAt: string | null;
  firstUnconfirmedLocalDate: string | null;
  confidence: number;
  /** Recent practice activity, independent of estimated memory confidence. */
  recentExposureFrequency?: number;
  opportunityScore: number;
  consecutiveAgain: number;
  recoveryStreak: number;
  forcedExposure: boolean;
  lastReviewGrade: RmeReviewGrade | null;
}

export interface ExposureClassificationInput {
  now: Date;
  isRecommendation: boolean;
  /** Calendar dates captured in the reader's time zone. */
  localDate?: string;
  previousLocalDate?: string | null;
  userTimezone?: string;
  /** Legacy fields retained for persisted callers; article identity is no longer a validity gate. */
  articleId?: string;
  lastEffectiveArticleId?: string | null;
  forcedExposure?: boolean;
  nextReview?: string | null;
  /** Explicitly distinguishes FSRS reviews from the pre-FSRS confirmation path. */
  hasFsrsReview?: boolean;
  /** Used by the confirmation queue to label recommended pre-FSRS exposures. */
  isConfirmation?: boolean;
  lastExposureAt?: string | null;
  lastEffectiveExposureAt?: string | null;
  firstUnconfirmedExposureAt?: string | null;
  /** Actual recall time, excluding a legacy synthetic day-end settlement. */
  lastReviewAt?: string | null;
}

export interface ExposureClassification {
  kind: RmeExposureKind;
  isValid: boolean;
}

export interface ExposureQualitySignals {
  clicked?: boolean;
  dwellTimeMs?: number;
  expectedDwellTimeMs?: number;
  /** Reserved for a future eye-tracking or AI quality model. */
  modelQuality?: number;
}

export interface FsrsRetentionInput {
  stabilityDays: number;
  lastReview: string | null;
}

export interface ConfidenceInput extends FsrsRetentionInput {
  now: Date;
}

export interface OpportunityInput {
  now: Date;
  forgettingRisk: number;
  importance?: number;
  exposureGap?: number;
  stageWeight?: number;
  goalWeight?: number;
}

export interface ArticleOpportunityInput {
  lemmas: readonly string[];
  opportunityByWord: ReadonlyMap<string, number>;
  cefrScore?: number;
  topicScore?: number;
  lengthScore?: number;
  difficultyPenalty?: number;
  repetitionPenalty?: number;
}

export interface ArticleOpportunityScore {
  opportunityCoverage: number;
  articleScore: number;
  coveredWords: string[];
}
