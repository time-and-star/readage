import type { RawWordEvent, WordMemoryState } from './types';
import {
  applyReviewOutcome,
  calculateConfidence,
  calculateExposureQuality,
  calculateOpportunityScore,
  classifyExposure,
  createEmptyRmeProfile,
  recordExposure,
  stageFromConfidence,
  updateExposureQuality,
} from '../memoryV4';
import type { RmeMemoryProfile } from '../memoryV4/types';

function finiteCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

/** Normalize optional persisted V4 data without making V2 records invalid. */
export function normalizeRmeProfile(value: unknown): RmeMemoryProfile {
  const fallback = createEmptyRmeProfile();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
  const row = value as Partial<RmeMemoryProfile>;
  const exposureHistory = Array.isArray(row.exposureHistory)
    ? row.exposureHistory.filter((item) => item && typeof item === 'object').map((item) => {
        const candidate = item as Partial<RmeMemoryProfile['exposureHistory'][number]>;
        return {
          articleId: typeof candidate.articleId === 'string' ? candidate.articleId : '',
          occurrenceId: typeof candidate.occurrenceId === 'string' ? candidate.occurrenceId : '',
          kind: candidate.kind === 'new'
            || candidate.kind === 'natural'
            || candidate.kind === 'scheduled'
            || candidate.kind === 'forced'
            ? candidate.kind
            : 'natural',
          occurredAt: typeof candidate.occurredAt === 'string' ? candidate.occurredAt : '',
          localDate: typeof candidate.localDate === 'string' ? candidate.localDate : '',
          quality: clampNumber(candidate.quality),
          isValid: candidate.isValid !== false,
        };
      }).filter((item) => item.articleId && item.occurrenceId && item.occurredAt)
    : [];
  const contextHistory = Array.isArray(row.contextHistory)
    ? row.contextHistory.filter((item) => item && typeof item === 'object').map((item) => {
        const candidate = item as Partial<RmeMemoryProfile['contextHistory'][number]>;
        return {
          articleId: typeof candidate.articleId === 'string' ? candidate.articleId : '',
          occurrenceId: typeof candidate.occurrenceId === 'string' ? candidate.occurrenceId : '',
          kind: candidate.kind === 'new'
            || candidate.kind === 'natural'
            || candidate.kind === 'scheduled'
            || candidate.kind === 'forced'
            ? candidate.kind
            : 'natural',
          occurredAt: typeof candidate.occurredAt === 'string' ? candidate.occurredAt : '',
          localDate: typeof candidate.localDate === 'string' ? candidate.localDate : '',
          quality: clampNumber(candidate.quality),
          contextText: typeof candidate.contextText === 'string'
            ? candidate.contextText.slice(0, 2_000)
            : undefined,
        };
      }).filter((item) => item.articleId && item.occurrenceId && item.occurredAt)
    : [];

  return {
    version: 4,
    exposureHistory,
    contextHistory,
    successfulExposureCount: finiteCount(row.successfulExposureCount),
    failedExposureCount: finiteCount(row.failedExposureCount),
    lastExposureAt: typeof row.lastExposureAt === 'string' ? row.lastExposureAt : null,
    lastEffectiveExposureAt: typeof row.lastEffectiveExposureAt === 'string'
      ? row.lastEffectiveExposureAt
      : null,
    confidence: clampPercent(row.confidence),
    opportunityScore: clampPercent(row.opportunityScore),
    consecutiveAgain: finiteCount(row.consecutiveAgain),
    recoveryStreak: finiteCount(row.recoveryStreak),
    forcedExposure: row.forcedExposure === true,
    lastReviewGrade: row.lastReviewGrade === 'Good' || row.lastReviewGrade === 'Again'
      ? row.lastReviewGrade
      : null,
  };
}

function clampNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : 0;
}

function clampPercent(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(100, Math.max(0, value))
    : 0;
}

export function projectRmeProfile(
  profile: RmeMemoryProfile,
  state: WordMemoryState,
  now: Date,
): RmeMemoryProfile {
  const confidence = calculateConfidence(profile, {
    stabilityDays: state.stability,
    lastReview: state.lastReview,
  }, now);
  const lastEffective = profile.lastEffectiveExposureAt
    ? new Date(profile.lastEffectiveExposureAt).getTime()
    : NaN;
  const exposureGap = Number.isFinite(lastEffective)
    ? Math.min(1, Math.max(0, (now.getTime() - lastEffective) / (7 * 24 * 60 * 60 * 1000)))
    : 1;
  return {
    ...profile,
    confidence,
    opportunityScore: calculateOpportunityScore(profile, {
      now,
      forgettingRisk: 1 - confidence / 100,
      exposureGap,
      importance: 1,
      stageWeight: 1 - stageFromConfidence(confidence) * 0.12,
      goalWeight: 1,
    }),
  };
}

