import type { ArticleWordEvidence, DailyWordEvidence, RawWordEvent, ReadingVerificationEvidence, WordMemoryState } from '../memoryV2/types';
import { aggregateArticleEvidence, aggregateDailyEvidence } from '../memoryV2/evidenceAggregation';
import { finalizeDailyEvidence, initializeWordMemory, submitFsrsReview } from '../memoryV2/fsrsIntegration';
import { applyRmeReview, prepareRmeEvent, projectRmeProfile, rmeProfileForState } from '../memoryV2/rmeV4Bridge';
import { getLocalDateInTimeZone, getUtcInstantForLocalDayEnd } from '../memoryV2/dateUtils';
import { calculateExposureQuality, createEmptyRmeProfile, recordExposure } from '../memoryV4';
import { mergeExposureSnapshot } from '../memoryV2/rawEventPersistence';
import { replayVerificationEvidence } from '../memoryV2/verificationMemory';
import { repairPassiveReadingRecall } from '../memoryV2/passiveRecallRepair';

export type TimedWordEvent = RawWordEvent & { timezone?: string };
export interface WordJournal {
  version: 1;
  userId: string;
  wordId: string;
  /** Immutable pre-extension data. Never replace this with replay output. */
  baselineState: WordMemoryState | null;
  baselineDaily: DailyWordEvidence[];
  baselineRaw: RawWordEvent[];
  events: TimedWordEvent[];
}

export function eventKey(event: RawWordEvent): string {
  if (event.occurrenceId.startsWith('extension:')) return JSON.stringify([event.occurrenceId, event.eventType]);
  return JSON.stringify([event.occurrenceId, event.eventType, event.occurredAt]);
}

/** Recover the immutable review state before the first reconstructable log. */
function unloggedBaselineFor(state: WordMemoryState | null): WordMemoryState | null {
  if (!state || state.fsrsCard.reps <= state.fsrsReviews.length) return null;
  if (!state.fsrsReviews.length) return { ...state, fsrsCard: { ...state.fsrsCard }, fsrsReviews: [] };
  const first = [...state.fsrsReviews].sort((left, right) => left.review.localeCompare(right.review))[0];
  const previousReview = first.state === 0 ? null : first.due;
  const due = previousReview
    ? new Date(Date.parse(previousReview) + first.scheduledDays * 86_400_000).toISOString() : first.due;
  return { ...state, stability: first.stability, difficulty: first.difficulty,
    lastReview: previousReview, nextReview: due, fsrsReviews: [],
    fsrsCard: { due, stability: first.stability, difficulty: first.difficulty,
      elapsedDays: first.lastElapsedDays, scheduledDays: first.scheduledDays, learningSteps: first.learningSteps,
      reps: state.fsrsCard.reps - state.fsrsReviews.length,
      lapses: Math.max(0, state.fsrsCard.lapses
        - state.fsrsReviews.filter(review => review.rating === 1 && review.state !== 0).length),
      state: first.state, ...(previousReview ? { lastReview: previousReview } : {}) },
  };
}

