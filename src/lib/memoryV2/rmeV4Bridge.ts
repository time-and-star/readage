import type { RawWordEvent, WordMemoryState } from './types';
import {
  applyReviewOutcome,
  calculateConfidence,
  calculateExposureQuality,
  calculateRecentExposureFrequency,
  calculateOpportunityScore,
  classifyExposure,
  createEmptyRmeProfile,
  recordExposure,
  stageFromConfidence,
  updateExposureQuality,
} from '../memoryV4';
import type { RmeMemoryProfile } from '../memoryV4/types';
import { getLocalDateInTimeZone, getSystemTimeZone, getUtcInstantForLocalDayEnd } from './dateUtils';

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
            || candidate.kind === 'confirmation'
            || candidate.kind === 'natural'
            || candidate.kind === 'scheduled'
            || candidate.kind === 'forced'
            ? candidate.kind
            : 'natural',
          occurredAt: typeof candidate.occurredAt === 'string' ? candidate.occurredAt : '',
          localDate: typeof candidate.localDate === 'string' ? candidate.localDate : '',
          quality: clampNumber(candidate.quality),
          isValid: candidate.isValid !== false,
          ...(Number.isFinite(candidate.dwellTimeMs) && Number(candidate.dwellTimeMs) >= 0
            ? { dwellTimeMs: candidate.dwellTimeMs } : {}),
          ...(Number.isFinite(candidate.expectedDwellTimeMs) && Number(candidate.expectedDwellTimeMs) > 0
            ? { expectedDwellTimeMs: candidate.expectedDwellTimeMs } : {}),
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
            || candidate.kind === 'confirmation'
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
    lastEffectiveLocalDate: typeof row.lastEffectiveLocalDate === 'string'
      ? row.lastEffectiveLocalDate
      : exposureHistory.find((item) => item.occurredAt === row.lastEffectiveExposureAt)?.localDate ?? null,
    firstUnconfirmedExposureAt: typeof row.firstUnconfirmedExposureAt === 'string'
      ? row.firstUnconfirmedExposureAt
      : exposureHistory.find((item) => !item.isValid)?.occurredAt ?? null,
    firstUnconfirmedLocalDate: typeof row.firstUnconfirmedLocalDate === 'string'
      ? row.firstUnconfirmedLocalDate
      : exposureHistory.find((item) => item.occurredAt === row.firstUnconfirmedExposureAt)?.localDate
        ?? exposureHistory.find((item) => !item.isValid)?.localDate ?? null,
    confidence: clampPercent(row.confidence),
    recentExposureFrequency: clampNumber(row.recentExposureFrequency),
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
    recentExposureFrequency: calculateRecentExposureFrequency(profile, now),
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
  profile.firstUnconfirmedExposureAt = null;
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
  userTimezone: string = getSystemTimeZone(),
): { event: RawWordEvent; state: WordMemoryState | null } {
  const profile = rmeProfileForState(state);
  const occurredAt = new Date(event.occurredAt);
  if (!Number.isFinite(occurredAt.getTime())) return { event, state };

  if (event.eventType === 'click') {
    if (!state?.rme && profile.exposureHistory.length === 0) return { event, state };
    // A still-open encounter can span midnight. Keep the lookup's real time,
    // but downgrade the latest matching encounter that preceded the lookup.
    const targetExposure = profile.exposureHistory.filter((item) =>
      item.occurrenceId === event.occurrenceId
        && Date.parse(item.occurredAt) <= occurredAt.getTime())
      .sort((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt))[0];
    const failedProfile = targetExposure
      ? updateExposureQuality(profile, event.occurrenceId, 0, targetExposure.localDate)
      : profile;
    const updatedProfile = state
      ? projectRmeProfile(failedProfile, state, occurredAt)
      : failedProfile;
    return {
      event: { ...event, rmeQuality: 0 },
      state: state ? { ...state, rme: updatedProfile,
        lastAssistedAt: Date.parse(state.lastAssistedAt ?? '') > occurredAt.getTime()
          ? state.lastAssistedAt : occurredAt.toISOString() } : null,
    };
  }

  const previousLocalDate = profile.lastEffectiveLocalDate || profile.firstUnconfirmedLocalDate;
  const lastReviewAt = state?.lastReview ? Date.parse(state.lastReview) : NaN;
  const lastReviewLocalDate = Number.isFinite(lastReviewAt)
    ? getLocalDateInTimeZone(new Date(lastReviewAt), userTimezone) : null;
  const actualReviewAt = lastReviewLocalDate
    && lastReviewAt !== getUtcInstantForLocalDayEnd(lastReviewLocalDate, userTimezone).getTime()
    ? state?.lastReview : null;
  const creditedLocalDate = [previousLocalDate, lastReviewLocalDate]
    .filter((date): date is string => Boolean(date)).sort().pop();
  const existingExposure = profile.exposureHistory.find((item) =>
    item.occurrenceId === event.occurrenceId && item.localDate === event.localDate
      && item.occurredAt === occurredAt.toISOString()
  );
  const classification = existingExposure ? {
    kind: existingExposure.kind, isValid: existingExposure.isValid,
  } : classifyExposure({
    now: occurredAt,
    isRecommendation: event.isRecommendation === true,
    localDate: event.localDate,
    previousLocalDate: creditedLocalDate,
    userTimezone,
    forcedExposure: profile.forcedExposure,
    nextReview: state?.nextReview,
    hasFsrsReview: Boolean(state?.fsrsReviews.length),
    firstUnconfirmedExposureAt: profile.firstUnconfirmedExposureAt,
    lastExposureAt: profile.lastExposureAt,
    lastEffectiveExposureAt: profile.lastEffectiveExposureAt,
    lastReviewAt: actualReviewAt,
  });
  const previousDwell = existingExposure?.dwellTimeMs;
  const incomingDwell = event.dwellTimeMs;
  const hasPreviousDwell = Number.isFinite(previousDwell) && Number(previousDwell) >= 0;
  const hasIncomingDwell = Number.isFinite(incomingDwell) && Number(incomingDwell) >= 0;
  const dwellTimeMs = hasPreviousDwell && hasIncomingDwell
    ? Math.max(Number(previousDwell), Number(incomingDwell))
    : hasPreviousDwell ? previousDwell : hasIncomingDwell ? incomingDwell : undefined;
  const expectedDwellTimeMs = existingExposure?.expectedDwellTimeMs ?? event.expectedDwellTimeMs;
  const quality = existingExposure?.quality === 0 || event.rmeQuality === 0 ? 0 : calculateExposureQuality({
    dwellTimeMs,
    expectedDwellTimeMs,
    // Recalculate measured updates from the retained maximum, even when a
    // pruned raw record no longer supplies the previous snapshot metadata.
    modelQuality: existingExposure && dwellTimeMs !== undefined && expectedDwellTimeMs !== undefined
      ? undefined : event.rmeQuality,
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
    dwellTimeMs,
    expectedDwellTimeMs,
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
      ...(dwellTimeMs === undefined ? {} : { dwellTimeMs }),
      ...(expectedDwellTimeMs === undefined ? {} : { expectedDwellTimeMs }),
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
