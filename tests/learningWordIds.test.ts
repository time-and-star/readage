import assert from 'node:assert/strict';
import test from 'node:test';
import { LearningWordIdResolver, canonicalLearningWordId } from '../src/lib/learningWordIds';
import { resolveDictionaryLearningWordIds } from '../server/dictionary/learningWordIds';
import { lookupDictionaryWords } from '../server/dictionary/service';
import { extractLearningUnits } from '../src/lib/readingExposure';
import { recordMemoryClickWithExposure, recordParagraphExposureWithRollback } from '../src/lib/memoryV2Integration';
import { projectCanonicalWordProficiency, getCanonicalLearningCollections } from '../src/lib/learningWordProficiency';
import type { WordProficiencyView } from '../src/lib/memoryV2/memorySystem';
import { createMemoryV2Adapter } from '../src/lib/memoryV2RecommendationAdapter';
import { memoryV2 } from '../src/lib/memoryV2/hooks';
import type { Article } from '../src/types';
import { seedCanonicalMemoryBaselines } from '../src/lib/canonicalMemoryBaseline';

test('a later displayed card cannot replace an already confirmed learning mapping', async () => {
  const resolver = new LearningWordIdResolver(async () => ['run']);
  assert.deepEqual(await resolver.resolve(['running']), ['run']);
  resolver.prime('running', 'running');
  assert.deepEqual(await resolver.resolve(['running']), ['run']);
});

test('nonblocking identity reads expose only settled mappings and respect eviction and clearing', async () => {
  let finish!: (value: string[]) => void;
  const resolver = new LearningWordIdResolver(() => new Promise(resolve => { finish = resolve; }), 2);
  const pending = resolver.resolve(['running']);
  assert.equal(resolver.getResolved('running'), undefined);
  resolver.prime('running', 'running');
  assert.equal(resolver.getResolved('running'), undefined);
  finish(['run']); await pending;
  assert.equal(resolver.getResolved('RUNNING'), 'run');
  resolver.prime('book', 'book'); await Promise.resolve();
  assert.equal(resolver.getResolved('running'), undefined);
  assert.equal(resolver.getResolved('book'), 'book');
  resolver.clear(); assert.equal(resolver.getResolved('book'), undefined);
});

test('passive IDs match dictionary learning identities independently of the displayed headword, preserving phrase units', async () => {
  const surfaces = ['running', 'books', 'studies', 'went', 'saw', 'over time', 'unknownzzzz'];
  const entries = await lookupDictionaryWords(surfaces);
  const ids = await resolveDictionaryLearningWordIds(surfaces);
  assert.deepEqual(ids.slice(0, 3), ['run', 'book', 'study']);
  for (let index = 0; index < 5; index += 1) {
    assert.ok(entries[index]);
    assert.equal(ids[index], entries[index]!.learningTermRef?.stableId);
  }
  assert.deepEqual(ids.slice(5), ['over time', 'unknownzzzz']);
  assert.deepEqual(ids.slice(3, 5), ['went', 'saw'], 'the full ReadAge source cannot rewrite established irregular-form learning IDs');
  assert.equal(canonicalLearningWordId('over time', 'time'), 'over time');
});

test('canonical paragraph exposure and inflected click share the rendered occurrence', async () => {
  const units = extractLearningUnits('Running alongside books and studies over time.', ['over time']);
  const canonicalWordIds = await resolveDictionaryLearningWordIds(units.map((unit) => unit.wordId));
  const exposedOccurrenceIds = new Set<string>();
  const writes: Array<{ wordId: string; occurrenceId: string; kind: string }> = [];
  await recordParagraphExposureWithRollback({ articleId: 'canonical-article', paragraphIndex: 0,
    units, canonicalWordIds, exposedOccurrenceIds,
    recordExposures: async (items) => { writes.push(...items.map((item) => ({ ...item, kind: 'exposure' }))); },
  });
  const running = units.find((unit) => unit.wordId === 'running')!;
  await recordMemoryClickWithExposure({ articleId: 'canonical-article', paragraphIndex: 0,
    unit: running, canonicalWordId: 'run', exposedOccurrenceIds,
    recordExposure: async (wordId, _articleId, occurrenceId) => { writes.push({ wordId, occurrenceId, kind: 'exposure' }); },
    recordClick: async (wordId, _articleId, occurrenceId) => { writes.push({ wordId, occurrenceId, kind: 'click' }); },
  });
  const runEvents = writes.filter((event) => event.wordId === 'run');
  assert.deepEqual(runEvents.map((event) => event.kind), ['exposure', 'click']);
  assert.equal(runEvents[0].occurrenceId, runEvents[1].occurrenceId);
  assert.ok(runEvents[0].occurrenceId.endsWith(':running'));
  assert.equal(writes.filter((event) => event.wordId === 'over time').length, 1);
  assert.equal(writes.some((event) => event.wordId === 'time'), false);
});