export function replayWordJournal(journal: WordJournal, timezone: string, now: Date,
  verifications: readonly ReadingVerificationEvidence[] = []) {
  // Repair locally: the immutable journal baseline still records the original
  // history, but its proven passive Good decisions must never be replayed.
  const baselineState = journal.baselineState
    ? repairPassiveReadingRecall(journal.baselineState, journal.baselineDaily, timezone, now) : null;
  const baselineRawKeys = new Set(journal.baselineRaw.map(eventKey));
  const finalizedBaselineDates = new Set(journal.baselineDaily.filter(row => row.finalizedAt).map(row => row.localDate));
  const incomingEvents = journal.events.filter(event => !baselineRawKeys.has(eventKey(event)));
  const unique = new Map<string, TimedWordEvent>();
  for (const event of [...journal.baselineRaw, ...journal.events]) {
    const prior = unique.get(eventKey(event));
    unique.set(eventKey(event), (prior ? mergeExposureSnapshot(prior, event) : null) ?? event);
  }
  const raw = [...unique.values()].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)
    || a.occurrenceId.localeCompare(b.occurrenceId) || (a.eventType === 'exposure' ? -1 : 1));
  const exposureKey = (event: { occurrenceId: string; localDate: string }) =>
    JSON.stringify([event.occurrenceId, event.localDate]);
  const rawOccurrences = new Set(raw.map(exposureKey));
  const baselineProfile = rmeProfileForState(baselineState);
  const historicalExposures = baselineProfile.exposureHistory.filter(event => !rawOccurrences.has(exposureKey(event)));
  const unloggedBaseline = unloggedBaselineFor(baselineState);
  const baselineReviewAt = Date.parse(unloggedBaseline?.lastReview ?? '');
  const afterBaseline = (at: string) => !Number.isFinite(baselineReviewAt) || Date.parse(at) > baselineReviewAt;
  const replayableVerifications = verifications.filter(attempt => afterBaseline(attempt.occurredAt));
  const state = unloggedBaseline ?? initializeWordMemory(journal.userId, journal.wordId);
  if (baselineState?.passiveReadingReviews) state.passiveReadingReviews = baselineState.passiveReadingReviews.map(review => ({ ...review }));
  const firstAt = [raw[0]?.occurredAt, historicalExposures[0]?.occurredAt,
    baselineState?.fsrsReviews[0]?.due ?? baselineState?.fsrsCard.due].filter((value): value is string => Boolean(value)).sort()[0] || now.toISOString();
  if (!unloggedBaseline) {
    state.nextReview = firstAt;
    state.fsrsCard.due = firstAt;
  }
  // Older releases retain a bounded RME history. Keep the counters outside that
  // history as a baseline rather than deleting evidence that cannot be replayed.
  state.rme = { ...createEmptyRmeProfile(),
    successfulExposureCount: Math.max(0, baselineProfile.successfulExposureCount
      - baselineProfile.exposureHistory.filter(e => e.isValid && e.quality >= 0.8).length),
    failedExposureCount: Math.max(0, baselineProfile.failedExposureCount
      - baselineProfile.exposureHistory.filter(e => e.isValid && e.quality <= 0.2).length) };
  let current = state;
  const dates = new Set([...journal.baselineDaily.map(row => row.localDate), ...raw.map(row => row.localDate)]);
  const flashcardIds = new Set(verifications.filter(attempt => attempt.purpose === 'flashcard_review').map(attempt => attempt.attemptId));
  const verificationIds = new Set(verifications.filter(attempt => attempt.purpose !== 'flashcard_review').map(attempt => attempt.attemptId));
  const independentRecalls = (baselineState?.fsrsReviews ?? []).filter(review =>
    (review.source === 'flashcard' && !review.verificationAttemptIds?.some(id => flashcardIds.has(id)))
    || (review.source === 'verification' && !review.verificationAttemptIds?.some(id => verificationIds.has(id))));
  const legacyReviews = (baselineState?.fsrsReviews ?? []).filter(review => review.source !== 'verification'
    && review.source !== 'flashcard');
  const legacyReviewDates = new Map<string, string>();
  for (const review of legacyReviews) {
    const actualEvidenceDay = journal.baselineDaily.find(day => day.articleEvidence.some(article => article.lastSeenAt === review.review));
    const capturedEvidenceDay = journal.baselineDaily.find(day => {
      const zone = raw.find(event => event.localDate === day.localDate && event.timezone)?.timezone || timezone;
      return getLocalDateInTimeZone(new Date(review.review), zone) === day.localDate;
    });
    const date = (actualEvidenceDay ?? capturedEvidenceDay)?.localDate
      ?? getLocalDateInTimeZone(new Date(review.review), timezone);
    legacyReviewDates.set(review.review, date);
    dates.add(date);
  }
  const prepared: RawWordEvent[] = [];
  const daily: DailyWordEvidence[] = [];
  type Action = { at: string; order: number; run: () => void };
  const actions: Action[] = [];
  // Imported word-card history can predate this device's recall journal.
  // Keep these reviews at their actual times, outside daily reading decisions.
  for (const review of independentRecalls) {
    if (!afterBaseline(review.review)) continue;
    actions.push({ at: review.review, order: 3, run: () => {
      const at = new Date(review.review);
      const recent = !current.lastReview || at.getTime() - Date.parse(current.lastReview) < 86_400_000;
      current = applyRmeReview(submitFsrsReview(current, review.rating as 1 | 2 | 3 | 4, at),
        review.rating === 1 ? 'Again' : 'Good', at, review.rating === 2 || recent ? 0.6 : 1);
      current.fsrsReviews[current.fsrsReviews.length - 1] = { ...current.fsrsReviews.at(-1)!,
        source: review.source, ...(review.localDate ? { localDate: review.localDate } : {}),
        ...(review.verificationAttemptIds ? { verificationAttemptIds: review.verificationAttemptIds } : {}),
        ...(review.originalFlashcardRating !== undefined ? { originalFlashcardRating: review.originalFlashcardRating } : {}),
        ...(review.flashcardRevisions ? { flashcardRevisions: review.flashcardRevisions.map(revision => ({ ...revision })) } : {}) };
    } });
  }
  const latestAssisted = (at: string) => {
    if (!current.lastAssistedAt || Date.parse(at) > Date.parse(current.lastAssistedAt)) current.lastAssistedAt = at;
  };
  if (baselineState?.lastAssistedAt) latestAssisted(baselineState.lastAssistedAt);
  for (const exposure of historicalExposures) {
    actions.push({ at: exposure.occurredAt, order: 0, run: () => {
      current.rme = recordExposure(current.rme!, { ...exposure, now: new Date(exposure.occurredAt),
        contextText: baselineProfile.contextHistory.find(row => row.occurrenceId === exposure.occurrenceId
          && row.localDate === exposure.localDate)?.contextText });
    } });
  }
  for (const event of raw) {
    actions.push({ at: event.occurredAt, order: event.eventType === 'exposure' ? 1 : 2, run: () => {
      const savedExposure = baselineProfile.exposureHistory.find(exposure => exposure.occurrenceId === event.occurrenceId
        && exposure.localDate === event.localDate && exposure.occurredAt === event.occurredAt);
      // A finalized baseline is immutable history. New spacing rules apply to
      // incoming events without retroactively removing its credited exposures.
      if (event.eventType === 'exposure' && finalizedBaselineDates.has(event.localDate)
        && (savedExposure || (baselineRawKeys.has(eventKey(event))
          && typeof event.rmeIsValid === 'boolean' && event.rmeExposureKind))) {
        const quality = savedExposure?.quality === 0 ? 0 : calculateExposureQuality({ dwellTimeMs: event.dwellTimeMs,
          expectedDwellTimeMs: event.expectedDwellTimeMs, modelQuality: event.rmeQuality });
        const kind = savedExposure?.kind ?? event.rmeExposureKind!;
        const isValid = savedExposure?.isValid ?? event.rmeIsValid!;
        const profile = recordExposure(current.rme!, { articleId: event.articleId, occurrenceId: event.occurrenceId,
          now: new Date(event.occurredAt), localDate: event.localDate, kind,
          quality, isValid, contextText: event.contextText,
          dwellTimeMs: event.dwellTimeMs, expectedDwellTimeMs: event.expectedDwellTimeMs });
        current = { ...current, rme: projectRmeProfile(profile, current, new Date(event.occurredAt)) };
        prepared.push({ ...event, rmeExposureKind: kind, rmeIsValid: isValid, rmeQuality: quality });
        return;
      }
      // Recompute classification; persisted derived fields reflect the OLD timeline.
      const { rmeExposureKind: _kind, rmeIsValid: _valid, rmeQuality: _quality, ...original } = event;
      const result = prepareRmeEvent(current, original, event.timezone || timezone);
      current = result.state ?? current;
      if (event.eventType === 'click') latestAssisted(event.occurredAt);
      prepared.push(result.event);
    } });
  }
  for (const attempt of replayableVerifications) {
    if (attempt.wordId !== journal.wordId || Date.parse(attempt.occurredAt) > now.getTime()) continue;
    actions.push({ at: attempt.occurredAt, order: 3, run: () => {
      const available = replayableVerifications.filter(row => Date.parse(row.occurredAt) <= Date.parse(attempt.occurredAt));
      const articleRows = new Map<string, ArticleWordEvidence>();
      for (const event of prepared.filter(row => row.localDate === attempt.localDate)) {
        const article = aggregateArticleEvidence(prepared.filter(row => row.localDate === attempt.localDate && row.articleId === event.articleId));
        if (article) articleRows.set(article.articleId, article);
      }
      const day = aggregateDailyEvidence([...articleRows.values()]);
      current = replayVerificationEvidence(current, available, attempt.timezone || timezone, day ? [day] : [], new Date(attempt.occurredAt)) ?? current;
    } });
  }
  for (const date of [...dates].sort()) {
    const dayRaw = raw.filter(event => event.localDate === date);
    const zone = dayRaw.find(event => event.timezone)?.timezone || timezone;
    const end = getUtcInstantForLocalDayEnd(date, zone);
    actions.push({ at: end.toISOString(), order: 4, run: () => {
      const baseline = journal.baselineDaily.find(row => row.localDate === date);
      const articles = new Map<string, ArticleWordEvidence>((baseline?.articleEvidence ?? []).map(row => [row.articleId, row]));
      const dayPrepared = prepared.filter(event => event.localDate === date);
      for (const articleId of new Set(dayPrepared.map(event => event.articleId))) {
        const row = aggregateArticleEvidence(dayPrepared.filter(event => event.articleId === articleId));
        const prior = articles.get(articleId);
        if (row && prior && baseline?.finalizedAt) {
          // Pruned raw records cannot disprove the baseline's known evidence.
          // In particular, later passive reading cannot erase an earlier lookup.
          articles.set(articleId, { ...row,
            validExposureCount: Math.max(prior.validExposureCount, row.validExposureCount),
            clickedOccurrenceCount: Math.max(prior.clickedOccurrenceCount, row.clickedOccurrenceCount),
            firstSeenAt: [prior.firstSeenAt, row.firstSeenAt].sort()[0],
            lastSeenAt: [prior.lastSeenAt, row.lastSeenAt].sort().at(-1)!,
            ...(row.averageRmeQuality === undefined && prior.averageRmeQuality !== undefined
              ? { averageRmeQuality: prior.averageRmeQuality } : {}),
          });
        } else if (row) articles.set(articleId, row);
      }
      const evidence = aggregateDailyEvidence([...articles.values()]);
      const oldReviews = legacyReviews.filter(review => legacyReviewDates.get(review.review) === date
        && afterBaseline(review.review));
      const incoming = incomingEvents.filter(event => event.localDate === date);
      const priorGrade = oldReviews.length > 0 ? (oldReviews.at(-1)!.rating <= 1 ? 'Again' : 'Good') : null;
      const replacesPriorSuccess = priorGrade === 'Good' && incoming.some(event => event.eventType === 'click');
      const measuredOriginalDowngrade = oldReviews.some(review => review.rating === 3
        && journal.events.some(event => {
          if (event.eventType !== 'exposure' || event.localDate !== date || event.occurredAt !== review.review
            || !Number.isFinite(event.dwellTimeMs) || Number(event.dwellTimeMs) < 0
            || !Number.isFinite(event.expectedDwellTimeMs) || Number(event.expectedDwellTimeMs) <= 0) return false;
          const originalRaw = journal.baselineRaw.find(row => eventKey(row) === eventKey(event));
          const originalExposure = baselineProfile.exposureHistory.find(row => row.occurrenceId === event.occurrenceId
            && row.localDate === date && row.occurredAt === event.occurredAt);
          const originalValid = originalExposure?.isValid ?? originalRaw?.rmeIsValid;
          const originalQuality = originalExposure?.quality ?? originalRaw?.rmeQuality;
          if (!originalValid || typeof originalQuality !== 'number') return false;
          const updated = originalRaw ? mergeExposureSnapshot(originalRaw, event) : event;
          if (!updated) return false;
          const quality = calculateExposureQuality({ dwellTimeMs: updated.dwellTimeMs,
            expectedDwellTimeMs: updated.expectedDwellTimeMs, modelQuality: updated.rmeQuality });
          return quality < 0.8 && quality < originalQuality;
        }));
      const hasFinalizedBaseline = Boolean(baseline?.finalizedAt) || oldReviews.length > 0;
      const preservePriorDecision = hasFinalizedBaseline && !replacesPriorSuccess && !measuredOriginalDowngrade
        && (oldReviews.length > 0 || incoming.length === 0);
      const isHistorical = end.getTime() < now.getTime();
      if (evidence) {
        if (isHistorical) {
          if (!preservePriorDecision) {
            // Older lookups still belong in encounter/activity history, but
            // cannot rewrite a known card whose earlier reviews are unavailable.
            const hasLookupAfterBaseline = !unloggedBaseline
              || dayPrepared.some(event => event.eventType === 'click' && afterBaseline(event.occurredAt))
              || baseline?.articleEvidence.some(article => article.clickedOccurrenceCount > 0
                && afterBaseline(article.lastSeenAt));
            if (evidence.pendingGrade !== 'Again' || hasLookupAfterBaseline) {
              current = finalizeDailyEvidence(current, evidence, journal.userId, zone) ?? current;
            }
          } else {
            // Historical raw data may already have been pruned. Preserve the
            // actual old review decision instead of guessing from partial history.
            for (const review of oldReviews) {
              const grade = review.rating <= 1 ? 'Again' : 'Good';
              current = applyRmeReview(submitFsrsReview(current, review.rating as 1 | 2 | 3 | 4, new Date(review.review)), grade,
                new Date(review.review), baseline?.averageRmeQuality ?? 1);
              current.fsrsReviews[current.fsrsReviews.length - 1] = { ...current.fsrsReviews.at(-1)!,
                ...(review.source ? { source: review.source } : {}),
                ...(review.localDate ? { localDate: review.localDate } : {}) };
            }
          }
          evidence.finalizedAt = end.toISOString();
        }
        daily.push(evidence);
      } else if (isHistorical) {
        for (const review of oldReviews) {
          const grade = review.rating <= 1 ? 'Again' : 'Good';
          current = applyRmeReview(submitFsrsReview(current, review.rating as 1 | 2 | 3 | 4, new Date(review.review)), grade, new Date(review.review));
          current.fsrsReviews[current.fsrsReviews.length - 1] = { ...current.fsrsReviews.at(-1)!,
            ...(review.source ? { source: review.source } : {}),
            ...(review.localDate ? { localDate: review.localDate } : {}) };
        }
      }
    } });
  }
  actions.sort((a, b) => a.at.localeCompare(b.at) || a.order - b.order);
  // Current-day aggregation still runs, but does not finalize its review.
  for (const action of actions) action.run();
  current = replayVerificationEvidence(current, replayableVerifications, timezone, daily, now) ?? current;
  current.rme = projectRmeProfile(current.rme!, current, now);
  return { state: current, daily, raw: prepared };
}
