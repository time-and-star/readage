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
      this.raw.set(key, [...(this.raw.get(key) ?? []), event]);
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

  it('does not reinterpret the old boolean marker as verified completion', async () => {
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

    assert.equal(first.completed, false);
    assert.equal(first.usable, true);
    assert.equal(second.completed, false);
    assert.equal(second.usable, true);
    assert.equal(target.states.size, 0);
    assert.equal(migrationState.status, 'legacy-unverified');
  });
});
