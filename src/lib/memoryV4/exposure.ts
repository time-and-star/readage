import {
  RME_DAY_MS,
  RME_HISTORY_LIMIT,
  type ExposureClassification,
  type ExposureClassificationInput,
  type ExposureQualitySignals,
  type RmeExposureInput,
  type RmeMemoryProfile,
} from './types';

const clamp = (value: number, min = 0, max = 1): number =>
  Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));

function elapsedMs(now: Date, timestamp: string | null | undefined): number | null {
  if (!timestamp) return null;
  const time = new Date(timestamp).getTime();
  if (!Number.isFinite(time)) return null;
  return Math.max(0, now.getTime() - time);
}

export function classifyExposure(input: ExposureClassificationInput): ExposureClassification {
  const isNewArticle = !input.articleId
    || !input.lastEffectiveArticleId
    || input.articleId !== input.lastEffectiveArticleId;

  if (input.forcedExposure) return { kind: 'forced', isValid: isNewArticle };
  const hasSeen = Boolean(input.lastExposureAt || input.lastEffectiveExposureAt);
  if (!hasSeen) return { kind: 'new', isValid: false };

  const nextReviewAt = input.nextReview ? new Date(input.nextReview).getTime() : NaN;
  if (input.isRecommendation && Number.isFinite(nextReviewAt) && nextReviewAt <= input.now.getTime()) {
    return { kind: 'scheduled', isValid: isNewArticle };
  }

  const gap = elapsedMs(input.now, input.lastEffectiveExposureAt || input.lastExposureAt);
  return { kind: 'natural', isValid: isNewArticle && (gap === null || gap >= RME_DAY_MS) };
}

export function calculateExposureQuality(signals: ExposureQualitySignals = {}): number {
  if (signals.clicked) return 0;
  if (signals.modelQuality !== undefined) return clamp(signals.modelQuality);

  const dwell = signals.dwellTimeMs;
  const expected = signals.expectedDwellTimeMs;
  if (
    Number.isFinite(dwell)
    && Number.isFinite(expected)
    && Number(expected) > 0
    && Number(dwell) >= Number(expected) * 2
  ) {
    return 0.5;
  }
  return 1;
}

export function createEmptyRmeProfile(): RmeMemoryProfile {
  return {
    version: 4,
    exposureHistory: [],
    contextHistory: [],
    successfulExposureCount: 0,
    failedExposureCount: 0,
    lastExposureAt: null,
    lastEffectiveExposureAt: null,
    confidence: 0,
    opportunityScore: 0,
    consecutiveAgain: 0,
    recoveryStreak: 0,
    forcedExposure: false,
    lastReviewGrade: null,
  };
}

function trimHistory<T>(items: T[]): T[] {
  return items.slice(-RME_HISTORY_LIMIT);
}

/** Add one exposure without turning an occurrence into multiple observations. */
export function recordExposure(
  profile: RmeMemoryProfile,
  exposure: RmeExposureInput,
): RmeMemoryProfile {
  if (profile.exposureHistory.some((item) => item.occurrenceId === exposure.occurrenceId)) {
    return profile;
  }

  const occurredAt = exposure.now.toISOString();
  const localDate = exposure.localDate || occurredAt.slice(0, 10);
  const normalizedExposure = {
    articleId: exposure.articleId,
    occurrenceId: exposure.occurrenceId,
    kind: exposure.kind,
    occurredAt,
    localDate,
    quality: clamp(exposure.quality),
    isValid: exposure.isValid,
  };
  const next = { ...profile };
  next.exposureHistory = trimHistory([...profile.exposureHistory, normalizedExposure]);
  next.contextHistory = trimHistory([
    ...profile.contextHistory,
    {
      articleId: exposure.articleId,
      occurrenceId: exposure.occurrenceId,
      kind: exposure.kind,
      occurredAt,
      localDate,
      quality: clamp(exposure.quality),
      contextText: exposure.contextText,
    },
  ]);
  next.lastExposureAt = occurredAt;
  if (exposure.isValid) {
    next.lastEffectiveExposureAt = occurredAt;
    if (exposure.quality >= 0.8) next.successfulExposureCount += 1;
    if (exposure.quality <= 0.2) next.failedExposureCount += 1;
  }
  return next;
}

/** A later click can downgrade the matching exposure without duplicating context. */
export function updateExposureQuality(
  profile: RmeMemoryProfile,
  occurrenceId: string,
  quality: number,
): RmeMemoryProfile {
  const index = profile.exposureHistory.findIndex((item) => item.occurrenceId === occurrenceId);
  if (index < 0) return profile;
  const current = profile.exposureHistory[index];
  const nextQuality = clamp(quality);
  const nextHistory = [...profile.exposureHistory];
  nextHistory[index] = { ...current, quality: nextQuality };
  const next = {
    ...profile,
    exposureHistory: nextHistory,
    contextHistory: profile.contextHistory.map((item) =>
      item.occurrenceId === occurrenceId ? { ...item, quality: nextQuality } : item
    ),
  };
  if (current.quality >= 0.8 && nextQuality < 0.8 && current.isValid) {
    next.successfulExposureCount = Math.max(0, next.successfulExposureCount - 1);
  }
  if (current.quality > 0.2 && nextQuality <= 0.2 && current.isValid) {
    next.failedExposureCount += 1;
  }
  return next;
}
