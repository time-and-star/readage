import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  migrateLocalStorageToIndexedDb,
  archiveMigratedLocalStorage,
  type LocalStorageMigrationState,
  type LocalStorageMigrationTarget,
} from '../src/lib/memoryV2/indexedDbImpl';
import type {
  ArticleWordEvidence,
  DailyWordEvidence,
  FinalizationTask,
  RawWordEvent,
  WordMemoryState,
} from '../src/lib/memoryV2/types';
import { initializeWordMemory, submitFsrsReview } from '../src/lib/memoryV2/fsrsIntegration';
import { aggregateArticleEvidence, aggregateDailyEvidence } from '../src/lib/memoryV2/evidenceAggregation';
import { mergeRawEvents } from '../src/lib/memoryV2/rawEventPersistence';
import { replayWordJournal, type WordJournal } from '../src/lib/browserExtension/replay';
import { hasFormalRecallEvidence } from '../src/lib/memoryV2/rmeV4Bridge';
import { createEmptyRmeProfile } from '../src/lib/memoryV4';
import { repairPassiveReadingRecall } from '../src/lib/memoryV2/passiveRecallRepair';

const MIGRATION_META_KEY = 'localStorageMigratedV1';
const MEMORY_PREFIX = 'english-ai:v2:memory';

class StorageFake implements Storage {
  private values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

class MigrationTargetFake implements LocalStorageMigrationTarget {
  meta = new Map<string, unknown>();
  raw = new Map<string, RawWordEvent[]>();
  articles = new Map<string, ArticleWordEvidence>();
  daily = new Map<string, DailyWordEvidence>();
  states = new Map<string, WordMemoryState>();
  tasks = new Map<string, FinalizationTask>();
  failStateWordId: string | null = null;

  async setMeta(key: string, value: unknown): Promise<void> {
    this.meta.set(key, value);
  }

  async getMeta<T>(key: string): Promise<T | null> {
    return (this.meta.get(key) as T | undefined) ?? null;
  }

  async saveRawEvents(events: RawWordEvent[]): Promise<void> {
    for (const event of events) {
      const key = `${event.userId}|${event.wordId}|${event.localDate}`;
      this.raw.set(key, mergeRawEvents(this.raw.get(key) ?? [], [event]));
    }
  }

  async getRawEventsByDate(userId: string, wordId: string, localDate: string) {
    return this.raw.get(`${userId}|${wordId}|${localDate}`) ?? [];
  }

  async saveArticleEvidence(evidence: ArticleWordEvidence): Promise<void> {
    this.articles.set(
      `${evidence.userId}|${evidence.wordId}|${evidence.articleId}|${evidence.localDate}`,
      evidence
    );
  }

  async getArticleEvidence(
    userId: string,
    wordId: string,
    articleId: string,
    localDate: string
  ) {
    return this.articles.get(`${userId}|${wordId}|${articleId}|${localDate}`) ?? null;
  }

  async saveDailyEvidence(evidence: DailyWordEvidence): Promise<void> {
    this.daily.set(`${evidence.userId}|${evidence.wordId}|${evidence.localDate}`, evidence);
  }

  async getDailyEvidence(userId: string, wordId: string, localDate: string) {
    return this.daily.get(`${userId}|${wordId}|${localDate}`) ?? null;
  }

  async saveMemoryState(state: WordMemoryState): Promise<void> {
    if (state.wordId === this.failStateWordId) {
      throw new Error(`failed to import ${state.wordId}`);
    }
    this.states.set(`${state.userId}|${state.wordId}`, state);
  }

  async getMemoryState(userId: string, wordId: string) {
    return this.states.get(`${userId}|${wordId}`) ?? null;
  }

  async createFinalizationTask(task: FinalizationTask): Promise<void> {
    this.tasks.set(`${task.userId}|${task.localDate}`, task);
  }

  async getPendingFinalizationTasks(userId: string) {
    return [...this.tasks.values()].filter((task) => task.userId === userId);
  }

  async getWordDailyEvidence(userId: string, wordId: string) {
    return [...this.daily.values()].filter(row => row.userId === userId && row.wordId === wordId);
  }

  async getRawEventsByDateRange(userId: string, wordId: string) {
    return [...this.raw.values()].flat().filter(row => row.userId === userId && row.wordId === wordId);
  }
}

function exposure(occurrenceId: string): RawWordEvent {
  return {
    userId: 'u1',
    wordId: 'hello',
    articleId: 'article-1',
    occurrenceId,
    eventType: 'exposure',
    occurredAt: `2026-07-24T12:00:0${occurrenceId === 'occ-1' ? '0' : '1'}.000Z`,
    localDate: '2026-07-24',
  };
}

function state(wordId: string): WordMemoryState {
  return {
    userId: 'u1',
    wordId,
    stability: 1,
    difficulty: 5,
    lastReview: null,
    nextReview: '2026-07-25T00:00:00.000Z',
    fsrsCard: {
      due: '2026-07-25T00:00:00.000Z',
      stability: 1,
      difficulty: 5,
      elapsedDays: 0,
      scheduledDays: 1,
      learningSteps: 0,
      reps: 1,
      lapses: 0,
      state: 1,
    },
    fsrsReviews: [],
  };
}

function reviewState(wordId: string, days: Array<[string, 1 | 2 | 3 | 4]>): WordMemoryState {
  let memory = initializeWordMemory('u1', wordId);
  memory.nextReview = memory.fsrsCard.due = '2026-07-23T00:00:00.000Z';
  for (const [day, rating] of days) {
    memory = submitFsrsReview(memory, rating, new Date(`${day}T12:00:00.000Z`));
    const review = memory.fsrsReviews.at(-1)!;
    review.source = 'flashcard';
    review.verificationAttemptIds = [`${wordId}:${day}`];
  }
  return memory;
}

function installSource() {
  const source = new StorageFake();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: source });
  return source;
}

