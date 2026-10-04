/**
 * Memory V2.2 LocalStorage 实现
 * 基于浏览器 localStorage 的持久化存储
 */

import {
  RawWordEvent,
  ArticleWordEvidence,
  DailyWordEvidence,
  WordMemoryState,
  FinalizationTask,
} from './types';
import { MemoryStorage } from './storage';
import { mergeRawEvents } from './rawEventPersistence';

const STORAGE_PREFIX = 'english-ai:v2:memory';

const KEYS = {
  rawEvents: (userId: string, wordId: string, localDate: string) =>
    `${STORAGE_PREFIX}:raw:${userId}:${wordId}:${localDate}`,
  rawEventsIndex: (userId: string) => `${STORAGE_PREFIX}:raw-index:${userId}`,
  articleEvidence: (userId: string, wordId: string, articleId: string, localDate: string) =>
    `${STORAGE_PREFIX}:article:${userId}:${wordId}:${articleId}:${localDate}`,
  articleEvidenceIndex: (userId: string, wordId: string, localDate: string) =>
    `${STORAGE_PREFIX}:article-index:${userId}:${wordId}:${localDate}`,
  dailyEvidence: (userId: string, wordId: string, localDate: string) =>
    `${STORAGE_PREFIX}:daily:${userId}:${wordId}:${localDate}`,
  dailyEvidenceIndex: (userId: string) => `${STORAGE_PREFIX}:daily-index:${userId}`,
  memoryState: (userId: string, wordId: string) =>
    `${STORAGE_PREFIX}:state:${userId}:${wordId}`,
  memoryStateIndex: (userId: string) => `${STORAGE_PREFIX}:state-index:${userId}`,
  finalizationTask: (userId: string, localDate: string) =>
    `${STORAGE_PREFIX}:task:${userId}:${localDate}`,
  finalizationTaskIndex: (userId: string) => `${STORAGE_PREFIX}:task-index:${userId}`,
};

function getStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage;
}

function readJSON<T>(key: string): T | null {
  const storage = getStorage();
  if (!storage) return null;

  try {
    const raw = storage.getItem(key);
    if (raw === null) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function writeJSON<T>(key: string, value: T): void {
  const storage = getStorage();
  if (!storage) return;

  try {
    storage.setItem(key, JSON.stringify(value));
  } catch (error) {
    // Surface quota / write failures so the Memory store can show a user-visible error.
    console.error('Failed to write to storage:', error);
    throw error;
  }
}

function deleteKey(key: string): void {
  const storage = getStorage();
  if (!storage) return;
  storage.removeItem(key);
}

function readIndex(key: string): string[] {
  const value = readJSON<unknown>(key);
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value
    : [];
}

function writeIndex(key: string, items: string[]): void {
  writeJSON(key, items);
}

function splitWordDateIndexEntry(entry: string): [string, string] | null {
  const separator = entry.lastIndexOf(':');
  if (separator <= 0 || separator === entry.length - 1) return null;
  return [entry.slice(0, separator), entry.slice(separator + 1)];
}

function addToIndex(indexKey: string, item: string): void {
  const index = readIndex(indexKey);
  if (!index.includes(item)) {
    index.push(item);
    writeIndex(indexKey, index);
  }
}

function removeFromIndex(indexKey: string, item: string): void {
  const index = readIndex(indexKey);
  const filtered = index.filter((i) => i !== item);
  writeIndex(indexKey, filtered);
}

function storageKeys(): string[] {
  const storage = getStorage();
  if (!storage) return [];
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key) keys.push(key);
  }
  return keys;
}

function repairIndex(indexKey: string, candidates: string[]): string[] {
  const current = readIndex(indexKey);
  const merged = [...current];
  for (const candidate of candidates) if (!merged.includes(candidate)) merged.push(candidate);
  if (merged.length !== current.length) {
    try {
      writeIndex(indexKey, merged);
    } catch (error) {
      // The data record is still readable even when quota pressure blocks repair.
      console.warn('Failed to repair memory index:', indexKey, error);
    }
  }
  return merged;
}

function rawIndexEntries(userId: string): string[] {
  const prefix = `${STORAGE_PREFIX}:raw:${userId}:`;
  return storageKeys()
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length));
}

function dailyIndexEntries(userId: string): string[] {
  const prefix = `${STORAGE_PREFIX}:daily:${userId}:`;
  return storageKeys()
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length));
}

function articleIndexEntries(userId: string, wordId: string, localDate: string): string[] {
  const prefix = `${STORAGE_PREFIX}:article:${userId}:${wordId}:`;
  const suffix = `:${localDate}`;
  return storageKeys()
    .filter((key) => key.startsWith(prefix) && key.endsWith(suffix))
    .map((key) => key.slice(prefix.length, key.length - suffix.length));
}

function stateIndexEntries(userId: string): string[] {
  const prefix = `${STORAGE_PREFIX}:state:${userId}:`;
  return storageKeys()
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length));
}

