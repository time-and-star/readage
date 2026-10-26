import type { MemoryStorage } from '../memoryV2/storage';
import type { RawWordEvent, WordMemoryState } from '../memoryV2/types';
import { getLocalDateInTimeZone } from '../memoryV2/dateUtils';
import { parseLookupBatch } from './protocol';
import { eventKey, replayWordJournal, type TimedWordEvent, type WordJournal } from './replay';
import type { LearningEvent } from '../../types';
import { mergeExposureSnapshot } from '../memoryV2/rawEventPersistence';
import { readVerificationHistory } from '../memoryV2/verificationMemory';

const journalKey = (userId: string, wordId: string) => `extension-journal:${JSON.stringify([userId, wordId])}`;
const indexKey = (userId: string) => `extension-journal-index:${userId}`;

function mergePassiveReviewAudit(...groups: Array<WordMemoryState['fsrsReviews'] | undefined>): WordMemoryState['fsrsReviews'] {
  const reviews = new Map<string, WordMemoryState['fsrsReviews'][number]>();
  for (const group of groups) for (const review of group ?? []) {
    const key = JSON.stringify([review.source ?? 'legacy', review.review, review.rating, review.localDate ?? null]);
    reviews.set(key, review);
  }
  return [...reviews.values()].sort((left, right) => left.review.localeCompare(right.review)).map(review => structuredClone(review));
}