function writeState(source: Storage, memory: WordMemoryState) {
  source.setItem(`${MEMORY_PREFIX}:state:${memory.userId}:${memory.wordId}`, JSON.stringify(memory));
}

const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

afterEach(() => {
  if (originalLocalStorage) {
    Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
  } else {
    Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

describe('Memory V2 localStorage to IndexedDB migration', () => {
  it('words named article, raw or daily do not change the record type', async () => {
    const source = new StorageFake();
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: source });
    for (const word of ['article', 'raw', 'daily']) {
      source.setItem(`${MEMORY_PREFIX}:state:u1:${word}`, JSON.stringify(state(word)));
      source.setItem(`${MEMORY_PREFIX}:daily:u1:${word}:2026-07-24`, JSON.stringify({ userId: 'u1', wordId: word, localDate: '2026-07-24' }));
    }
    const target = new MigrationTargetFake();
    assert.equal((await migrateLocalStorageToIndexedDb(target)).completed, true);
    assert.equal(target.states.size, 3);
    assert.equal(target.daily.size, 3);
  });
  it('only releases duplicate local data after its source archive is verified', async () => {
    const source = new StorageFake();
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: source });
    const key = `${MEMORY_PREFIX}:state:u1:article`;
    const raw = JSON.stringify(state('article'));
    source.setItem(key, raw);
    source.setItem('english-ai:v2:articles', '[]');
    const target = new MigrationTargetFake();
    await archiveMigratedLocalStorage(target, source);
    assert.equal(source.getItem(key), raw);
    await migrateLocalStorageToIndexedDb(target);
    const set = target.setMeta.bind(target);
    target.setMeta = async () => { throw new Error('disk failure'); };
    await assert.rejects(archiveMigratedLocalStorage(target, source));
    assert.equal(source.getItem(key), raw);
    target.setMeta = set;
    await archiveMigratedLocalStorage(target, source);
    assert.equal(source.getItem(key), null);
    assert.equal((target.meta.get('localStorageSourceArchiveV1') as Record<string, string>)[key], raw);
    assert.equal(source.getItem('english-ai:v2:articles'), '[]');
    assert.equal(target.states.size, 1);
  });
  it('preserves extension replay journals and their recovery index', async () => {
    const source = new StorageFake();
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: source });
    const journalKey = 'extension-journal:["u1","run"]';
    const journal = { version: 1, userId: 'u1', wordId: 'run', baselineState: null, baselineDaily: [], baselineRaw: [], events: [] };
    source.setItem(`${MEMORY_PREFIX}:meta:${journalKey}`, JSON.stringify(journal));
    source.setItem(`${MEMORY_PREFIX}:meta:extension-journal-index:u1`, '["run"]');
    const target = new MigrationTargetFake();
    const result = await migrateLocalStorageToIndexedDb(target);
    assert.equal(result.completed, true);
    assert.deepEqual(target.meta.get(journalKey), journal);
    assert.deepEqual(target.meta.get('extension-journal-index:u1'), ['run']);
  });
  it('does not mark a partial migration complete and retries failed items', async () => {
    const source = new StorageFake();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: source,
    });
    source.setItem(
      `${MEMORY_PREFIX}:raw:u1:hello:2026-07-24`,
      JSON.stringify([exposure('occ-1')])
    );
    source.setItem(`${MEMORY_PREFIX}:state:u1:first`, JSON.stringify(state('first')));
    source.setItem(`${MEMORY_PREFIX}:state:u1:second`, JSON.stringify(state('second')));

    const target = new MigrationTargetFake();
    target.failStateWordId = 'second';

    const first = await migrateLocalStorageToIndexedDb(target);
    const firstState = target.meta.get(MIGRATION_META_KEY) as LocalStorageMigrationState;

    assert.equal(first.completed, false);
    assert.equal(first.failedKeys, 1);
    assert.equal(firstState.status, 'in-progress');
    assert.equal(firstState.failedKeys, 1);
    assert.equal(target.states.has('u1|first'), true);
    assert.equal(target.states.has('u1|second'), false);
    assert.equal(target.raw.get('u1|hello|2026-07-24')?.length, 1);

    source.setItem(
      `${MEMORY_PREFIX}:raw:u1:hello:2026-07-24`,
      JSON.stringify([exposure('occ-1'), exposure('occ-2')])
    );
    target.failStateWordId = null;
    const second = await migrateLocalStorageToIndexedDb(target);
    const secondState = target.meta.get(MIGRATION_META_KEY) as LocalStorageMigrationState;

    assert.equal(second.completed, true);
    assert.equal(second.failedKeys, 0);
    assert.equal(secondState.status, 'completed');
    assert.equal(secondState.verifiedKeys, 3);
    assert.equal(target.states.has('u1|first'), true);
    assert.equal(target.states.has('u1|second'), true);
    assert.deepEqual(
      target.raw.get('u1|hello|2026-07-24')?.map((event) => event.occurrenceId),
      ['occ-1', 'occ-2']
    );
  });

  it('keeps malformed records retryable instead of claiming completion', async () => {
    const source = new StorageFake();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: source,
    });
    source.setItem(`${MEMORY_PREFIX}:state:u1:broken`, '{not json');

    const target = new MigrationTargetFake();
    const result = await migrateLocalStorageToIndexedDb(target);
    const migrationState = target.meta.get(MIGRATION_META_KEY) as LocalStorageMigrationState;

    assert.equal(result.completed, false);
    assert.equal(result.failedKeys, 1);
    assert.equal(migrationState.status, 'in-progress');
  });

  it('records legacy proficiency as requiring an explicit future migration', async () => {
    const source = new StorageFake();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: source,
    });
    source.setItem('english-ai:v2:proficiency', JSON.stringify({ hello: { level: 2 } }));

    const target = new MigrationTargetFake();
    const result = await migrateLocalStorageToIndexedDb(target);
    const migrationState = target.meta.get(MIGRATION_META_KEY) as LocalStorageMigrationState;

    assert.equal(result.completed, true);
    assert.equal(migrationState.scope, 'memory-v2-local-storage');
    assert.equal(migrationState.legacyProficiency, 'pending-explicit-migration');
  });

  it('retries when a completed marker is malformed or unverified', async () => {
    const source = new StorageFake();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: source,
    });
    source.setItem(`${MEMORY_PREFIX}:state:u1:first`, JSON.stringify(state('first')));

    const target = new MigrationTargetFake();
    target.meta.set(MIGRATION_META_KEY, {
      status: 'completed',
      verifiedKeys: 'not-a-number',
    });

    const result = await migrateLocalStorageToIndexedDb(target);
    const migrationState = target.meta.get(MIGRATION_META_KEY) as LocalStorageMigrationState;

    assert.equal(result.completed, true);
    assert.equal(target.states.has('u1|first'), true);
    assert.equal(migrationState.scope, 'memory-v2-local-storage');
    assert.equal(migrationState.verifiedKeys, 1);
  });

  it('reconciles old boolean markers through verified merging before claiming completion', async () => {
    const source = new StorageFake();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: source,
    });
    source.setItem(`${MEMORY_PREFIX}:state:u1:first`, JSON.stringify(state('first')));

    const target = new MigrationTargetFake();
    target.meta.set(MIGRATION_META_KEY, true);

    const first = await migrateLocalStorageToIndexedDb(target);
    const second = await migrateLocalStorageToIndexedDb(target);
    const migrationState = target.meta.get(MIGRATION_META_KEY) as LocalStorageMigrationState;

    assert.equal(first.completed, true);
    assert.equal(first.usable, true);
    assert.equal(second.completed, true);
    assert.equal(second.usable, true);
    assert.equal(first.importedKeys, 1);
    assert.equal(second.importedKeys, 0);
    assert.equal(target.states.size, 1);
    assert.equal(migrationState.status, 'completed');
  });

  it('migrates reading verification and flashcard settings instead of permanently falling back', async () => {
    const source = installSource();
    const journal = { version: 1, userId: 'u1', attempts: [{ attemptId: 'a1', questionId: 'q1', wordId: 'run',
      articleId: 'article', outcome: 'recognized', occurredAt: '2026-07-24T12:00:00.000Z',
      localDate: '2026-07-24', timezone: 'UTC', userId: 'u1' }] };
    const preferences = { version: 1, userId: 'u1', dailyNewWordLimit: 0, importedWordIds: ['run'],
      pausedWordIds: ['walk'], excludedWordIds: ['stop'], aliasBaselines: [{ wordId: 'run', legacyWordIds: ['running'] }] };
    source.setItem(`${MEMORY_PREFIX}:meta:reading-verification:u1`, JSON.stringify(journal));
    source.setItem(`${MEMORY_PREFIX}:meta:flashcard-study-preferences:u1`, JSON.stringify(preferences));
    const target = new MigrationTargetFake();
    assert.equal((await migrateLocalStorageToIndexedDb(target)).usable, true);
    assert.deepEqual(target.meta.get('reading-verification:u1'), journal);
    assert.deepEqual(target.meta.get('flashcard-study-preferences:u1'), preferences);
    await archiveMigratedLocalStorage(target, source);
    assert.equal(source.length, 0);
  });

  it('preserves newer settings and explicit resume actions while retaining disjoint imported words', async () => {
    const source = installSource();
    const target = new MigrationTargetFake();
    const main = { version: 1, userId: 'u1', dailyNewWordLimit: 5, importedWordIds: ['run', 'main-only'],
      pausedWordIds: [], excludedWordIds: [], aliasBaselines: [], updatedAt: '2026-07-26T00:00:00.000Z' };
    const fallback = { ...main, dailyNewWordLimit: 0, importedWordIds: ['run', 'fallback-only'],
      pausedWordIds: ['run'], updatedAt: '2026-07-25T00:00:00.000Z' };
    target.meta.set('flashcard-study-preferences:u1', main);
    source.setItem(`${MEMORY_PREFIX}:meta:flashcard-study-preferences:u1`, JSON.stringify(fallback));
    await migrateLocalStorageToIndexedDb(target);
    let merged = await target.getMeta<any>('flashcard-study-preferences:u1');
    assert.equal(merged.dailyNewWordLimit, 5);
    assert.deepEqual(merged.pausedWordIds, []);
    assert.deepEqual(merged.importedWordIds, ['run', 'main-only', 'fallback-only']);
    target.meta.set('flashcard-study-preferences:u1', { ...merged, pausedWordIds: ['run'] });
    source.setItem(`${MEMORY_PREFIX}:meta:flashcard-study-preferences:u1`, JSON.stringify({ ...fallback,
      pausedWordIds: [], updatedAt: '2026-07-27T00:00:00.000Z' }));
    await migrateLocalStorageToIndexedDb(target);
    merged = await target.getMeta<any>('flashcard-study-preferences:u1');
    assert.equal(merged.dailyNewWordLimit, 0);
    assert.deepEqual(merged.pausedWordIds, []);
    assert.deepEqual(merged.importedWordIds, ['run', 'main-only', 'fallback-only']);
  });

  it('imports new fallback learning after a completed migration and keeps independent main-library words', async () => {
    const source = installSource();
    const target = new MigrationTargetFake();
    writeState(source, state('main'));
    await migrateLocalStorageToIndexedDb(target);
    await archiveMigratedLocalStorage(target, source);
    writeState(source, state('fallback'));
    const result = await migrateLocalStorageToIndexedDb(target);
    assert.equal(result.completed, true);
    assert.equal(result.importedKeys, 1);
    assert.ok(await target.getMemoryState('u1', 'main'));
    assert.ok(await target.getMemoryState('u1', 'fallback'));
    await archiveMigratedLocalStorage(target, source);
    assert.equal(source.length, 0);
    assert.equal((await migrateLocalStorageToIndexedDb(target)).importedKeys, 0);
  });

  it('replays independent review branches and preserves the newer main-library schedule on stale-source retries', async () => {
    const source = installSource();
    const target = new MigrationTargetFake();
    const main = reviewState('run', [['2026-07-24', 3], ['2026-07-26', 3]]);
    const fallback = reviewState('run', [['2026-07-24', 3], ['2026-07-25', 1]]);
    await target.saveMemoryState(main);
    writeState(source, fallback);
    assert.equal((await migrateLocalStorageToIndexedDb(target)).completed, true);
    const merged = (await target.getMemoryState('u1', 'run'))!;
    assert.deepEqual(merged.fsrsReviews.map(review => review.review.slice(0, 10)), ['2026-07-24', '2026-07-25', '2026-07-26']);
    assert.equal(merged.lastReview, main.lastReview);
    assert.equal(merged.fsrsCard.reps, 3);
    const bytes = JSON.stringify(merged);
    assert.equal((await migrateLocalStorageToIndexedDb(target)).importedKeys, 0);
    assert.equal(JSON.stringify(await target.getMemoryState('u1', 'run')), bytes);
  });

  it('derives forced review from the combined failure history instead of either branch snapshot alone', async () => {
    const source = installSource();
    const target = new MigrationTargetFake();
    const main = { ...reviewState('run', [['2026-07-24', 1], ['2026-07-26', 1]]),
      rme: { ...createEmptyRmeProfile(), consecutiveAgain: 2, lastReviewGrade: 'Again' as const } };
    const fallback = { ...reviewState('run', [['2026-07-25', 1]]),
      rme: { ...createEmptyRmeProfile(), consecutiveAgain: 1, lastReviewGrade: 'Again' as const } };
    await target.saveMemoryState(main);
    writeState(source, fallback);
    await migrateLocalStorageToIndexedDb(target);
    const merged = (await target.getMemoryState('u1', 'run'))!;
    assert.equal(merged.fsrsReviews.length, 3);
    assert.equal(merged.rme!.consecutiveAgain, 3);
    assert.equal(merged.rme!.forcedExposure, true);
  });

  it('uses correction time to preserve the corrected RME state when the recall time stays frozen', async () => {
    const source = installSource();
    const target = new MigrationTargetFake();
    const main = { ...reviewState('run', [['2026-07-24', 3]]),
      rme: { ...createEmptyRmeProfile(), lastReviewGrade: 'Good' as const } };
    const corrected = { ...reviewState('run', [['2026-07-24', 1]]),
      rme: { ...createEmptyRmeProfile(), consecutiveAgain: 1, lastReviewGrade: 'Again' as const } };
    corrected.fsrsReviews[0].originalFlashcardRating = 3;
    corrected.fsrsReviews[0].flashcardRevisions = [{ correctionId: 'fix-1', revision: 1,
      previousRating: 3, rating: 1, correctedAt: '2026-07-25T12:00:00.000Z' }];
    await target.saveMemoryState(main);
    writeState(source, corrected);
    await migrateLocalStorageToIndexedDb(target);
    const merged = (await target.getMemoryState('u1', 'run'))!;
    assert.equal(merged.lastReview, main.lastReview);
    assert.equal(merged.fsrsReviews[0].rating, 1);
    assert.equal(merged.rme!.lastReviewGrade, 'Again');
    assert.equal(merged.rme!.consecutiveAgain, 1);
    assert.equal(merged.nextReview, corrected.nextReview);
  });

  it('preserves a partial legacy formal-recall baseline when merging independent lookup tails', async () => {
    const source = installSource();
    const target = new MigrationTargetFake();
    const baseline = reviewState('run', [['2026-07-24', 3]]);
    baseline.fsrsReviews = [];
    const main = submitFsrsReview(baseline, 1, new Date('2026-07-25T12:00:00.000Z'));
    main.fsrsReviews[0].source = 'reading_lookup';
    main.fsrsReviews[0].localDate = '2026-07-25';
    const fallback = submitFsrsReview(baseline, 1, new Date('2026-07-26T12:00:00.000Z'));
    fallback.fsrsReviews[0].source = 'reading_lookup';
    fallback.fsrsReviews[0].localDate = '2026-07-26';
    await target.saveMemoryState(main);
    writeState(source, fallback);
    await migrateLocalStorageToIndexedDb(target);
    const merged = (await target.getMemoryState('u1', 'run'))!;
    assert.equal(merged.fsrsReviews.length, 2);
    assert.equal(merged.fsrsCard.reps, 3);
    assert.equal(hasFormalRecallEvidence(merged), true);
    assert.equal(merged.fsrsCard.lapses, fallback.fsrsCard.lapses + 1);
  });

  it('keeps an opaque imported main-library card when fallback learning started from a fresh New card', async () => {
    const source = installSource();
    const target = new MigrationTargetFake();
    const baseline = reviewState('run', [['2026-07-24', 3]]);
    baseline.fsrsReviews = [];
    const fallback = reviewState('run', [['2026-07-25', 1]]);
    fallback.fsrsReviews[0].source = 'reading_lookup';
    fallback.fsrsReviews[0].localDate = '2026-07-25';
    await target.saveMemoryState(baseline);
    writeState(source, fallback);
    await migrateLocalStorageToIndexedDb(target);
    const merged = (await target.getMemoryState('u1', 'run'))!;
    const expected = submitFsrsReview(baseline, 1, new Date(fallback.lastReview!));
    assert.equal(merged.fsrsCard.reps, 2);
    assert.equal(merged.stability, expected.stability);
    assert.equal(merged.nextReview, expected.nextReview);
    assert.equal(hasFormalRecallEvidence(merged), true);
  });

  it('does not resurrect stale raw events, pending days, or tasks already finalized in the main library', async () => {
    const source = installSource();
    const target = new MigrationTargetFake();
    const event = exposure('occ-1');
    const article = aggregateArticleEvidence([event])!;
    const finalized = { ...aggregateDailyEvidence([article])!, finalizedAt: '2026-07-25T00:00:00.000Z' };
    await target.saveArticleEvidence(article);
    await target.saveDailyEvidence(finalized);
    const main = reviewState('hello', [['2026-07-24', 3], ['2026-07-26', 3]]);
    await target.saveMemoryState(main);
    writeState(source, reviewState('hello', [['2026-07-24', 3]]));
    source.setItem(`${MEMORY_PREFIX}:raw:u1:hello:2026-07-24`, JSON.stringify([event]));
    source.setItem(`${MEMORY_PREFIX}:daily:u1:hello:2026-07-24`, JSON.stringify({ ...finalized, finalizedAt: null }));
    source.setItem(`${MEMORY_PREFIX}:task:u1:2026-07-24`, JSON.stringify({ userId: 'u1', localDate: '2026-07-24',
      wordIds: ['hello'], createdAt: '2026-07-24T12:00:00.000Z' }));
    target.meta.set(MIGRATION_META_KEY, true);
    assert.equal((await migrateLocalStorageToIndexedDb(target)).completed, true);
    assert.deepEqual(await target.getRawEventsByDate('u1', 'hello', '2026-07-24'), []);
    assert.equal((await target.getDailyEvidence('u1', 'hello', '2026-07-24'))!.finalizedAt, finalized.finalizedAt);
    assert.deepEqual(await target.getPendingFinalizationTasks('u1'), []);
    assert.deepEqual(await target.getMemoryState('u1', 'hello'), main);
  });

  it('recovers data that older releases put only in the source archive once without overwriting newer recall', async () => {
    installSource();
    const target = new MigrationTargetFake();
    const newer = reviewState('run', [['2026-07-24', 3], ['2026-07-26', 3]]);
    await target.saveMemoryState(newer);
    const archived = {
      [`${MEMORY_PREFIX}:state:u1:run`]: JSON.stringify(reviewState('run', [['2026-07-24', 3]])),
      [`${MEMORY_PREFIX}:state:u1:lost`]: JSON.stringify(state('lost')),
    };
    target.meta.set('localStorageSourceArchiveV1', archived);
    assert.equal((await migrateLocalStorageToIndexedDb(target)).importedKeys, 2);
    assert.deepEqual(await target.getMemoryState('u1', 'run'), newer);
    assert.ok(await target.getMemoryState('u1', 'lost'));
    assert.equal((await target.getMeta<any>('localStorageArchiveRecoveryV2')).completed, true);
    assert.equal((await migrateLocalStorageToIndexedDb(target)).importedKeys, 0);
    assert.deepEqual(target.meta.get('localStorageSourceArchiveV1'), archived);
  });

  it('leaves failed archive recovery retryable and never deletes an unverified live source', async () => {
    const source = installSource();
    const target = new MigrationTargetFake();
    target.meta.set('localStorageSourceArchiveV1', { [`${MEMORY_PREFIX}:state:u1:lost`]: JSON.stringify(state('lost')) });
    writeState(source, state('live'));
    target.failStateWordId = 'lost';
    assert.equal((await migrateLocalStorageToIndexedDb(target)).usable, false);
    await archiveMigratedLocalStorage(target, source);
    assert.equal(source.length, 1);
    assert.equal(await target.getMeta('localStorageArchiveRecoveryV2'), null);
    target.failStateWordId = null;
    assert.equal((await migrateLocalStorageToIndexedDb(target)).usable, true);
    assert.ok(await target.getMemoryState('u1', 'lost'));
    await archiveMigratedLocalStorage(target, source);
    assert.equal(source.length, 0);
  });

  it('archives only the exact source bytes verified by the preceding migration', async () => {
    const source = installSource();
    const target = new MigrationTargetFake();
    writeState(source, state('run'));
    await migrateLocalStorageToIndexedDb(target);
    const changed = { ...state('run'), lastAssistedAt: '2026-07-27T12:00:00.000Z' };
    writeState(source, changed);
    writeState(source, state('later'));
    await archiveMigratedLocalStorage(target, source);
    assert.equal(source.length, 2);
    assert.equal(await target.getMemoryState('u1', 'later'), null);
    await migrateLocalStorageToIndexedDb(target);
    await archiveMigratedLocalStorage(target, source);
    assert.equal(source.length, 0);
    assert.equal((await target.getMemoryState('u1', 'run'))!.lastAssistedAt, changed.lastAssistedAt);
  });

  it('a failed receipt commit retains the source and retries without duplicating an already merged review', async () => {
    const source = installSource();
    const target = new MigrationTargetFake();
    const memory = reviewState('run', [['2026-07-24', 3]]);
    writeState(source, memory);
    const setMeta = target.setMeta.bind(target);
    let failReceipt = true;
    target.setMeta = async (key, value) => {
      if (key === 'localStorageMigrationReceiptV2' && failReceipt) throw new Error('receipt disk failure');
      await setMeta(key, value);
    };
    await assert.rejects(migrateLocalStorageToIndexedDb(target), /receipt disk failure/);
    await archiveMigratedLocalStorage(target, source);
    assert.equal(source.length, 1);
    failReceipt = false;
    assert.equal((await migrateLocalStorageToIndexedDb(target)).completed, true);
    assert.equal((await target.getMemoryState('u1', 'run'))!.fsrsReviews.length, 1);
    await archiveMigratedLocalStorage(target, source);
    assert.equal(source.length, 0);
  });

  it('unions existing extension journals and preserves independent main-library flashcard history on replay', async () => {
    const source = installSource();
    const target = new MigrationTargetFake();
    const main = reviewState('hello', [['2026-07-23', 3]]);
    await target.saveMemoryState(main);
    const incomingEvent = { ...exposure('occ-1'), eventType: 'click' as const };
    const journal: WordJournal = { version: 1, userId: 'u1', wordId: 'hello', baselineState: null,
      baselineDaily: [], baselineRaw: [], events: [incomingEvent] };
    source.setItem(`${MEMORY_PREFIX}:meta:extension-journal:["u1","hello"]`, JSON.stringify(journal));
    source.setItem(`${MEMORY_PREFIX}:meta:extension-journal-index:u1`, '["hello"]');
    target.meta.set('extension-journal-index:u1', ['other']);
    await migrateLocalStorageToIndexedDb(target);
    const merged = await target.getMeta<WordJournal>('extension-journal:["u1","hello"]');
    const replayed = replayWordJournal(merged!, 'UTC', new Date('2026-07-27T00:00:00.000Z'));
    assert.ok(replayed.state.fsrsReviews.some(review => review.source === 'flashcard' && review.review === main.lastReview));
    assert.deepEqual(target.meta.get('extension-journal-index:u1'), ['other', 'hello']);
    assert.ok(merged!.events.some(event => event.occurrenceId === incomingEvent.occurrenceId));
  });

  it('keeps independently recovered state reviews when an existing extension journal is replayed at startup', async () => {
    const source = installSource();
    const target = new MigrationTargetFake();
    const main = reviewState('hello', [['2026-07-23', 3]]);
    const journal: WordJournal = { version: 1, userId: 'u1', wordId: 'hello', baselineState: main,
      baselineDaily: [], baselineRaw: [], events: [{ ...exposure('occ-1'), eventType: 'click' }] };
    target.meta.set('extension-journal:["u1","hello"]', journal);
    await target.saveMemoryState(replayWordJournal(journal, 'UTC', new Date('2026-07-25T00:00:00.000Z')).state);
    writeState(source, reviewState('hello', [['2026-07-26', 3]]));
    await migrateLocalStorageToIndexedDb(target);
    const recovered = (await target.getMeta<WordJournal>('extension-journal:["u1","hello"]'))!;
    const replayed = replayWordJournal(recovered, 'UTC', new Date('2026-07-27T00:00:00.000Z'));
    assert.deepEqual(replayed.state.fsrsReviews.filter(review => review.source === 'flashcard').map(review => review.review.slice(0, 10)),
      ['2026-07-23', '2026-07-26']);
    assert.equal(replayed.state.lastReview, '2026-07-26T12:00:00.000Z');
  });

  it('repairs automatic reading Good after its evidence is imported and keeps genuine ratings and journal replay', async () => {
    const source = installSource();
    const target = new MigrationTargetFake();
    const event = exposure('occ-1');
    const day = { ...aggregateDailyEvidence([aggregateArticleEvidence([event])!])!,
      finalizedAt: '2026-07-25T00:00:00.000Z' };
    const passive = reviewState('hello', [['2026-07-24', 3]]);
    delete passive.fsrsReviews[0].source;
    delete passive.fsrsReviews[0].verificationAttemptIds;
    const stale = submitFsrsReview(passive, 1, new Date('2026-07-26T12:00:00.000Z'));
    const genuine = stale.fsrsReviews.at(-1)!;
    genuine.source = 'flashcard';
    genuine.verificationAttemptIds = ['card:real'];
    genuine.originalFlashcardRating = 3;
    genuine.flashcardRevisions = [{ correctionId: 'fix:real', revision: 1, previousRating: 3,
      rating: 1, correctedAt: '2026-07-26T12:01:00.000Z' }];
    writeState(source, stale);
    source.setItem(`${MEMORY_PREFIX}:daily:u1:hello:2026-07-24`, JSON.stringify(day));
    const journal: WordJournal = { version: 1, userId: 'u1', wordId: 'hello', baselineState: passive,
      baselineDaily: [], baselineRaw: [], events: [] };
    source.setItem(`${MEMORY_PREFIX}:meta:extension-journal:["u1","hello"]`, JSON.stringify(journal));

    assert.equal((await migrateLocalStorageToIndexedDb(target)).completed, true);
    const repaired = (await target.getMemoryState('u1', 'hello'))!;
    const expected = reviewState('hello', [['2026-07-26', 1]]);
    assert.deepEqual(repaired.fsrsCard, expected.fsrsCard);
    assert.equal(repaired.fsrsReviews.length, 1);
    assert.deepEqual(repaired.fsrsReviews[0].verificationAttemptIds, ['card:real']);
    assert.deepEqual(repaired.fsrsReviews[0].flashcardRevisions, genuine.flashcardRevisions);
    assert.deepEqual(repaired.passiveReadingReviews, passive.fsrsReviews);
    assert.deepEqual(await target.getDailyEvidence('u1', 'hello', day.localDate), day);
    const recovered = (await target.getMeta<WordJournal>('extension-journal:["u1","hello"]'))!;
    const replayed = replayWordJournal(recovered, 'UTC', new Date('2026-07-27T00:00:00.000Z'));
    assert.deepEqual(replayed.state.fsrsCard, expected.fsrsCard);
    assert.equal(replayed.state.passiveReadingReviews?.length, 1);
    assert.equal((await migrateLocalStorageToIndexedDb(target)).importedKeys, 0);
    assert.deepEqual(await target.getMemoryState('u1', 'hello'), repaired);
  });

  it('uses the retained exclusion audit to prevent a stale source from restoring automatic Good without day evidence', async () => {
    const source = installSource();
    const target = new MigrationTargetFake();
    const event = exposure('occ-1');
    const day = aggregateDailyEvidence([aggregateArticleEvidence([event])!])!;
    const stale = reviewState('hello', [['2026-07-24', 3], ['2026-07-26', 3]]);
    delete stale.fsrsReviews[0].source;
    delete stale.fsrsReviews[0].verificationAttemptIds;
    const repaired = repairPassiveReadingRecall(stale, [day], 'UTC', new Date('2026-07-27T00:00:00.000Z'));
    await target.saveMemoryState(repaired);
    writeState(source, stale);
    assert.equal((await migrateLocalStorageToIndexedDb(target)).completed, true);
    const merged = (await target.getMemoryState('u1', 'hello'))!;
    assert.deepEqual(merged.fsrsCard, repaired.fsrsCard);
    assert.deepEqual(merged.fsrsReviews, repaired.fsrsReviews);
    assert.deepEqual(merged.passiveReadingReviews, repaired.passiveReadingReviews);
    assert.equal(hasFormalRecallEvidence(merged), true);
    assert.equal((await target.getWordDailyEvidence('u1', 'hello')).length, 0);
  });

  it('repairs a migrated passive-only card using recovered raw exposure evidence', async () => {
    const source = installSource();
    const target = new MigrationTargetFake();
    const passive = reviewState('hello', [['2026-07-24', 3]]);
    delete passive.fsrsReviews[0].source;
    delete passive.fsrsReviews[0].verificationAttemptIds;
    writeState(source, passive);
    source.setItem(`${MEMORY_PREFIX}:raw:u1:hello:2026-07-24`, JSON.stringify([exposure('occ-1')]));
    assert.equal((await migrateLocalStorageToIndexedDb(target)).completed, true);
    const repaired = (await target.getMemoryState('u1', 'hello'))!;
    assert.equal(repaired.fsrsReviews.length, 0);
    assert.equal(repaired.fsrsCard.reps, 0);
    assert.equal(repaired.lastReview, null);
    assert.equal(hasFormalRecallEvidence(repaired), false);
    assert.deepEqual(repaired.passiveReadingReviews, passive.fsrsReviews);
    assert.equal((await target.getRawEventsByDate('u1', 'hello', '2026-07-24')).length, 1);
  });

  it('merges a newer measured exposure snapshot without duplicating its original encounter on retry', async () => {
    const source = installSource();
    const target = new MigrationTargetFake();
    const prior = { ...exposure('occ-1'), dwellTimeMs: 1_000, expectedDwellTimeMs: 1_000, rmeIsValid: true, rmeQuality: 1 };
    await target.saveRawEvents([prior]);
    source.setItem(`${MEMORY_PREFIX}:raw:u1:hello:2026-07-24`, JSON.stringify([{ ...prior, dwellTimeMs: 2_000 }]));
    await migrateLocalStorageToIndexedDb(target);
    await migrateLocalStorageToIndexedDb(target);
    const events = await target.getRawEventsByDate('u1', 'hello', '2026-07-24');
    assert.equal(events.length, 1);
    assert.equal(events[0].dwellTimeMs, 2_000);
    assert.equal((await target.getDailyEvidence('u1', 'hello', '2026-07-24'))!.validExposureCount, 1);
  });

  it('restores the larger measured snapshot consistently in raw, daily evidence, and the RME profile', async () => {
    const source = installSource();
    const target = new MigrationTargetFake();
    const prior = { ...exposure('occ-1'), dwellTimeMs: 1_000, expectedDwellTimeMs: 2_000, rmeIsValid: true, rmeQuality: 0.5 };
    const incoming = { ...prior, dwellTimeMs: 2_000, rmeQuality: 1 };
    const profile = (event: typeof prior) => ({ ...createEmptyRmeProfile(), lastExposureAt: event.occurredAt,
      successfulExposureCount: event.rmeQuality >= 0.8 ? 1 : 0,
      exposureHistory: [{ articleId: event.articleId, occurrenceId: event.occurrenceId, occurredAt: event.occurredAt,
        localDate: event.localDate, kind: 'natural' as const, isValid: true, quality: event.rmeQuality,
        dwellTimeMs: event.dwellTimeMs, expectedDwellTimeMs: event.expectedDwellTimeMs }] });
    await target.saveMemoryState({ ...state('hello'), rme: profile(prior) });
    await target.saveRawEvents([prior]);
    const article = aggregateArticleEvidence([prior])!;
    await target.saveArticleEvidence(article);
    await target.saveDailyEvidence(aggregateDailyEvidence([article])!);
    writeState(source, { ...state('hello'), rme: profile(incoming) });
    source.setItem(`${MEMORY_PREFIX}:raw:u1:hello:2026-07-24`, JSON.stringify([incoming]));
    await migrateLocalStorageToIndexedDb(target);
    assert.equal((await target.getMemoryState('u1', 'hello'))!.rme!.exposureHistory.length, 1);
    assert.equal((await target.getMemoryState('u1', 'hello'))!.rme!.exposureHistory[0].quality, 1);
    assert.equal((await target.getMemoryState('u1', 'hello'))!.rme!.successfulExposureCount, 1);
    assert.equal((await target.getDailyEvidence('u1', 'hello', '2026-07-24'))!.averageRmeQuality, 1);
    assert.equal((await target.getRawEventsByDate('u1', 'hello', '2026-07-24'))[0].dwellTimeMs, 2_000);
  });

  it('keeps corrected flashcard attempts when an older source contains their original rating', async () => {
    const source = installSource();
    const target = new MigrationTargetFake();
    const original = { attemptId: 'flash-a1', questionId: 'q1', wordId: 'run', articleId: 'flashcard:run',
      outcome: 'recognized', purpose: 'flashcard_review', rating: 3, occurredAt: '2026-07-24T12:00:00.000Z',
      localDate: '2026-07-24', timezone: 'UTC', userId: 'u1' };
    const corrected = { ...original, rating: 1, outcome: 'incorrect', originalFlashcardRating: 3,
      flashcardRevisions: [{ correctionId: 'fix-1', revision: 1, previousRating: 3, rating: 1,
        correctedAt: '2026-07-24T12:01:00.000Z' }] };
    target.meta.set('reading-verification:u1', { version: 1, userId: 'u1', attempts: [corrected] });
    source.setItem(`${MEMORY_PREFIX}:meta:reading-verification:u1`, JSON.stringify({ version: 1, userId: 'u1', attempts: [original] }));
    assert.equal((await migrateLocalStorageToIndexedDb(target)).completed, true);
    assert.deepEqual((await target.getMeta<any>('reading-verification:u1')).attempts, [corrected]);
  });

  it('refuses conflicting corrections at the same revision and preserves the original source for recovery', async () => {
    const source = installSource();
    const target = new MigrationTargetFake();
    const original = { attemptId: 'flash-a1', questionId: 'q1', wordId: 'run', articleId: 'flashcard:run',
      outcome: 'recognized', purpose: 'flashcard_review', rating: 3, occurredAt: '2026-07-24T12:00:00.000Z',
      localDate: '2026-07-24', timezone: 'UTC', userId: 'u1' };
    target.meta.set('reading-verification:u1', { version: 1, userId: 'u1', attempts: [original] });
    const bytes = JSON.stringify({ version: 1, userId: 'u1', attempts: [{ ...original, rating: 1, outcome: 'incorrect' }] });
    source.setItem(`${MEMORY_PREFIX}:meta:reading-verification:u1`, bytes);
    assert.equal((await migrateLocalStorageToIndexedDb(target)).usable, false);
    await archiveMigratedLocalStorage(target, source);
    assert.equal(source.getItem(`${MEMORY_PREFIX}:meta:reading-verification:u1`), bytes);
  });

  it('does not prefer a longer correction audit whose ancestry conflicts with the main-library branch', async () => {
    const source = installSource();
    const target = new MigrationTargetFake();
    const original = { attemptId: 'flash-a1', questionId: 'q1', wordId: 'run', articleId: 'flashcard:run',
      outcome: 'recognized', purpose: 'flashcard_review', rating: 3, occurredAt: '2026-07-24T12:00:00.000Z',
      localDate: '2026-07-24', timezone: 'UTC', userId: 'u1', originalFlashcardRating: 3 };
    const current = { ...original, outcome: 'incorrect', rating: 1,
      flashcardRevisions: [{ correctionId: 'main-fix', revision: 1, previousRating: 3, rating: 1,
        correctedAt: '2026-07-24T12:01:00.000Z' }] };
    const incoming = { ...original, flashcardRevisions: [
      { correctionId: 'fallback-fix-1', revision: 1, previousRating: 3, rating: 2, correctedAt: '2026-07-24T12:01:00.000Z' },
      { correctionId: 'fallback-fix-2', revision: 2, previousRating: 2, rating: 3, correctedAt: '2026-07-24T12:02:00.000Z' },
    ] };
    target.meta.set('reading-verification:u1', { version: 1, userId: 'u1', attempts: [current] });
    source.setItem(`${MEMORY_PREFIX}:meta:reading-verification:u1`, JSON.stringify({ version: 1, userId: 'u1', attempts: [incoming] }));
    assert.equal((await migrateLocalStorageToIndexedDb(target)).completed, false);
    assert.deepEqual((await target.getMeta<any>('reading-verification:u1')).attempts, [current]);
    await archiveMigratedLocalStorage(target, source);
    assert.equal(source.length, 1);
  });
});