/** Build a V4 profile for a legacy state using its existing FSRS review log. */
export function rmeProfileForState(state: WordMemoryState | null): RmeMemoryProfile {
  if (!state) return createEmptyRmeProfile();
  if (state.rme) return normalizeRmeProfile(state.rme);

  const profile = createEmptyRmeProfile();
  for (const review of state.fsrsReviews) {
    if (review.rating <= 1) profile.failedExposureCount += 1;
    else profile.successfulExposureCount += 1;
  }
  profile.lastExposureAt = state.lastReview;
  profile.lastEffectiveExposureAt = state.lastReview;
  const recentReviews = state.fsrsReviews.slice(-3);
  profile.consecutiveAgain = 0;
  for (let index = recentReviews.length - 1; index >= 0; index -= 1) {
    if (recentReviews[index].rating > 1) break;
    profile.consecutiveAgain += 1;
  }
  if (recentReviews.length === 3 && recentReviews.every((review) => review.rating <= 1)) {
    profile.consecutiveAgain = 3;
    profile.forcedExposure = true;
  }
  return profile;
}

export function prepareRmeEvent(
  state: WordMemoryState | null,
  event: RawWordEvent,
): { event: RawWordEvent; state: WordMemoryState | null } {
  const profile = rmeProfileForState(state);
  const occurredAt = new Date(event.occurredAt);
  if (!Number.isFinite(occurredAt.getTime())) return { event, state };

  if (event.eventType === 'click') {
    if (!state?.rme && profile.exposureHistory.length === 0) return { event, state };
    const updatedProfile = state
      ? projectRmeProfile(updateExposureQuality(profile, event.occurrenceId, 0), state, occurredAt)
      : updateExposureQuality(profile, event.occurrenceId, 0);
    return {
      event: { ...event, rmeQuality: 0 },
      state: state ? { ...state, rme: updatedProfile } : null,
    };
  }

  const lastExposure = profile.exposureHistory[profile.exposureHistory.length - 1];
  const classification = classifyExposure({
    now: occurredAt,
    isRecommendation: event.isRecommendation === true,
    articleId: event.articleId,
    lastEffectiveArticleId: lastExposure?.articleId,
    forcedExposure: profile.forcedExposure,
    nextReview: state?.nextReview,
    lastExposureAt: profile.lastExposureAt,
    lastEffectiveExposureAt: profile.lastEffectiveExposureAt,
  });
  const quality = calculateExposureQuality({
    dwellTimeMs: event.dwellTimeMs,
    expectedDwellTimeMs: event.expectedDwellTimeMs,
    modelQuality: event.rmeQuality,
  });
  const updatedProfile = recordExposure(profile, {
    articleId: event.articleId,
    occurrenceId: event.occurrenceId,
    kind: classification.kind,
    now: occurredAt,
    localDate: event.localDate,
    quality,
    isValid: classification.isValid,
    contextText: event.contextText,
  });
  const nextState = state || {
    userId: event.userId,
    wordId: event.wordId,
    stability: 0,
    difficulty: 0,
    lastReview: null,
    nextReview: occurredAt.toISOString(),
    fsrsCard: {
      due: occurredAt.toISOString(),
      stability: 0,
      difficulty: 0,
      elapsedDays: 0,
      scheduledDays: 0,
      learningSteps: 0,
      reps: 0,
      lapses: 0,
      state: 0,
    },
    fsrsReviews: [],
  } satisfies WordMemoryState;

  return {
    event: {
      ...event,
      rmeExposureKind: classification.kind,
      rmeQuality: quality,
      rmeIsValid: classification.isValid,
    },
    state: { ...nextState, rme: projectRmeProfile(updatedProfile, nextState, occurredAt) },
  };
}

export function applyRmeReview(
  state: WordMemoryState,
  grade: 'Good' | 'Again',
  reviewedAt: Date,
  reviewQuality = 1,
): WordMemoryState {
  const profile = rmeProfileForState(state);
  return {
    ...state,
    rme: projectRmeProfile(
      applyReviewOutcome(profile, grade, reviewedAt, reviewQuality),
      state,
      reviewedAt,
    ),
  };
}