test('changed dwell snapshot updates the same occurrence and failure restores retry state', async () => {
  const units = [{ wordId: 'running', tokenIndex: 0, tokenLength: 1 }];
  const exposedOccurrenceIds = new Set<string>();
  const exposureSnapshots = new Map<string, string>();
  const writes: number[] = [];
  const first = { dwellTimeMs: 1_200, expectedDwellTimeMs: 3_000 };
  const later = { ...first, dwellTimeMs: 3_000 };
  const common = { articleId: 'dwell-update', paragraphIndex: 0, units, canonicalWordIds: ['run'],
    exposedOccurrenceIds, exposureSnapshots };
  await recordParagraphExposureWithRollback({ ...common, signals: first,
    recordExposures: async (items) => { writes.push(items[0].dwellTimeMs!); }, });
  await recordParagraphExposureWithRollback({ ...common, signals: first,
    recordExposures: async () => assert.fail('identical snapshots must be deduplicated'), });
  const original = [...exposureSnapshots.entries()];
  await assert.rejects(recordParagraphExposureWithRollback({ ...common, signals: later,
    recordExposures: async () => { throw new Error('disk full'); }, }), /disk full/);
  assert.deepEqual([...exposureSnapshots.entries()], original);
  assert.equal(exposedOccurrenceIds.size, 1);
  await recordParagraphExposureWithRollback({ ...common, signals: later,
    recordExposures: async (items) => { writes.push(items[0].dwellTimeMs!); }, });
  assert.deepEqual(writes, [1_200, 3_000]);
});

test('fast lookup and later threshold snapshot retain the first occurrence timestamp across midnight', async () => {
  const unit = { wordId: 'running', tokenIndex: 0, tokenLength: 1 };
  const exposedOccurrenceIds = new Set<string>();
  const occurrenceStartedAts = new Map<string, string>();
  const exposureSnapshots = new Map<string, string>();
  const timestamps: string[] = [];
  const occurrences: string[] = [];
  await recordMemoryClickWithExposure({ articleId: 'midnight-article', paragraphIndex: 0, unit,
    canonicalWordId: 'run', exposedOccurrenceIds, occurrenceStartedAts,
    signals: { exposureOccurredAt: '2026-10-03T15:59:59.000Z' },
    recordExposure: async (_wordId, _articleId, occurrenceId, signals) => {
      timestamps.push(signals!.exposureOccurredAt!); occurrences.push(occurrenceId);
    }, recordClick: async () => undefined,
  });
  await recordParagraphExposureWithRollback({ articleId: 'midnight-article', paragraphIndex: 0,
    units: [unit], canonicalWordIds: ['run'], exposedOccurrenceIds, occurrenceStartedAts, exposureSnapshots,
    signals: { exposureOccurredAt: '2026-10-03T16:00:05.000Z', dwellTimeMs: 1_200 },
    recordExposures: async (items) => {
      timestamps.push(items[0].exposureOccurredAt!); occurrences.push(items[0].occurrenceId);
    },
  });
  assert.deepEqual(timestamps, ['2026-10-03T15:59:59.000Z', '2026-10-03T15:59:59.000Z']);
  assert.equal(occurrences[0], occurrences[1]);
  assert.equal(occurrenceStartedAts.size, 1);
});

test('dictionary ID batches preserve positions, deduplicate concurrent work, and retry failures', async () => {
  let release!: (values: string[]) => void;
  const requests: string[][] = [];
  const resolver = new LearningWordIdResolver(async (words) => {
    requests.push(words);
    return new Promise<string[]>((resolve) => { release = resolve; });
  });
  const first = resolver.resolve(['Running', '', 'running', 'over time']);
  const second = resolver.resolve(['running']);
  assert.deepEqual(requests, [['running']]);
  release(['run']);
  assert.deepEqual(await first, ['run', '', 'run', 'over time']);
  assert.deepEqual(await second, ['run']);
  assert.deepEqual(await resolver.resolve(['running', 'run']), ['run', 'run']);
  assert.equal(requests.length, 1);

  let attempts = 0;
  const retrying = new LearningWordIdResolver(async (words) => {
    attempts += 1;
    if (attempts === 1) throw new Error('temporarily offline');
    return words.map(() => 'book');
  });
  await assert.rejects(retrying.resolve(['books']), /temporarily offline/);
  assert.deepEqual(await retrying.resolve(['books']), ['book']);
  assert.equal(attempts, 2);

  const sizes: number[] = [];
  const bounded = new LearningWordIdResolver(async (words) => { sizes.push(words.length); return words; });
  const words = Array.from({ length: 123 }, (_, index) => `word${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + index % 26)}`);
  assert.deepEqual(await bounded.resolve(words), words);
  assert.deepEqual(sizes, [50, 50, 23]);
});

