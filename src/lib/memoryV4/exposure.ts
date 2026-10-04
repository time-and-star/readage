import {
  RME_HISTORY_LIMIT,
  RME_DAY_MS,
  type ExposureClassification,
  type ExposureClassificationInput,
  type ExposureQualitySignals,
  type RmeExposureInput,
  type RmeMemoryProfile,
} from './types';
import { getLocalDateInTimeZone, getSystemTimeZone } from '../memoryV2/dateUtils';

const clamp = (value: number, min = 0, max = 1): number =>
  Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));

export function classifyExposure(input: ExposureClassificationInput): ExposureClassification {
  const timezone = input.userTimezone ?? getSystemTimeZone();
  const localDate = input.localDate ?? getLocalDateInTimeZone(input.now, timezone);
  const anchor = input.lastEffectiveExposureAt
    || input.firstUnconfirmedExposureAt
    || input.lastExposureAt;
  const exposureAnchorAt = anchor ? Date.parse(anchor) : NaN;
  const reviewAnchorAt = input.lastReviewAt ? Date.parse(input.lastReviewAt) : NaN;
  const anchors = [exposureAnchorAt, reviewAnchorAt].filter(Number.isFinite);
  const anchorAt = anchors.length > 0 ? Math.max(...anchors) : NaN;
  const previousLocalDate = input.previousLocalDate
    ?? (Number.isFinite(anchorAt) ? getLocalDateInTimeZone(new Date(anchorAt), timezone) : null);
  // Crossing midnight alone is not a spaced encounter. Require a full day
  // since the real exposure anchor, plus at most one credit per local day.
  const isSpaced = Number.isFinite(anchorAt) && Number.isFinite(input.now.getTime())
    && input.now.getTime() - anchorAt >= RME_DAY_MS
    && (!previousLocalDate || localDate > previousLocalDate);
  if (input.forcedExposure) return { kind: 'forced', isValid: isSpaced };
  const hasSeen = Boolean(
    input.lastExposureAt || input.lastEffectiveExposureAt || input.firstUnconfirmedExposureAt || input.lastReviewAt,
  );
  if (!hasSeen) return { kind: 'new', isValid: false };

  const hasFsrsReview = input.hasFsrsReview === true;
  const nextReviewAt = input.nextReview ? new Date(input.nextReview).getTime() : NaN;
  if (input.isRecommendation && hasFsrsReview
    && Number.isFinite(nextReviewAt) && nextReviewAt <= input.now.getTime()) {
    return { kind: 'scheduled', isValid: isSpaced };
  }

  const kind = input.isConfirmation || (input.isRecommendation && !hasFsrsReview)
    ? 'confirmation'
    : 'natural';
  return { kind, isValid: isSpaced };
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
  ) {
    return Number(dwell) >= Number(expected) && Number(dwell) < Number(expected) * 2 ? 1 : 0.5;
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
    lastEffectiveLocalDate: null,
    firstUnconfirmedExposureAt: null,
    firstUnconfirmedLocalDate: null,
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

/** Deduplicate an occurrence within one local day, allowing cross-day rereads. */
export function recordExposure(
  profile: RmeMemoryProfile,
  exposure: RmeExposureInput,
): RmeMemoryProfile {
  const occurredAt = exposure.now.toISOString();
  const localDate = exposure.localDate || occurredAt.slice(0, 10);
  const existing = profile.exposureHistory.find((item) =>
    item.occurrenceId === exposure.occurrenceId && item.localDate === localDate
  );
  if (existing) {
    if (existing.occurredAt !== occurredAt) return profile;
    const previousDwell = existing.dwellTimeMs;
    const incomingDwell = exposure.dwellTimeMs;
    const hasPreviousDwell = Number.isFinite(previousDwell) && Number(previousDwell) >= 0;
    const hasIncomingDwell = Number.isFinite(incomingDwell) && Number(incomingDwell) >= 0;
    const dwellTimeMs = hasPreviousDwell && hasIncomingDwell
      ? Math.max(Number(previousDwell), Number(incomingDwell))
      : hasPreviousDwell ? previousDwell : hasIncomingDwell ? incomingDwell : undefined;
    const isStaleMeasurement = hasPreviousDwell && hasIncomingDwell
      && Number(incomingDwell) < Number(previousDwell);
    const quality = exposure.quality === 0 ? 0 : isStaleMeasurement ? existing.quality : exposure.quality;
    const updated = updateExposureQuality(profile, exposure.occurrenceId, quality, localDate);
    const expectedDwellTimeMs = existing.expectedDwellTimeMs
      ?? (Number.isFinite(exposure.expectedDwellTimeMs) && Number(exposure.expectedDwellTimeMs) > 0
        ? exposure.expectedDwellTimeMs : undefined);
    if (dwellTimeMs === existing.dwellTimeMs && expectedDwellTimeMs === existing.expectedDwellTimeMs) return updated;
    return { ...updated, exposureHistory: updated.exposureHistory.map((item) =>
      item === existing || (item.occurrenceId === existing.occurrenceId && item.localDate === localDate
        && item.occurredAt === occurredAt)
        ? { ...item, ...(dwellTimeMs === undefined ? {} : { dwellTimeMs }),
          ...(expectedDwellTimeMs === undefined ? {} : { expectedDwellTimeMs }) }
        : item) };
  }

  const normalizedExposure = {
    articleId: exposure.articleId,
    occurrenceId: exposure.occurrenceId,
    kind: exposure.kind,
    occurredAt,
    localDate,
    quality: clamp(exposure.quality),
    isValid: exposure.isValid,
    ...(Number.isFinite(exposure.dwellTimeMs) && Number(exposure.dwellTimeMs) >= 0
      ? { dwellTimeMs: exposure.dwellTimeMs } : {}),
    ...(Number.isFinite(exposure.expectedDwellTimeMs) && Number(exposure.expectedDwellTimeMs) > 0
      ? { expectedDwellTimeMs: exposure.expectedDwellTimeMs } : {}),
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
    next.lastEffectiveLocalDate = localDate;
    next.firstUnconfirmedExposureAt = null;
    next.firstUnconfirmedLocalDate = null;
    if (exposure.quality >= 0.8) next.successfulExposureCount += 1;
    if (exposure.quality <= 0.2) next.failedExposureCount += 1;
  } else if (!next.lastEffectiveExposureAt && !next.firstUnconfirmedExposureAt) {
    next.firstUnconfirmedExposureAt = occurredAt;
    next.firstUnconfirmedLocalDate = localDate;
  }
  return next;
}

/** Update a dwell snapshot without duplicating evidence; a lookup stays failed. */
export function updateExposureQuality(
  profile: RmeMemoryProfile,
  occurrenceId: string,
  quality: number,
  localDate?: string,
): RmeMemoryProfile {
  let index = -1;
  for (let cursor = profile.exposureHistory.length - 1; cursor >= 0; cursor -= 1) {
    const item = profile.exposureHistory[cursor];
    if (item.occurrenceId === occurrenceId && (!localDate || item.localDate === localDate)) {
      index = cursor;
      break;
    }
  }
  if (index < 0) return profile;
  const current = profile.exposureHistory[index];
  const nextQuality = current.quality === 0 ? 0 : clamp(quality);
  if (nextQuality === current.quality) return profile;
  const nextHistory = [...profile.exposureHistory];
  nextHistory[index] = { ...current, quality: nextQuality };
  const next = {
    ...profile,
    exposureHistory: nextHistory,
    contextHistory: profile.contextHistory.map((item) =>
      item.occurrenceId === occurrenceId && item.localDate === current.localDate
        ? { ...item, quality: nextQuality } : item
    ),
  };
  if (current.isValid) {
    next.successfulExposureCount = Math.max(0, next.successfulExposureCount
      + Number(nextQuality >= 0.8) - Number(current.quality >= 0.8));
    next.failedExposureCount = Math.max(0, next.failedExposureCount
      + Number(nextQuality <= 0.2) - Number(current.quality <= 0.2));
  }
  return next;
}