function taskIndexEntries(userId: string): string[] {
  const prefix = `${STORAGE_PREFIX}:task:${userId}:`;
  return storageKeys()
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length));
}

export class LocalStorageMemoryStorage implements MemoryStorage {
  async getMeta<T>(key: string): Promise<T | null> {
    return readJSON<T>(`${STORAGE_PREFIX}:meta:${key}`);
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    if (!getStorage()) throw new Error('学习记录存储不可用。');
    writeJSON(`${STORAGE_PREFIX}:meta:${key}`, value);
  }

  async getWordDailyEvidence(userId: string, wordId: string): Promise<DailyWordEvidence[]> {
    const rows: DailyWordEvidence[] = [];
    for (const entry of repairIndex(KEYS.dailyEvidenceIndex(userId), dailyIndexEntries(userId))) {
      if (!entry.startsWith(`${wordId}:`)) continue;
      const row = await this.getDailyEvidence(userId, wordId, entry.slice(wordId.length + 1));
      if (row) rows.push(row);
    }
    return rows;
  }
  // ==================== 原始事件 ====================

  async saveRawEvent(event: RawWordEvent): Promise<void> {
    const { userId, wordId, localDate } = event;
    const key = KEYS.rawEvents(userId, wordId, localDate);

    // 读取现有事件
    const events = readJSON<RawWordEvent[]>(key) || [];
    const merged = mergeRawEvents(events, [event]);
    if (merged.length === events.length && merged.every((event, index) => event === events[index])) {
      addToIndex(KEYS.rawEventsIndex(userId), `${wordId}:${localDate}`);
      return;
    }

    // 保存
    writeJSON(key, merged);

    // 更新索引
    addToIndex(KEYS.rawEventsIndex(userId), `${wordId}:${localDate}`);
  }

  async saveRawEvents(events: RawWordEvent[]): Promise<void> {
    if (events.length === 0) return;

    // Group by storage key so each word/day is written once.
    const groups = new Map<string, RawWordEvent[]>();
    for (const event of events) {
      const key = KEYS.rawEvents(event.userId, event.wordId, event.localDate);
      const list = groups.get(key) ?? [];
      list.push(event);
      groups.set(key, list);
    }

    for (const [key, batch] of groups) {
      const existing = readJSON<RawWordEvent[]>(key) || [];
      writeJSON(key, mergeRawEvents(existing, batch));
      const sample = batch[0];
      addToIndex(
        KEYS.rawEventsIndex(sample.userId),
        `${sample.wordId}:${sample.localDate}`
      );
    }
  }

  async getRawEventsByDate(
    userId: string,
    wordId: string,
    localDate: string
  ): Promise<RawWordEvent[]> {
    const key = KEYS.rawEvents(userId, wordId, localDate);
    return readJSON<RawWordEvent[]>(key) || [];
  }

  async deleteRawEventsByDate(
    userId: string,
    wordId: string,
    localDate: string
  ): Promise<void> {
    const key = KEYS.rawEvents(userId, wordId, localDate);
    deleteKey(key);
    removeFromIndex(KEYS.rawEventsIndex(userId), `${wordId}:${localDate}`);
  }

  async getRawEventsByDateRange(
    userId: string,
    wordId: string,
    startDate: string,
    endDate: string
  ): Promise<RawWordEvent[]> {
    const allEvents: RawWordEvent[] = [];

    // 遍历索引找到相关日期
    const index = repairIndex(KEYS.rawEventsIndex(userId), rawIndexEntries(userId));
    for (const entry of index) {
      const parsed = splitWordDateIndexEntry(entry);
      if (!parsed) continue;
      const [entryWordId, entryDate] = parsed;
      if (entryWordId === wordId && entryDate >= startDate && entryDate <= endDate) {
        const events = await this.getRawEventsByDate(userId, wordId, entryDate);
        allEvents.push(...events);
      }
    }

    return allEvents;
  }

  // ==================== 文章级词据 ====================

  async saveArticleEvidence(evidence: ArticleWordEvidence): Promise<void> {
    const { userId, wordId, articleId, localDate } = evidence;
    const key = KEYS.articleEvidence(userId, wordId, articleId, localDate);

    writeJSON(key, evidence);

    // 更新索引
    const indexKey = KEYS.articleEvidenceIndex(userId, wordId, localDate);
    addToIndex(indexKey, articleId);
  }

  async getArticleEvidence(
    userId: string,
    wordId: string,
    articleId: string,
    localDate: string
  ): Promise<ArticleWordEvidence | null> {
    const key = KEYS.articleEvidence(userId, wordId, articleId, localDate);
    return readJSON<ArticleWordEvidence>(key);
  }

  async getArticleEvidencesByDate(
    userId: string,
    wordId: string,
    localDate: string
  ): Promise<ArticleWordEvidence[]> {
    const indexKey = KEYS.articleEvidenceIndex(userId, wordId, localDate);
    const articleIds = repairIndex(indexKey, articleIndexEntries(userId, wordId, localDate));

    const evidences: ArticleWordEvidence[] = [];
    for (const articleId of articleIds) {
      const evidence = await this.getArticleEvidence(userId, wordId, articleId, localDate);
      if (evidence) {
        evidences.push(evidence);
      }
    }

    return evidences;
  }