test('legacy views stay intact while canonical projection prefers existing canonical history', () => {
  const word = (wordId: string, lastReview: string, stability: number): WordProficiencyView => ({
    wordId, lastReview, stability, memoryScore: 55, level: 2, difficulty: 5, nextReview: '2026-10-04T00:00:00Z',
  });
  const original = [word('running', '2026-10-02', 20), word('run', '2026-09-02', 8),
    word('books', '2026-09-02', 12), word('booked', '2026-10-01', 18)];
  const before = structuredClone(original);
  const map = projectCanonicalWordProficiency(original, ['run', 'run', 'book', 'book']);
  assert.equal(map.size, 2);
  assert.equal(map.get('run')!.stability, 8);
  assert.equal(map.get('book')!.stability, 18);
  assert.deepEqual(original, before);
});

test('baseline seeding finds legacy IDs once and keeps whole phrase IDs intact', async () => {
  const seeds: Array<[string, string[]]> = [];
  let scans = 0;
  const store = { userId: 'seed-user', ensureReady: async () => undefined,
    system: { getAllWordProficiency: async () => {
      scans += 1;
      return ['running', 'books', 'studies', 'over time'].map((wordId) => ({ wordId }));
    } },
    seedCanonicalWordMemory: async (wordId: string, legacyIds: string[]) => { seeds.push([wordId, legacyIds]); },
  };
  await seedCanonicalMemoryBaselines(store as Parameters<typeof seedCanonicalMemoryBaselines>[0],
    ['run', 'book', 'over time'], resolveDictionaryLearningWordIds);
  await seedCanonicalMemoryBaselines(store as Parameters<typeof seedCanonicalMemoryBaselines>[0],
    ['study'], resolveDictionaryLearningWordIds);
  assert.equal(scans, 1);
  assert.deepEqual(seeds, [['run', ['running']], ['book', ['books']], ['study', ['studies']]]);
});

test('visible legacy due queues obey the selected canonical snapshot', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => {
    const { words } = JSON.parse(String(init?.body));
    return Response.json({ ok: true, lemmas: await resolveDictionaryLearningWordIds(words) });
  }) as typeof fetch;
  const legacy: WordProficiencyView = { wordId: 'running', memoryScore: 45, level: 1,
    stability: 4, difficulty: 5, nextReview: '2020-01-01T00:00:00Z', lastReview: '2026-09-01' };
  const canonical = { ...legacy, wordId: 'run', nextReview: '2027-01-01T00:00:00Z' };
  try {
    const projected = await getCanonicalLearningCollections([legacy, canonical], [legacy], [], new Date('2026-10-03'));
    assert.equal(projected.proficiencies.length, 1);
    assert.equal(projected.proficiencies[0].wordId, 'run');
    assert.equal(projected.dueWords.length, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('local review candidates use real dictionary IDs and legacy surface history remains known', async () => {
  const originalFetch = globalThis.fetch;
  const originalSystem = memoryV2.getSystem;
  const originalUser = memoryV2.getUserId;
  globalThis.fetch = (async (url, init) => {
    assert.equal(String(url), '/api/dictionary/lemmas');
    const { words } = JSON.parse(String(init?.body));
    return Response.json({ ok: true, lemmas: await resolveDictionaryLearningWordIds(words) });
  }) as typeof fetch;
  const legacy: WordProficiencyView = { wordId: 'running', memoryScore: 45, level: 1,
    stability: 4, difficulty: 5, nextReview: '2020-01-01T00:00:00Z', lastReview: null };
  (memoryV2 as unknown as { getSystem: () => unknown }).getSystem = () => ({
    getAllWordProficiency: async () => [legacy], getDueWords: async () => [legacy],
  });
  memoryV2.getUserId = () => 'canonical-test';
  const article = (id: string, content: string): Article => ({ id, title: id, content: [content], level: 'B1',
    description: id, date: '2026-10-03', status: 'In Progress' });
  try {
    const ranked = await createMemoryV2Adapter().recommendForReview(
      [{ ...article('inflected', 'Running books studies over time'), keyWords: ['over time'] },
        article('miss', 'cloud weather')], ['run', 'over time'], 2,
    );
    assert.equal(ranked[0]?.articleId, 'inflected');
    assert.equal(ranked[0]?.dueWordsCount, 2);
    assert.equal(legacy.wordId, 'running');
  } finally {
    globalThis.fetch = originalFetch;
    memoryV2.getSystem = originalSystem;
    memoryV2.getUserId = originalUser;
  }
});
