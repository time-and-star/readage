import type { MemoryStorage } from './memoryV2/storage';
import { initializeWordMemory } from './memoryV2/fsrsIntegration';

export interface FlashcardStudyPreferences {
  dailyNewWordLimit: number | null;
  importedWordIds: string[];
  pausedWordIds?: string[];
  excludedWordIds?: string[];
}
export type FlashcardWordAction = 'pause' | 'resume' | 'remove';
export interface FlashcardWordImportResult {
  addedCount: number;
  existingCount: number;
  enrolledCount: number;
}
interface FlashcardPreferenceRecord extends FlashcardStudyPreferences {
  version: 1;
  userId: string;
  /** Distinguish newer explicit settings from an older migration or recovery snapshot. */
  updatedAt?: string;
  /** Preserve aliases across interrupted registration before the canonical baseline was seeded. */
  aliasBaselines: Array<{ wordId: string; legacyWordIds: string[] }>;
}
type SeedBaseline = (wordId: string, legacyWordIds: readonly string[]) => Promise<void>;
const preferenceKey = (userId: string) => `flashcard-study-preferences:${userId}`;

export function validateDailyNewWordLimit(limit: number | null): void {
  if (limit !== null && (!Number.isSafeInteger(limit) || limit < 0)) {
    throw new TypeError('每日新词数必须是非负整数，或选择不限。');
  }
}

/** Callers resolve dictionary lemmas first; normalization never guesses an inflection. */
function importedId(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('导入词必须使用有效的学习词标识。');
  const wordId = value.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!wordId || wordId.length > 480) throw new TypeError('导入词必须使用有效的学习词标识。');
  return wordId;
}
function defaultRecord(userId: string): FlashcardPreferenceRecord {
  return { version: 1, userId, dailyNewWordLimit: 10, importedWordIds: [], aliasBaselines: [] };
}
async function readRecord(storage: MemoryStorage, userId: string): Promise<FlashcardPreferenceRecord> {
  const raw = await storage.getMeta?.<Partial<FlashcardPreferenceRecord>>(preferenceKey(userId));
  if (!raw || raw.version !== 1 || raw.userId !== userId) return defaultRecord(userId);
  let dailyNewWordLimit = raw.dailyNewWordLimit;
  try { validateDailyNewWordLimit(dailyNewWordLimit as number | null); }
  catch { dailyNewWordLimit = 10; }
  const importedWordIds = [...new Set((Array.isArray(raw.importedWordIds) ? raw.importedWordIds : [])
    .flatMap(value => { try { return [importedId(value)]; } catch { return []; } }))];
  const registered = new Set(importedWordIds);
  const aliasBaselines = (Array.isArray(raw.aliasBaselines) ? raw.aliasBaselines : []).flatMap(row => {
    if (!row || typeof row.wordId !== 'string' || !registered.has(row.wordId) || !Array.isArray(row.legacyWordIds)) return [];
    return [{ wordId: row.wordId, legacyWordIds: [...new Set(row.legacyWordIds
      .filter(id => typeof id === 'string' && id.trim() && id.length <= 500 && id !== row.wordId))] }];
  });
  const normalizeIds = (ids: unknown) => [...new Set((Array.isArray(ids) ? ids : [])
    .flatMap(value => { try { return [importedId(value)]; } catch { return []; } }))];
  return { version: 1, userId, dailyNewWordLimit: dailyNewWordLimit as number | null, importedWordIds, aliasBaselines,
    ...(typeof raw.updatedAt === 'string' && Number.isFinite(Date.parse(raw.updatedAt)) ? { updatedAt: raw.updatedAt } : {}),
    ...(raw.pausedWordIds ? { pausedWordIds: normalizeIds(raw.pausedWordIds) } : {}),
    ...(raw.excludedWordIds ? { excludedWordIds: normalizeIds(raw.excludedWordIds) } : {}) };
}
function preferences(record: FlashcardPreferenceRecord): FlashcardStudyPreferences {
  return { dailyNewWordLimit: record.dailyNewWordLimit, importedWordIds: [...record.importedWordIds],
    ...(record.pausedWordIds ? { pausedWordIds: [...record.pausedWordIds] } : {}),
    ...(record.excludedWordIds ? { excludedWordIds: [...record.excludedWordIds] } : {}) };
}
async function writeRecord(storage: MemoryStorage, record: FlashcardPreferenceRecord): Promise<void> {
  if (!storage.getMeta || !storage.setMeta) throw new Error('当前学习存储不支持保存词卡设置和导入词表。');
  const updated = { ...record, updatedAt: new Date().toISOString() };
  await storage.setMeta(preferenceKey(record.userId), updated);
  const saved = await storage.getMeta<FlashcardPreferenceRecord>(preferenceKey(record.userId));
  if (JSON.stringify(saved) !== JSON.stringify(updated)) throw new Error('词卡设置尚未完整保存，请重试。');
}

