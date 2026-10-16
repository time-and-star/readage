import type {
  FsrsRetentionInput,
  RmeMemoryProfile,
  RmeMemoryStage,
} from './types';
import { calculateFsrsForgettingCurve } from '../fsrs';

const DAY_MS = 24 * 60 * 60 * 1000;
const clamp = (value: number, min = 0, max = 1): number =>
  Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));

export function calculateFsrsRetention(
  fsrs: FsrsRetentionInput,
  now: Date,
): number {
  if (!fsrs.lastReview || !Number.isFinite(fsrs.stabilityDays) || fsrs.stabilityDays <= 0) return 0;
  const reviewedAt = new Date(fsrs.lastReview).getTime();
  if (!Number.isFinite(reviewedAt) || !Number.isFinite(now.getTime())) return 0;
  const elapsedDays = Math.max(0, now.getTime() - reviewedAt) / DAY_MS;
  return calculateFsrsForgettingCurve(elapsedDays, fsrs.stabilityDays);
}

export function calculateRecentExposureFrequency(profile: RmeMemoryProfile, now: Date): number {
  const windowStart = now.getTime() - 7 * DAY_MS;
  if (!Number.isFinite(windowStart)) return 0;
  return clamp(profile.exposureHistory.filter((item) => {
    const timestamp = Date.parse(item.occurredAt);
    return item.isValid && timestamp >= windowStart && timestamp <= now.getTime();
  }).length / 3);
}

/** Callers with source-aware history exclude lookup-only FSRS cards. */
export interface RecallConfidenceInput extends FsrsRetentionInput {
  hasRecallEvidence?: boolean;
}

/** Current FSRS recall prediction; passive reading is tracked independently. */
export function calculateConfidence(
  _profile: RmeMemoryProfile,
  fsrs: RecallConfidenceInput,
  now: Date,
): number {
  // Legacy pure callers supply an already-reviewed FSRS card without source
  // metadata. Source-aware application callers must explicitly pass this gate.
  if (fsrs.hasRecallEvidence === false) return 0;
  return calculateFsrsRetention(fsrs, now) * 100;
}

export function stageFromConfidence(confidence: number): RmeMemoryStage {
  if (!Number.isFinite(confidence) || confidence <= 0) return 0;
  if (confidence < 25) return 1;
  if (confidence < 50) return 2;
  if (confidence < 80) return 3;
  return 4;
}

export function applyReviewOutcome(
  profile: RmeMemoryProfile,
  grade: 'Good' | 'Again',
  _reviewedAt: Date,
  reviewQuality = 1,
): RmeMemoryProfile {
  if (grade === 'Again') {
    const consecutiveAgain = profile.consecutiveAgain + 1;
    return {
      ...profile,
      consecutiveAgain,
      recoveryStreak: 0,
      forcedExposure: profile.forcedExposure || consecutiveAgain >= 3,
      lastReviewGrade: grade,
    };
  }

  if (!profile.forcedExposure) {
    return { ...profile, consecutiveAgain: 0, lastReviewGrade: grade };
  }

  if (reviewQuality < 0.8) {
    return {
      ...profile,
      recoveryStreak: 0,
      forcedExposure: true,
      lastReviewGrade: grade,
    };
  }

  const recoveryStreak = profile.recoveryStreak + 1;
  const recovered = recoveryStreak >= 2;
  return {
    ...profile,
    consecutiveAgain: 0,
    recoveryStreak: recovered ? 0 : recoveryStreak,
    forcedExposure: !recovered,
    lastReviewGrade: grade,
  };
}
