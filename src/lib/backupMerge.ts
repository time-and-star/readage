import { validateLocalDataBackup, MEMORY_IDB_NAME, MEMORY_IDB_VERSION, type LocalDataBackup } from './localDataBackup';
import { MEMORY_TABLES } from './localDatabaseProtocol';
import { importAndVerifyItem, parseMigrationItem, type LocalStorageMigrationTarget, type MigrationItem } from './memoryV2/indexedDbImpl';
import { mergeRawEvents } from './memoryV2/rawEventPersistence';
import type { RawWordEvent } from './memoryV2/types';
import { replayVerificationEvidence } from './memoryV2/verificationMemory';
import { getSystemTimeZone } from './memoryV2/dateUtils';
import { hasCompletedReading } from './readingProgress';

const prefix = 'english-ai:v2:';
const memoryPrefix = `${prefix}memory:`;
const object = (value: any): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const at = (row: any) => Math.max(0, ...['updatedAt', 'lastOpenedAt', 'lastReviewedAt', 'lastSeenAt', 'createdAt', 'timestamp']
  .map(key => Date.parse(row?.[key] ?? '') || 0));
const newer = (a: any, b: any) => at(b) > at(a) ? b : a;

/** Union snapshots without adding aggregate counters whose shared ancestry is unknown. */
function union(a: any, b: any): any {
  if (a === undefined) return b;
  if (b === undefined || same(a, b)) return a;
  if (Array.isArray(a) && Array.isArray(b)) {
    const rows = new Map<string, any>();
    for (const row of [...a, ...b]) {
      const id = object(row) ? row.id ?? row.attemptId ?? row.correctionId : undefined;
      const key = id === undefined ? JSON.stringify(row) : `id:${id}`;
      rows.set(key, rows.has(key) ? union(rows.get(key), row) : row);
    }
    return [...rows.values()];
  }
  if (object(a) && object(b)) {
    const chosen = newer(a, b);
    const out = { ...b, ...a, ...chosen };
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (Array.isArray(a[key]) || object(a[key])) out[key] = union(a[key], b[key]);
      else if (/Count$/.test(key) && typeof a[key] === 'number' && typeof b[key] === 'number') out[key] = Math.max(a[key], b[key]);
    }
    return out;
  }
  return a;
}

function mergeArticles(a: any, b: any) {
  if (!Array.isArray(a) || !Array.isArray(b)) throw new Error('文章备份不是有效列表，合并已停止。');
  const rows = new Map<string, any>();
  for (const row of [...a, ...b]) {
    if (!object(row) || typeof row.id !== 'string' || !row.id || !Array.isArray(row.content)
      || !row.content.every((text: unknown) => typeof text === 'string')) throw new Error('文章备份无效，合并已停止。');
    const prior = rows.get(row.id);
    if (!prior) { rows.set(row.id, row); continue; }
    // Never join paragraph positions, captions or learning identities across different text.
    if (!same(prior.content, row.content) || prior.title !== row.title
      || (prior.sourceDocument && row.sourceDocument && !same(prior.sourceDocument, row.sourceDocument))) {
      throw new Error(`文章“${prior.title}”在两份备份中正文或原文件不同，未合并。请先分别保留备份再处理冲突。`);
    }
    const merged = union(prior, row);
    merged.status = prior.status === 'Completed' || row.status === 'Completed' ? 'Completed' : 'In Progress';
    merged.completedAt = [prior.completedAt, row.completedAt].filter(Boolean).sort()[0];
    merged.lastOpenedAt = [prior.lastOpenedAt, row.lastOpenedAt].filter(Boolean).sort().at(-1);
    if (prior.paragraphTranslations || row.paragraphTranslations) merged.paragraphTranslations = row.content.map((_: string, i: number) =>
      prior.paragraphTranslations?.[i] || row.paragraphTranslations?.[i] || '');
    rows.set(row.id, merged);
  }
  return [...rows.values()];
}

