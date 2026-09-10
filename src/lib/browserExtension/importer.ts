import type { MemoryStorage } from '../memoryV2/storage';
import type { RawWordEvent } from '../memoryV2/types';
import { getLocalDateInTimeZone } from '../memoryV2/dateUtils';
import { parseLookupBatch } from './protocol';
import { eventKey, replayWordJournal, type TimedWordEvent, type WordJournal } from './replay';
import type { LearningEvent } from '../../types';

const journalKey = (userId: string, wordId: string) => `extension-journal:${JSON.stringify([userId, wordId])}`;
const indexKey = (userId: string) => `extension-journal-index:${userId}`;

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
export async function persistJournal(storage: MemoryStorage, journal: WordJournal, timezone: string, now: Date) {
  const result = replayWordJournal(journal, timezone, now);
  for (const evidence of result.daily) {
    for (const article of evidence.articleEvidence) await storage.saveArticleEvidence(article);
    await storage.saveDailyEvidence(evidence);
  }
  for (const date of new Set(result.raw.map(event => event.localDate))) {
    await storage.deleteRawEventsByDate(journal.userId, journal.wordId, date);
    await storage.saveRawEvents(result.raw.filter(event => event.localDate === date));
  }
  await storage.saveMemoryState(result.state);
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
  for (const event of events) {
    const prior = existing.get(eventKey(event));
    if (prior && JSON.stringify(prior) !== JSON.stringify(event)) throw new Error('查词记录标识冲突。');
    existing.set(eventKey(event), event);
  }
  journal = { ...journal, events: [...existing.values()] };
  const index = await storage.getMeta<string[]>(indexKey(userId)) ?? [];
  if (!index.includes(wordId)) await storage.setMeta(indexKey(userId), [...index, wordId]);
  await storage.setMeta(key, journal);
  await persistJournal(storage, journal, timezone, now);
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
  for (const events of groups.values()) await appendJournalEvents(storage, events, timezone, now, true);
  return batch.map(event => event.id);
}
