import type { MemoryStorage } from './storage';
import type { ArticleWordEvidence, DailyWordEvidence, FinalizationTask, RawWordEvent, WordMemoryState } from './types';
import { queryLocalRows, queryLocalRowsByKeys, prefetchLocalRowsByKeys, putLocalRow } from '../localDatabase';
import { mergeRawEvents } from './rawEventPersistence';
import type { LocalTable } from '../localDatabaseProtocol';

/** Uses the same record identities and algorithms as the existing memory store. */
export class SqliteMemoryStorage implements MemoryStorage {
  readonly backend = 'sqlite';
  private async get<T>(table: LocalTable, key: string, field: string): Promise<T | null> {
    const row = (await queryLocalRows(table, key))[0];
    return row ? (row.value as Record<string, T>)[field] ?? null : null;
  }
  private async list<T>(table: LocalTable, prefix: string, field: string): Promise<T[]> {
    return (await queryLocalRows(table, undefined, prefix)).map(row => (row.value as Record<string, T>)[field]);
  }
  async getMeta<T>(key: string) { return this.get<T>('meta', key, 'value'); }
  async setMeta(key: string, value: unknown) { await putLocalRow('meta', key, { value }); }
  async prefetchEventBatch(events: readonly RawWordEvent[]) {
    const stateKeys = events.map(event => `${event.userId}|${event.wordId}`);
    const dateKeys = events.map(event => `${event.userId}|${event.wordId}|${event.localDate}`);
    await Promise.all([
      prefetchLocalRowsByKeys('memoryState', stateKeys),
      prefetchLocalRowsByKeys('rawEvents', dateKeys),
      prefetchLocalRowsByKeys('dailyEvidence', dateKeys),
    ]);
  }
  async saveRawEvent(event: RawWordEvent) { await this.saveRawEvents([event]); }
  async saveRawEvents(events: RawWordEvent[]) {
    const groups = new Map<string, RawWordEvent[]>();
    for (const event of events) {
      const key = `${event.userId}|${event.wordId}|${event.localDate}`;
      groups.set(key, [...(groups.get(key) ?? []), event]);
    }
    const previousRows = await queryLocalRowsByKeys('rawEvents', [...groups.keys()]);
    const previousEvents = new Map(previousRows.map(row => [row.key, (row.value as { events: RawWordEvent[] }).events]));
    // Normal application writers already hold the enclosing memory transaction.
    for (const [key, batch] of groups) {
      const previous = previousEvents.get(key) ?? [];
      await putLocalRow('rawEvents', key, { events: mergeRawEvents(previous, batch) });
    }
  }
  async getRawEventsByDate(userId: string, wordId: string, date: string) { return await this.get<RawWordEvent[]>('rawEvents', `${userId}|${wordId}|${date}`, 'events') ?? []; }
  async getRawEventsByDateRange(userId: string, wordId: string, start: string, end: string) {
    const prefix = `${userId}|${wordId}|`;
    return (await queryLocalRows('rawEvents', undefined, prefix)).filter(row => row.key.slice(prefix.length) >= start && row.key.slice(prefix.length) <= end)
      .flatMap(row => (row.value as { events: RawWordEvent[] }).events);
  }
  async deleteRawEventsByDate(userId: string, wordId: string, date: string) { await putLocalRow('rawEvents', `${userId}|${wordId}|${date}`, null, true); }
  async saveArticleEvidence(evidence: ArticleWordEvidence) { await putLocalRow('articleEvidence', `${evidence.userId}|${evidence.wordId}|${evidence.articleId}|${evidence.localDate}`, { evidence }); }
  async getArticleEvidence(userId: string, wordId: string, articleId: string, date: string) { return this.get<ArticleWordEvidence>('articleEvidence', `${userId}|${wordId}|${articleId}|${date}`, 'evidence'); }
  async getArticleEvidencesByDate(userId: string, wordId: string, date: string) { return (await this.list<ArticleWordEvidence>('articleEvidence', `${userId}|${wordId}|`, 'evidence')).filter(row => row.localDate === date); }
  async getAllArticleEvidence(userId: string) { return (await this.list<ArticleWordEvidence>('articleEvidence', `${userId}|`, 'evidence')).filter(row => row.clickedOccurrenceCount > 0); }
  async saveDailyEvidence(evidence: DailyWordEvidence) { await putLocalRow('dailyEvidence', `${evidence.userId}|${evidence.wordId}|${evidence.localDate}`, { evidence }); }
  async getDailyEvidence(userId: string, wordId: string, date: string) { return this.get<DailyWordEvidence>('dailyEvidence', `${userId}|${wordId}|${date}`, 'evidence'); }
  async getWordDailyEvidence(userId: string, wordId: string) { return this.list<DailyWordEvidence>('dailyEvidence', `${userId}|${wordId}|`, 'evidence'); }
  async getAllDailyEvidence(userId: string) { return this.list<DailyWordEvidence>('dailyEvidence', `${userId}|`, 'evidence'); }
  async getUnfinalizedDailyEvidence(userId: string) { return (await this.list<DailyWordEvidence>('dailyEvidence', `${userId}|`, 'evidence')).filter(row => !row.finalizedAt); }
  async getUnfinalizedDailyEvidenceByDate(userId: string, date: string) { return (await this.getUnfinalizedDailyEvidence(userId)).filter(row => row.localDate === date); }
  async markDailyEvidenceFinalized(userId: string, wordId: string, date: string, finalizedAt: string) { const row = await this.getDailyEvidence(userId, wordId, date); if (row) await this.saveDailyEvidence({ ...row, finalizedAt }); }
  async saveMemoryState(state: WordMemoryState) { await putLocalRow('memoryState', `${state.userId}|${state.wordId}`, { state }); }
  async getMemoryState(userId: string, wordId: string) { return this.get<WordMemoryState>('memoryState', `${userId}|${wordId}`, 'state'); }
  async getAllMemoryStates(userId: string) { return this.list<WordMemoryState>('memoryState', `${userId}|`, 'state'); }
  async getBatchMemoryStates(userId: string, wordIds: string[]) {
    const rows = await queryLocalRowsByKeys('memoryState', wordIds.map(wordId => `${userId}|${wordId}`));
    return new Map(rows.map(row => {
      const state = (row.value as { state: WordMemoryState }).state;
      return [state.wordId, state];
    }));
  }
  async createFinalizationTask(task: FinalizationTask) { await putLocalRow('finalizationTasks', `${task.userId}|${task.localDate}`, { task }); }
  async getPendingFinalizationTasks(userId: string) { return this.list<FinalizationTask>('finalizationTasks', `${userId}|`, 'task'); }
  async deleteFinalizationTask(userId: string, date: string) { await putLocalRow('finalizationTasks', `${userId}|${date}`, null, true); }
}