function mergeSetting(key: string, a: string | undefined, b: string): string {
  if (a === undefined || a === b) return a ?? b;
  const name = key.slice(prefix.length);
  // Device preferences, current navigation and service credentials stay on this device.
  if (!['articles', 'events', 'sessions', 'learningDays', 'readingBookmarks', 'readingParagraphProgress', 'weakPoints', 'proficiency', 'externalActivity'].includes(name)) return a;
  let left: any, right: any;
  try { left = JSON.parse(a); right = JSON.parse(b); } catch { throw new Error(`学习记录 ${name} 损坏，合并已停止。`); }
  if (name === 'articles') return JSON.stringify(mergeArticles(left, right));
  if (name === 'readingBookmarks' || name === 'readingParagraphProgress') {
    if (!object(left) || !object(right)) throw new Error('阅读进度备份无效。');
    const out = { ...left };
    for (const [id, row] of Object.entries(right)) {
      const prior = out[id];
      if (!prior) out[id] = row;
      else if (name === 'readingBookmarks') out[id] = newer(prior, row);
      else if (prior.contentVersion !== row.contentVersion) throw new Error('同一文章的段落版本不同，合并已停止。');
      else out[id] = { ...newer(prior, row), completedParagraphs: [...new Set([...prior.completedParagraphs, ...row.completedParagraphs])].sort((a: any, b: any) => a - b) };
    }
    return JSON.stringify(out);
  }
  return JSON.stringify(union(left, right));
}

/** An isolated workspace: no browser, SQLite or user files are modified here. */
class MemoryWorkspace {
  stores = Object.fromEntries(MEMORY_TABLES.map(table => [table, new Map<string, any>()]));
  get(table: string, parts: string[]) { return this.stores[table].get(parts.join('|')) ?? null; }
  put(table: string, value: any, fields: string[]) { this.stores[table].set(fields.map(field => value[field]).join('|'), value); }
  target: LocalStorageMigrationTarget = {
    getMeta: async <T>(key: string) => (this.stores.meta.get(key) ?? null) as T | null,
    setMeta: async (key, value) => { this.stores.meta.set(key, value); },
    getMemoryState: async (...parts) => this.get('memoryState', parts),
    saveMemoryState: async value => this.put('memoryState', value, ['userId', 'wordId']),
    getDailyEvidence: async (...parts) => this.get('dailyEvidence', parts),
    saveDailyEvidence: async value => this.put('dailyEvidence', value, ['userId', 'wordId', 'localDate']),
    getArticleEvidence: async (...parts) => this.get('articleEvidence', parts),
    saveArticleEvidence: async value => this.put('articleEvidence', value, ['userId', 'wordId', 'articleId', 'localDate']),
    getRawEventsByDate: async (...parts) => this.get('rawEvents', parts) ?? [],
    saveRawEvents: async events => {
      for (const row of events) {
        const parts = [row.userId, row.wordId, row.localDate];
        this.stores.rawEvents.set(parts.join('|'), mergeRawEvents(this.get('rawEvents', parts) ?? [], [row]));
      }
    },
    createFinalizationTask: async value => this.put('finalizationTasks', value, ['userId', 'localDate']),
    getPendingFinalizationTasks: async userId => [...this.stores.finalizationTasks.values()].filter(row => row.userId === userId),
    getWordDailyEvidence: async (userId, wordId) => [...this.stores.dailyEvidence.values()].filter(row => row.userId === userId && row.wordId === wordId),
    getRawEventsByDateRange: async (userId, wordId, start, end) => ([...this.stores.rawEvents.values()].flat() as RawWordEvent[])
      .filter(row => row.userId === userId && row.wordId === wordId && row.localDate >= start && row.localDate <= end),
  };
  async add(backup: LocalDataBackup) {
    const items: MigrationItem[] = [];
    const shape = { rawEvents: ['raw', 'events'], articleEvidence: ['article', 'evidence'], dailyEvidence: ['daily', 'evidence'],
      memoryState: ['state', 'state'], finalizationTasks: ['task', 'task'], meta: ['meta', 'value'] } as const;
    for (const table of MEMORY_TABLES) for (const row of backup.indexedDb?.stores[table] ?? [] as any[]) {
      const [kind, field] = shape[table], record = row as any;
      items.push(kind === 'meta' ? { kind, key: record.key, value: record.value } : { kind, value: record[field] } as MigrationItem);
    }
    for (const [key, raw] of Object.entries(backup.localStorage)) if (key.startsWith(memoryPrefix)) {
      if (key.includes('-index:') && !key.startsWith(`${memoryPrefix}meta:`)) continue;
      const value = JSON.parse(raw);
      const item = key.startsWith(`${memoryPrefix}meta:`) ? { kind: 'meta' as const, key: key.slice(`${memoryPrefix}meta:`.length), value }
        : parseMigrationItem(key, value);
      if (!item) throw new Error('备份包含无法合并的旧记忆记录，请先在原设备升级并重新导出。');
      items.push(item);
    }
    const priority = (item: MigrationItem) => item.kind === 'meta' && item.key.startsWith('extension-journal:') ? 0
      : item.kind === 'state' ? 1 : item.kind === 'article' ? 2 : item.kind === 'daily' ? 3 : item.kind === 'raw' ? 4 : item.kind === 'meta' ? 5 : 6;
    for (const item of items.sort((a, b) => priority(a) - priority(b))) {
      if (item.kind === 'meta') {
        const special = ['extension-journal:', 'extension-journal-index:', 'reading-verification:', 'flashcard-study-preferences:'].some(prefix => item.key.startsWith(prefix));
        if (!special) { this.stores.meta.set(item.key, union(this.stores.meta.get(item.key), item.value)); continue; }
        // Validate special journals just as legacy migration does before replay.
        parseMigrationItem(`${memoryPrefix}meta:${item.key}`, item.value);
      }
      await importAndVerifyItem(this.target, item, false);
    }
  }
  snapshot() {
    const fields = { rawEvents: 'events', articleEvidence: 'evidence', dailyEvidence: 'evidence', memoryState: 'state', finalizationTasks: 'task', meta: 'value' };
    return { name: MEMORY_IDB_NAME, version: MEMORY_IDB_VERSION, stores: Object.fromEntries(MEMORY_TABLES.map(table =>
      [table, [...this.stores[table]].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => ({ key, [fields[table]]: value }))])) };
  }
  async finalize() {
    // A write-ahead recall may have been backed up before its derived state was saved.
    for (const [key, journal] of this.stores.meta) if (key.startsWith('reading-verification:')) {
      for (const attempt of journal.attempts ?? []) {
        const id = `${attempt.userId}|${attempt.wordId}`;
        if (this.stores.memoryState.has(id)) continue;
        const recovered = replayVerificationEvidence(null, journal.attempts.filter((row: any) => row.wordId === attempt.wordId), getSystemTimeZone());
        if (recovered) this.stores.memoryState.set(id, recovered);
      }
    }
    for (const [key, state] of this.stores.memoryState) {
      const attempts = this.stores.meta.get(`reading-verification:${state.userId}`)?.attempts;
      if (!attempts) continue;
      const days = await this.target.getWordDailyEvidence!(state.userId, state.wordId);
      const relevant = attempts.filter((row: any) => row.wordId === state.wordId);
      const updated = replayVerificationEvidence(state, relevant, getSystemTimeZone(), days);
      if (!updated) continue;
      this.stores.memoryState.set(key, updated);
      const journal = this.stores.meta.get(`extension-journal:${JSON.stringify([state.userId, state.wordId])}`);
      if (journal) journal.baselineState = { ...updated, rme: journal.baselineState?.rme };
    }
  }
}

