import type { ArticleWordEvidence, DailyWordEvidence, RawWordEvent, WordMemoryState } from '../memoryV2/types';
import { aggregateArticleEvidence, aggregateDailyEvidence } from '../memoryV2/evidenceAggregation';
import { finalizeDailyEvidence, initializeWordMemory, submitFsrsReview } from '../memoryV2/fsrsIntegration';
import { applyRmeReview, prepareRmeEvent, projectRmeProfile, rmeProfileForState } from '../memoryV2/rmeV4Bridge';
import { getLocalDateInTimeZone, getUtcInstantForLocalDayEnd } from '../memoryV2/dateUtils';
import { createEmptyRmeProfile, recordExposure } from '../memoryV4';

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

export function replayWordJournal(journal: WordJournal, timezone: string, now: Date) {
  const unique = new Map<string, TimedWordEvent>();
  for (const event of [...journal.baselineRaw, ...journal.events]) unique.set(eventKey(event), event);
  const raw = [...unique.values()].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)
    || a.occurrenceId.localeCompare(b.occurrenceId) || (a.eventType === 'exposure' ? -1 : 1));
  const rawOccurrences = new Set(raw.map(event => event.occurrenceId));
  const baselineProfile = rmeProfileForState(journal.baselineState);
  const historicalExposures = baselineProfile.exposureHistory.filter(event => !rawOccurrences.has(event.occurrenceId));
  const state = initializeWordMemory(journal.userId, journal.wordId);
  const firstAt = [raw[0]?.occurredAt, historicalExposures[0]?.occurredAt,
    journal.baselineState?.fsrsReviews[0]?.due].filter((value): value is string => Boolean(value)).sort()[0] || now.toISOString();
  state.nextReview = firstAt;
  state.fsrsCard.due = firstAt;
  // Older releases retain a bounded RME history. Keep the counters outside that
  // history as a baseline rather than deleting evidence that cannot be replayed.
  state.rme = { ...createEmptyRmeProfile(),
    successfulExposureCount: Math.max(0, baselineProfile.successfulExposureCount
      - baselineProfile.exposureHistory.filter(e => e.isValid && e.quality >= 0.8).length),
    failedExposureCount: Math.max(0, baselineProfile.failedExposureCount
      - baselineProfile.exposureHistory.filter(e => e.isValid && e.quality <= 0.2).length) };
  let current = state;
  const dates = new Set([...journal.baselineDaily.map(row => row.localDate), ...raw.map(row => row.localDate)]);
  const legacyReviews = journal.baselineState?.fsrsReviews ?? [];
  for (const review of legacyReviews) dates.add(getLocalDateInTimeZone(new Date(review.review), timezone));
  const prepared: RawWordEvent[] = [];
  const daily: DailyWordEvidence[] = [];
  type Action = { at: string; order: number; run: () => void };
  const actions: Action[] = [];
  for (const exposure of historicalExposures) {
    actions.push({ at: exposure.occurredAt, order: 0, run: () => {
      current.rme = recordExposure(current.rme!, { ...exposure, now: new Date(exposure.occurredAt),
        contextText: baselineProfile.contextHistory.find(row => row.occurrenceId === exposure.occurrenceId)?.contextText });
    } });
  }
  for (const event of raw) {
    actions.push({ at: event.occurredAt, order: event.eventType === 'exposure' ? 1 : 2, run: () => {
      // Recompute classification; persisted derived fields reflect the OLD timeline.
      const { rmeExposureKind: _kind, rmeIsValid: _valid, rmeQuality: _quality, ...original } = event;
      const result = prepareRmeEvent(current, original);
      current = result.state ?? current;
      prepared.push(result.event);
    } });
  }
  for (const date of [...dates].sort()) {
    const dayRaw = raw.filter(event => event.localDate === date);
    const zone = dayRaw.find(event => event.timezone)?.timezone || timezone;
    const end = getUtcInstantForLocalDayEnd(date, zone);
    actions.push({ at: end.toISOString(), order: 3, run: () => {
      const baseline = journal.baselineDaily.find(row => row.localDate === date);
      const articles = new Map<string, ArticleWordEvidence>((baseline?.articleEvidence ?? []).map(row => [row.articleId, row]));
      const dayPrepared = prepared.filter(event => event.localDate === date);
      for (const articleId of new Set(dayPrepared.map(event => event.articleId))) {
        const row = aggregateArticleEvidence(dayPrepared.filter(event => event.articleId === articleId));
        if (row) articles.set(articleId, row);
      }
      const evidence = aggregateDailyEvidence([...articles.values()]);
      const oldReviews = legacyReviews.filter(review => getLocalDateInTimeZone(new Date(review.review), timezone) === date);
      const isHistorical = end.getTime() < now.getTime();
      if (evidence) {
        if (isHistorical) {
          if (dayRaw.length || !baseline?.finalizedAt) {
            current = finalizeDailyEvidence(current, evidence, journal.userId, zone) ?? current;
          } else {
            // Historical raw data may already have been pruned. Preserve the
            // actual old review decision instead of guessing from partial history.
            for (const review of oldReviews) {
              const grade = review.rating <= 1 ? 'Again' : 'Good';
              current = applyRmeReview(submitFsrsReview(current, grade, new Date(review.review)), grade,
                new Date(review.review), baseline.averageRmeQuality ?? 1);
            }
          }
          evidence.finalizedAt = end.toISOString();
        }
        daily.push(evidence);
      } else if (isHistorical) {
        for (const review of oldReviews) {
          const grade = review.rating <= 1 ? 'Again' : 'Good';
          current = applyRmeReview(submitFsrsReview(current, grade, new Date(review.review)), grade, new Date(review.review));
        }
      }
    } });
  }
  actions.sort((a, b) => a.at.localeCompare(b.at) || a.order - b.order);
  // Current-day aggregation still runs, but does not finalize its review.
  for (const action of actions) action.run();
  current.rme = projectRmeProfile(current.rme!, current, now);
  return { state: current, daily, raw: prepared };
}