export async function readFlashcardStudyPreferences(storage: MemoryStorage, userId: string): Promise<FlashcardStudyPreferences> {
  return preferences(await readRecord(storage, userId));
}
/** Must run under the shared memory writer lock; preserve the imported registry and alias recovery plan. */
export async function saveFlashcardStudyPreferences(storage: MemoryStorage, userId: string,
  dailyNewWordLimit: number | null): Promise<FlashcardStudyPreferences> {
  validateDailyNewWordLimit(dailyNewWordLimit);
  const record = { ...await readRecord(storage, userId), dailyNewWordLimit };
  await writeRecord(storage, record);
  return preferences(record);
}

/** Adjust enrollment without deleting recall evidence; resume is also an undo for removal. */
export async function updateFlashcardWords(storage: MemoryStorage, userId: string,
  wordIds: readonly string[], action: FlashcardWordAction): Promise<FlashcardStudyPreferences> {
  if (!['pause', 'resume', 'remove'].includes(action)) throw new TypeError('请选择有效的词表操作。');
  const ids = new Set(wordIds.map(importedId));
  const record = await readRecord(storage, userId);
  const paused = new Set(record.pausedWordIds ?? []);
  const excluded = new Set(record.excludedWordIds ?? []);
  const imported = new Set(record.importedWordIds);
  for (const id of ids) {
    paused.delete(id);
    excluded.delete(id);
    if (action === 'pause') paused.add(id);
    if (action === 'remove') { excluded.add(id); imported.delete(id); }
    if (action === 'resume') imported.add(id);
  }
  const next = { ...record, importedWordIds: [...imported], pausedWordIds: [...paused], excludedWordIds: [...excluded] };
  await writeRecord(storage, next);
  return preferences(next);
}

/** Complete write-ahead registration without inventing lookup or recall evidence. */
export async function repairImportedFlashcardStates(storage: MemoryStorage, userId: string,
  now = new Date(), seedBaseline?: SeedBaseline): Promise<void> {
  if (!Number.isFinite(now.getTime())) throw new TypeError('Invalid word-list enrollment date');
  const record = await readRecord(storage, userId);
  if (!record.importedWordIds.length) return;
  const states = await storage.getBatchMemoryStates(userId, record.importedWordIds);
  const aliases = new Map(record.aliasBaselines.map(row => [row.wordId, row.legacyWordIds]));
  for (const wordId of record.importedWordIds) {
    if (states.has(wordId)) continue;
    const legacyWordIds = aliases.get(wordId) ?? [];
    if (legacyWordIds.length) {
      if (!seedBaseline) throw new Error('导入词的旧学习记录尚未合并，请重试。');
      await seedBaseline(wordId, legacyWordIds);
      if (await storage.getMemoryState(userId, wordId)) continue;
    }
    const state = initializeWordMemory(userId, wordId);
    state.nextReview = now.toISOString();
    state.fsrsCard.due = now.toISOString();
    await storage.saveMemoryState(state);
  }
}

/** Write the enrollment registry first; interrupted state creation is safely repaired at startup or retry. */
export async function importFlashcardWords(storage: MemoryStorage, userId: string, canonicalWordIds: readonly string[],
  existingCanonicalWordIds?: ReadonlyMap<string, string>, now = new Date(), seedBaseline?: SeedBaseline): Promise<FlashcardWordImportResult> {
  if (!Array.isArray(canonicalWordIds)) throw new TypeError('请选择有效的词表。');
  if (!Number.isFinite(now.getTime())) throw new TypeError('Invalid word-list enrollment date');
  const incoming = [...new Set(canonicalWordIds.map(importedId))];
  const record = await readRecord(storage, userId);
  const registered = new Set(record.importedWordIds);
  const aliases = new Map(record.aliasBaselines.map(row => [row.wordId, [...row.legacyWordIds]]));
  const incomingSet = new Set(incoming);
  for (const [legacyWordId, canonicalWordId] of existingCanonicalWordIds ?? []) {
    const canonical = importedId(canonicalWordId);
    if (incomingSet.has(canonical) && legacyWordId !== canonical) {
      aliases.set(canonical, [...new Set([...aliases.get(canonical) ?? [], legacyWordId])]);
    }
  }
  const idsToCheck = [...new Set([...incoming, ...incoming.flatMap(wordId => aliases.get(wordId) ?? [])])];
  const existing = await storage.getBatchMemoryStates(userId, idsToCheck);
  let addedCount = 0;
  for (const wordId of incoming) {
    if (!registered.has(wordId) && !existing.has(wordId) && !(aliases.get(wordId) ?? []).some(alias => existing.has(alias))) addedCount += 1;
    registered.add(wordId);
  }
  const updated: FlashcardPreferenceRecord = { ...record, importedWordIds: [...registered],
    ...(record.pausedWordIds ? { pausedWordIds: record.pausedWordIds.filter(id => !incomingSet.has(id)) } : {}),
    ...(record.excludedWordIds ? { excludedWordIds: record.excludedWordIds.filter(id => !incomingSet.has(id)) } : {}),
    aliasBaselines: [...aliases].filter(([wordId]) => registered.has(wordId)).map(([wordId, legacyWordIds]) => ({ wordId, legacyWordIds })) };
  await writeRecord(storage, updated);
  await repairImportedFlashcardStates(storage, userId, now, seedBaseline);
  return { addedCount, existingCount: incoming.length - addedCount, enrolledCount: registered.size };
}