/** Derive activity from the acknowledged journal, including previously synced queries. */
export async function readExternalLearningActivity(storage: MemoryStorage, userId: string): Promise<LearningEvent[]> {
  if (!storage.getMeta) return [];
  const words = await storage.getMeta<string[]>(indexKey(userId)) ?? [];
  const activity = new Map<string, LearningEvent>();
  for (const word of words) {
    const journal = await storage.getMeta<WordJournal>(journalKey(userId, word));
    for (const event of journal?.events ?? []) {
      if (event.eventType !== 'click' || !event.occurrenceId.startsWith('extension:')) continue;
      activity.set(event.occurrenceId, { id: event.occurrenceId, type: 'click', lemma: event.wordId,
        createdAt: event.occurredAt, localDate: event.localDate, detail: '浏览器查词' });
    }
  }
  return [...activity.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Write-ahead journal: a crash at any derived write is repaired by replay. */
export async function persistJournal(storage: MemoryStorage, journal: WordJournal, timezone: string, now: Date,
  newFailureDates: ReadonlySet<string> = new Set()) {
  const pendingFailures = new Set([...journal.pendingFailureDates ?? [], ...newFailureDates]);
  const verifications = (await readVerificationHistory(storage, journal.userId)).filter(attempt => attempt.wordId === journal.wordId);
  const currentState = await storage.getMemoryState(journal.userId, journal.wordId);
  const passiveReadingReviews = mergePassiveReviewAudit(journal.baselineState?.passiveReadingReviews,
    currentState?.passiveReadingReviews);
  // The original baseline remains immutable. A persisted repair audit is
  // authoritative even if this older journal no longer has its daily evidence.
  const replayJournal = passiveReadingReviews.length && journal.baselineState
    ? { ...journal, baselineState: { ...journal.baselineState, passiveReadingReviews } } : journal;
  const result = replayWordJournal(replayJournal, timezone, now, verifications,
    currentState?.fsrsReviews ?? [], pendingFailures);
  if (passiveReadingReviews.length) result.state.passiveReadingReviews = mergePassiveReviewAudit(passiveReadingReviews,
    result.state.passiveReadingReviews);
  for (const evidence of result.daily) {
    for (const article of evidence.articleEvidence) await storage.saveArticleEvidence(article);
    await storage.saveDailyEvidence(evidence);
  }
  for (const date of new Set(result.raw.map(event => event.localDate))) {
    await storage.deleteRawEventsByDate(journal.userId, journal.wordId, date);
    await storage.saveRawEvents(result.raw.filter(event => event.localDate === date));
  }
  await storage.saveMemoryState(result.state);
  // Clear only after every derived write succeeds. A retry must still know that
  // an already-journaled failure may supersede an older saved Again timestamp.
  if (journal.pendingFailureDates?.length) {
    const { pendingFailureDates: _pending, ...settled } = journal;
    await storage.setMeta?.(journalKey(journal.userId, journal.wordId), settled);
  }
}

export async function appendJournalEvents(storage: MemoryStorage, events: TimedWordEvent[], timezone: string, now: Date, create = false): Promise<boolean> {
  if (!storage.getMeta || !storage.setMeta || !storage.getWordDailyEvidence || events.length === 0) {
    if (create) throw new Error('当前学习存储暂不支持插件同步，请刷新主应用后重试。');
    return false;
  }
  const { userId, wordId } = events[0];
  const key = journalKey(userId, wordId);
  let journal = await storage.getMeta<WordJournal>(key);
  if (!journal) {
    if (!create) return false;
    journal = { version: 1, userId, wordId,
      baselineState: await storage.getMemoryState(userId, wordId),
      baselineDaily: await storage.getWordDailyEvidence(userId, wordId),
      baselineRaw: await storage.getRawEventsByDateRange(userId, wordId, '0001-01-01', '9999-12-31'), events: [] };
  }
  const existing = new Map(journal.events.map(event => [eventKey(event), event]));
  const known = new Set([...journal.baselineRaw, ...journal.events].map(eventKey));
  const newFailureDates = new Set(events.filter(event => event.eventType === 'click' && !event.lookupOnly
    && !known.has(eventKey(event))).map(event => event.localDate));
  for (const event of events) {
    const prior = existing.get(eventKey(event));
    const updated = prior ? mergeExposureSnapshot(prior, event) : null;
    if (prior && !updated && JSON.stringify(prior) !== JSON.stringify(event)) throw new Error('查词记录标识冲突。');
    existing.set(eventKey(event), updated ?? event);
  }
  const pendingFailureDates = [...new Set([...journal.pendingFailureDates ?? [], ...newFailureDates])];
  journal = { ...journal, events: [...existing.values()],
    ...(pendingFailureDates.length ? { pendingFailureDates } : {}) };
  const index = await storage.getMeta<string[]>(indexKey(userId)) ?? [];
  if (!index.includes(wordId)) await storage.setMeta(indexKey(userId), [...index, wordId]);
  await storage.setMeta(key, journal);
  await persistJournal(storage, journal, timezone, now, newFailureDates);
  return true;
}

export async function refreshWordJournal(storage: MemoryStorage, userId: string, wordId: string, timezone: string, now: Date): Promise<boolean> {
  const journal = await storage.getMeta?.<WordJournal>(journalKey(userId, wordId));
  if (!journal) return false;
  await persistJournal(storage, journal, timezone, now);
  return true;
}

export async function refreshUserJournals(storage: MemoryStorage, userId: string, timezone: string, now: Date): Promise<void> {
  const words = await storage.getMeta?.<string[]>(indexKey(userId)) ?? [];
  for (const wordId of words) await refreshWordJournal(storage, userId, wordId, timezone, now);
}

export async function importLookupEvents(storage: MemoryStorage, userId: string, value: unknown, timezone: string, now = new Date()): Promise<string[]> {
  const batch = parseLookupBatch(value);
  const groups = new Map<string, TimedWordEvent[]>();
  for (const lookup of batch) {
    const event: RawWordEvent & { timezone: string } = { userId, wordId: lookup.lemma,
      articleId: lookup.sourceId, occurrenceId: `extension:${lookup.id}`, eventType: 'exposure',
      occurredAt: lookup.occurredAt, localDate: getLocalDateInTimeZone(new Date(lookup.occurredAt), lookup.timezone),
      timezone: lookup.timezone, contextText: `Word search: ${lookup.query}` };
    const events = groups.get(lookup.lemma) ?? [];
    events.push(event, { ...event, eventType: 'click' });
    groups.set(lookup.lemma, events);
  }
  for (const events of groups.values()) {
    const prior = await storage.getMeta?.<WordJournal>(journalKey(userId, events[0].wordId));
    const known = new Map([...(prior?.baselineRaw ?? []), ...(prior?.events ?? [])].map(event => [eventKey(event), event]));
    const incoming = events.map(event => event.eventType !== 'click' ? event
      : known.has(eventKey(event)) ? { ...event, ...(known.get(eventKey(event))!.lookupOnly ? { lookupOnly: true as const } : {}) }
      : { ...event, lookupOnly: true as const });
    await appendJournalEvents(storage, incoming, timezone, now, true);
  }
  return batch.map(event => event.id);
}
