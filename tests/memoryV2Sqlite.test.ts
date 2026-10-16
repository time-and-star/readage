import assert from 'node:assert/strict';
import test from 'node:test';
import { LOCAL_PROFILE_KEY, type LocalChange, type LocalRow, type LocalTable } from '../src/lib/localDatabaseProtocol';
import { initializeWordMemory } from '../src/lib/memoryV2/fsrsIntegration';
import type { RawWordEvent } from '../src/lib/memoryV2/types';

test('SQLite memory batches read only requested identities and preserve pending changes and event deduplication', async () => {
  const descriptors = new Map(['window', 'document', 'fetch'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const profile = { id: 'test-profile', name: 'Test', createdAt: '2026-10-09T00:00:00Z', revision: 0 };
  const tables = new Map<LocalTable, Map<string, unknown>>();
  const queries: Array<{ table: LocalTable; key?: string; keys?: string[]; prefix?: string }> = [];
  const commits: Array<{ revision: number; changes: LocalChange[] }> = [];
  let queryGate: Promise<void> | null = null;
  let onQuery: ((query: typeof queries[number]) => void) | undefined;
  const tableFor = (table: LocalTable) => {
    let rows = tables.get(table);
    if (!rows) { rows = new Map(); tables.set(table, rows); }
    return rows;
  };
  for (const [userId, wordId] of [['u', 'recognize'], ['u', 'practice'], ['u', 'unrelated'], ['other', 'recognize']]) {
    tableFor('memoryState').set(`${userId}|${wordId}`, { state: initializeWordMemory(userId, wordId) });
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    localStorage: { getItem: (key: string) => key === LOCAL_PROFILE_KEY ? profile.id : null, setItem() {} },
    addEventListener() {}, setInterval() {},
  } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { visibilityState: 'hidden' } });
  globalThis.fetch = async (input, init) => {
    const endpoint = String(input).split('/').at(-1);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
    if (endpoint === 'status') return response({ enabled: true });
    if (endpoint === 'bootstrap') return response({ profile, profiles: [profile], settings: {}, migrated: false });
    if (endpoint === 'query') {
      queries.push(body);
      if (queryGate) await queryGate;
      onQuery?.(body);
      const wanted = body.keys ? new Set<string>(body.keys) : null;
      const rows: LocalRow[] = [...tableFor(body.table)].filter(([key]) => wanted ? wanted.has(key)
        : body.key !== undefined ? key === body.key : key.startsWith(body.prefix ?? '')).map(([key, value]) => ({ key, value }));
      return response({ revision: profile.revision, rows });
    }
    if (endpoint === 'commit') {
      assert.equal(body.revision, profile.revision);
      commits.push(body);
      for (const change of body.changes as LocalChange[]) {
        if (change.deleted) tableFor(change.table).delete(change.key);
        else tableFor(change.table).set(change.key, change.value);
      }
      if (body.changes.length) profile.revision++;
      return response({ revision: profile.revision });
    }
    throw new Error(`Unexpected local database request: ${endpoint}`);
  };
  try {
    const database = await import('../src/lib/localDatabase');
    const { SqliteMemoryStorage } = await import('../src/lib/memoryV2/sqliteImpl');
    await database.initializeLocalDatabase();
    const storage = new SqliteMemoryStorage();
    const states = await storage.getBatchMemoryStates('u', ['practice', 'recognize', 'practice', 'missing']);
    assert.deepEqual([...states.keys()].sort(), ['practice', 'recognize']);
    assert.equal(states.get('recognize')?.userId, 'u');
    const stateQueries = queries.filter(query => query.table === 'memoryState');
    assert.equal(stateQueries.length, 1);
    assert.deepEqual(stateQueries[0].keys?.slice().sort(), ['u|missing', 'u|practice', 'u|recognize']);
    assert.equal(stateQueries[0].prefix, undefined);
    const beforeEmpty = queries.length;
    assert.equal((await storage.getBatchMemoryStates('u', [])).size, 0);
    assert.equal(queries.length, beforeEmpty);

    // Concurrent refreshes share transport, while their returned objects remain independent.
    let releaseQueries!: () => void;
    queryGate = new Promise<void>(resolve => { releaseQueries = resolve; });
    const beforeConcurrent = queries.length;
    const firstList = storage.getAllMemoryStates('u');
    const secondList = storage.getAllMemoryStates('u');
    const thirdList = storage.getAllMemoryStates('u');
    releaseQueries();
    const lists = await Promise.all([firstList, secondList, thirdList]);
    queryGate = null;
    assert.equal(queries.length - beforeConcurrent, 1);
    lists[0][0].stability = 999;
    assert.notEqual(lists[1][0].stability, 999);
    assert.notEqual(lists[2][0].stability, 999);
    const changed = { ...states.get('recognize')!, stability: 17 };
    tableFor('memoryState').set('u|recognize', { state: changed });
    profile.revision++;
    const fresh = await storage.getAllMemoryStates('u');
    assert.equal(queries.length - beforeConcurrent, 2);
    assert.equal(fresh.find(state => state.wordId === 'recognize')?.stability, 17);

    // Batch reads reuse exact reads and also remember absent keys inside a transaction.
    await database.withLocalDatabaseTransaction(async () => {
      await storage.getMemoryState('u', 'recognize');
      const beforeBatch = queries.length;
      await storage.getBatchMemoryStates('u', ['recognize', 'practice', 'missing']);
      assert.equal(queries.length - beforeBatch, 1);
      assert.deepEqual(queries.at(-1)?.keys, ['u|missing', 'u|practice']);
      const beforeExact = queries.length;
      assert.equal(await storage.getMemoryState('u', 'missing'), null);
      assert.ok(await storage.getMemoryState('u', 'practice'));
      assert.equal(queries.length, beforeExact);
    });

    // Large selections stay within the server's request-size limit.
    const chunkKeys = Array.from({ length: 1001 }, (_, index) => `chunk:${index}`);
    for (const key of chunkKeys) tableFor('meta').set(key, { value: key });
    const beforeChunk = queries.length;
    const chunkRows = await database.queryLocalRowsByKeys('meta', chunkKeys);
    const chunkQueries = queries.slice(beforeChunk);
    assert.equal(chunkRows.length, 1001);
    assert.equal(chunkQueries.length, 3);
    assert.deepEqual(chunkQueries.map(query => query.keys?.length), [500, 500, 1]);

    // An external update between chunks invalidates the entire read, including its first chunk.
    let externalChunks = 0;
    onQuery = query => {
      if (query.table !== 'meta' || !query.keys || ++externalChunks !== 2) return;
      tableFor('meta').set('chunk:0', { value: 'newest-read' });
      profile.revision++;
    };
    const beforeRevisionRead = queries.length;
    const consistentRows = await database.queryLocalRowsByKeys('meta', chunkKeys);
    onQuery = undefined;
    assert.equal(queries.length - beforeRevisionRead, 6);
    assert.equal(consistentRows.length, chunkKeys.length);
    assert.deepEqual(consistentRows.find(row => row.key === 'chunk:0')?.value, { value: 'newest-read' });

    // A conflict during transaction prefetch retries the whole calculation and commits only its new snapshot.
    let transactionChunks = 0, calculations = 0;
    onQuery = query => {
      if (query.table !== 'meta' || !query.keys || ++transactionChunks !== 2) return;
      tableFor('meta').set('chunk:0', { value: 'newest-transaction' });
      profile.revision++;
    };
    const beforeConflictCommit = commits.length;
    await database.withLocalDatabaseTransaction(async () => {
      calculations++;
      await database.putLocalRow('meta', 'retry-proof', { value: calculations });
      await database.prefetchLocalRowsByKeys('meta', chunkKeys);
      const current = await database.queryLocalRows('meta', 'chunk:0');
      await database.putLocalRow('meta', 'prefetched-result', current[0].value);
    });
    onQuery = undefined;
    assert.equal(calculations, 2);
    assert.equal(transactionChunks, 6);
    assert.equal(commits.length - beforeConflictCommit, 1);
    assert.deepEqual(tableFor('meta').get('retry-proof'), { value: 2 });
    assert.deepEqual(tableFor('meta').get('prefetched-result'), { value: 'newest-transaction' });

    // Reads inside a transaction include the caller's unsaved update/deletion.
    await database.withLocalDatabaseTransaction(async () => {
      const updated = { ...states.get('recognize')!, stability: 23 };
      await storage.saveMemoryState(updated);
      await database.putLocalRow('memoryState', 'u|practice', null, true);
      const pending = await storage.getBatchMemoryStates('u', ['practice', 'recognize']);
      assert.equal(pending.get('recognize')?.stability, 23);
      assert.equal(pending.has('practice'), false);
    });

    const exposure: RawWordEvent = { userId: 'u', wordId: 'recognize', articleId: 'article', occurrenceId: 'p0:w1',
      eventType: 'exposure', occurredAt: '2026-10-09T01:00:00Z', localDate: '2026-10-09', dwellTimeMs: 800 };
    const other = { ...exposure, wordId: 'unrelated', occurrenceId: 'p0:w2' };
    const beforeRawBatch = queries.length;
    await database.withLocalDatabaseTransaction(() => storage.saveRawEvents([exposure, exposure, other]));
    const rawBatchQueries = queries.slice(beforeRawBatch).filter(query => query.table === 'rawEvents');
    assert.equal(rawBatchQueries.length, 1);
    assert.deepEqual(rawBatchQueries[0].keys, ['u|recognize|2026-10-09', 'u|unrelated|2026-10-09']);
    await database.withLocalDatabaseTransaction(() => storage.saveRawEvents([
      { ...exposure, dwellTimeMs: 1800 }, { ...exposure, eventType: 'click', occurredAt: '2026-10-09T01:00:02Z' },
    ]));
    const persisted = await storage.getRawEventsByDate('u', 'recognize', exposure.localDate);
    assert.equal(persisted.length, 2);
    assert.equal(persisted.find(event => event.eventType === 'exposure')?.dwellTimeMs, 1800);
    assert.equal((await storage.getRawEventsByDate('u', 'unrelated', exposure.localDate)).length, 1);

    const beforePrefetch = queries.length;
    await storage.prefetchEventBatch([exposure]);
    assert.equal(queries.length, beforePrefetch, 'prefetch outside a transaction does not fetch or retain snapshots');

    // Exercise the real paragraph writer: batched reads must leave all derived evidence unchanged.
    const { MemorySystemV2 } = await import('../src/lib/memoryV2/memorySystem');
    const words = Array.from({ length: 12 }, (_, index) => `paragraph-word-${index}`);
    const events: RawWordEvent[] = words.map((wordId, index) => ({ ...exposure, userId: 'benchmark-fast', wordId,
      occurrenceId: `paragraph:${index}`, dwellTimeMs: 1800, expectedDwellTimeMs: 2000 }));
    events.push({ ...events[0], eventType: 'click', occurredAt: '2026-10-09T01:00:02Z' });
    const fastSystem = new MemorySystemV2(storage, undefined, 'UTC');
    const beforeFast = queries.length;
    await database.withLocalDatabaseTransaction(() => fastSystem.recordBatchEvents(events));
    const fastQueries = queries.slice(beforeFast);
    for (const table of ['memoryState', 'rawEvents', 'dailyEvidence']) {
      const tableQueries = fastQueries.filter(query => query.table === table);
      assert.equal(tableQueries.length, 1);
      assert.equal(tableQueries[0].keys?.length, words.length);
    }
    assert.ok(fastQueries.length <= words.length + 5, `paragraph needed ${fastQueries.length} requests`);

    const referenceStorage = new SqliteMemoryStorage();
    Object.defineProperty(referenceStorage, 'prefetchEventBatch', { value: undefined });
    const referenceSystem = new MemorySystemV2(referenceStorage, undefined, 'UTC');
    const beforeReference = queries.length;
    await database.withLocalDatabaseTransaction(() => referenceSystem.recordBatchEvents(events.map(event => ({ ...event, userId: 'benchmark-reference' }))));
    const referenceCount = queries.length - beforeReference;
    assert.ok(referenceCount > fastQueries.length);
    const normalizeUser = (value: unknown) => JSON.parse(JSON.stringify(value, (key, item) => key === 'userId' ? 'benchmark' : item));
    for (const word of words) {
      const [fastRaw, referenceRaw, fastDaily, referenceDaily, fastState, referenceState] = await Promise.all([
        storage.getRawEventsByDate('benchmark-fast', word, exposure.localDate),
        referenceStorage.getRawEventsByDate('benchmark-reference', word, exposure.localDate),
        storage.getDailyEvidence('benchmark-fast', word, exposure.localDate),
        referenceStorage.getDailyEvidence('benchmark-reference', word, exposure.localDate),
        storage.getMemoryState('benchmark-fast', word),
        referenceStorage.getMemoryState('benchmark-reference', word),
      ]);
      assert.deepEqual(normalizeUser(fastRaw), normalizeUser(referenceRaw));
      assert.deepEqual(normalizeUser(fastDaily), normalizeUser(referenceDaily));
      assert.deepEqual(normalizeUser(fastState), normalizeUser(referenceState));
    }
  } finally {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