  // ==================== 每日词据 ====================

  async saveDailyEvidence(evidence: DailyWordEvidence): Promise<void> {
    const { userId, wordId, localDate } = evidence;
    const key = KEYS.dailyEvidence(userId, wordId, localDate);

    writeJSON(key, evidence);

    // 更新索引
    addToIndex(KEYS.dailyEvidenceIndex(userId), `${wordId}:${localDate}`);
  }

  async getDailyEvidence(
    userId: string,
    wordId: string,
    localDate: string
  ): Promise<DailyWordEvidence | null> {
    const key = KEYS.dailyEvidence(userId, wordId, localDate);
    return readJSON<DailyWordEvidence>(key);
  }

  async getUnfinalizedDailyEvidence(userId: string): Promise<DailyWordEvidence[]> {
    const index = repairIndex(KEYS.dailyEvidenceIndex(userId), dailyIndexEntries(userId));
    const evidences: DailyWordEvidence[] = [];

    for (const entry of index) {
      const parsed = splitWordDateIndexEntry(entry);
      if (!parsed) continue;
      const [wordId, localDate] = parsed;
      const evidence = await this.getDailyEvidence(userId, wordId, localDate);
      if (evidence && !evidence.finalizedAt) {
        evidences.push(evidence);
      }
    }

    return evidences;
  }

  async getUnfinalizedDailyEvidenceByDate(
    userId: string,
    localDate: string
  ): Promise<DailyWordEvidence[]> {
    const index = repairIndex(KEYS.dailyEvidenceIndex(userId), dailyIndexEntries(userId));
    const evidences: DailyWordEvidence[] = [];

    for (const entry of index) {
      const parsed = splitWordDateIndexEntry(entry);
      if (!parsed) continue;
      const [wordId, entryDate] = parsed;
      if (entryDate === localDate) {
        const evidence = await this.getDailyEvidence(userId, wordId, localDate);
        if (evidence && !evidence.finalizedAt) {
          evidences.push(evidence);
        }
      }
    }

    return evidences;
  }

  async markDailyEvidenceFinalized(
    userId: string,
    wordId: string,
    localDate: string,
    finalizedAt: string
  ): Promise<void> {
    const evidence = await this.getDailyEvidence(userId, wordId, localDate);
    if (evidence) {
      evidence.finalizedAt = finalizedAt;
      await this.saveDailyEvidence(evidence);
    }
  }

  // ==================== 记忆状态 ====================

  async saveMemoryState(state: WordMemoryState): Promise<void> {
    const { userId, wordId } = state;
    const key = KEYS.memoryState(userId, wordId);

    writeJSON(key, state);

    // 更新索引
    addToIndex(KEYS.memoryStateIndex(userId), wordId);
  }

  async getMemoryState(userId: string, wordId: string): Promise<WordMemoryState | null> {
    const key = KEYS.memoryState(userId, wordId);
    return readJSON<WordMemoryState>(key);
  }

  async getBatchMemoryStates(
    userId: string,
    wordIds: string[]
  ): Promise<Map<string, WordMemoryState>> {
    const states = new Map<string, WordMemoryState>();

    for (const wordId of wordIds) {
      const state = await this.getMemoryState(userId, wordId);
      if (state) {
        states.set(wordId, state);
      }
    }

    return states;
  }

  async getAllMemoryStates(userId: string): Promise<WordMemoryState[]> {
    const index = repairIndex(KEYS.memoryStateIndex(userId), stateIndexEntries(userId));
    const states: WordMemoryState[] = [];

    for (const wordId of index) {
      const state = await this.getMemoryState(userId, wordId);
      if (state) {
        states.push(state);
      }
    }

    return states;
  }

  // ==================== 结算任务 ====================

  async createFinalizationTask(task: FinalizationTask): Promise<void> {
    const { userId, localDate } = task;
    const key = KEYS.finalizationTask(userId, localDate);

    writeJSON(key, task);

    // 更新索引
    addToIndex(KEYS.finalizationTaskIndex(userId), localDate);
  }

  async getPendingFinalizationTasks(userId: string): Promise<FinalizationTask[]> {
    const index = repairIndex(KEYS.finalizationTaskIndex(userId), taskIndexEntries(userId));
    const tasks: FinalizationTask[] = [];

    for (const localDate of index) {
      const task = readJSON<FinalizationTask>(KEYS.finalizationTask(userId, localDate));
      if (task) {
        tasks.push(task);
      }
    }

    return tasks;
  }

  async deleteFinalizationTask(userId: string, localDate: string): Promise<void> {
    const key = KEYS.finalizationTask(userId, localDate);
    deleteKey(key);

    // 从索引移除
    removeFromIndex(KEYS.finalizationTaskIndex(userId), localDate);
  }
}