export async function mergeLocalDataBackups(currentRaw: unknown, incomingRaw: unknown): Promise<LocalDataBackup> {
  const current = validateLocalDataBackup(currentRaw), incoming = validateLocalDataBackup(incomingRaw);
  const workspace = new MemoryWorkspace();
  try {
    await workspace.add(current); await workspace.add(incoming);
    await workspace.finalize();
  } catch (error) {
    if (error instanceof Error && /Conflicting/.test(error.message)) throw new Error('两份备份的复习评分或查词记录存在冲突，未合并。请分别保留备份并核对记录。', { cause: error });
    throw error;
  }
  const settings = Object.fromEntries(Object.entries(current.localStorage).filter(([key]) => !key.startsWith(memoryPrefix)));
  for (const [key, value] of Object.entries(incoming.localStorage)) if (!key.startsWith(memoryPrefix)) settings[key] = mergeSetting(key, settings[key], value);
  if (settings[`${prefix}articles`] && settings[`${prefix}readingParagraphProgress`]) {
    const articles = JSON.parse(settings[`${prefix}articles`]), progress = JSON.parse(settings[`${prefix}readingParagraphProgress`]);
    settings[`${prefix}articles`] = JSON.stringify(articles.map((article: any) => article.status === 'Completed' || !hasCompletedReading(progress, article)
      ? article : { ...article, status: 'Completed', completedAt: progress[article.id].updatedAt }));
  }
  return validateLocalDataBackup({ ...current, memoryStorage: 'indexedDB', localStorage: settings, indexedDb: workspace.snapshot() });
}
