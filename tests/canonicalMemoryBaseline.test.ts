import assert from 'node:assert/strict';
import test from 'node:test';
import { seedCanonicalMemoryBaselines } from '../src/lib/canonicalMemoryBaseline';

type SeedStore = Parameters<typeof seedCanonicalMemoryBaselines>[0];
const canonicalIds = new Map([['running', 'run'], ['books', 'book'], ['studies', 'study']]);
const resolveIds = async (words: readonly string[]) => words.map(word => canonicalIds.get(word) ?? word);

test('canonical baselines reuse a shared learning snapshot and coalesce concurrent alias discovery', async () => {
  let snapshots = 0, resolutions = 0;
  const seeds: Array<[string, readonly string[]]> = [];
  const store = { userId: 'u', ensureReady: async () => {},
    getLearningSourceVersion: () => 1,
    getLearningSnapshot: async () => { snapshots++; return { proficiencies: [{ wordId: 'running' }, { wordId: 'books' }, { wordId: 'over time' }] }; },
    system: { getAllWordProficiency: async () => { throw new Error('The shared source must be reused'); } },
    seedCanonicalWordMemory: async (wordId: string, aliases: readonly string[]) => { seeds.push([wordId, aliases]); },
  } as unknown as SeedStore;
  const resolver = async (words: readonly string[]) => { resolutions++; return resolveIds(words); };
  await Promise.all([seedCanonicalMemoryBaselines(store, ['run'], resolver), seedCanonicalMemoryBaselines(store, ['book', 'over time'], resolver)]);
  await seedCanonicalMemoryBaselines(store, ['run'], resolver);
  assert.equal(snapshots, 1);
  assert.equal(resolutions, 1);
  assert.deepEqual(seeds, [['run', ['running']], ['book', ['books']]]);
});

test('external source changes rebuild canonical aliases without rescanning for ordinary word writes', async () => {
  let version = 1, snapshots = 0;
  let words = ['running'];
  const seeds: Array<[string, readonly string[]]> = [];
  const store = { userId: 'u', ensureReady: async () => {}, getLearningSourceVersion: () => version,
    getLearningSnapshot: async () => { snapshots++; return { proficiencies: words.map(wordId => ({ wordId })) }; },
    system: {}, seedCanonicalWordMemory: async (wordId: string, aliases: readonly string[]) => { seeds.push([wordId, aliases]); },
  } as unknown as SeedStore;
  await seedCanonicalMemoryBaselines(store, ['run'], resolveIds);
  await seedCanonicalMemoryBaselines(store, ['book'], resolveIds);
  assert.equal(snapshots, 1);
  version++; words = ['studies'];
  await seedCanonicalMemoryBaselines(store, ['study'], resolveIds);
  await seedCanonicalMemoryBaselines(store, ['run'], resolveIds);
  assert.equal(snapshots, 2);
  assert.deepEqual(seeds, [['run', ['running']], ['study', ['studies']]]);
});

test('a source change during identity resolution retries the alias index before seeding', async () => {
  let version = 1, snapshots = 0, resolutions = 0;
  let words = ['running'];
  let release!: () => void, resolving!: () => void;
  const captured = new Promise<void>(resolve => { resolving = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const seeds: Array<[string, readonly string[]]> = [];
  const store = { userId: 'u', ensureReady: async () => {}, getLearningSourceVersion: () => version,
    getLearningSnapshot: async () => { snapshots++; return { proficiencies: words.map(wordId => ({ wordId })) }; },
    system: {}, seedCanonicalWordMemory: async (wordId: string, aliases: readonly string[]) => { seeds.push([wordId, aliases]); },
  } as unknown as SeedStore;
  const resolver = async (ids: readonly string[]) => {
    resolutions++;
    if (resolutions === 1) { resolving(); await gate; }
    return resolveIds(ids);
  };
  const pending = seedCanonicalMemoryBaselines(store, ['study'], resolver);
  await captured;
  version++; words = ['studies'];
  release();
  await pending;
  assert.equal(snapshots, 2);
  assert.equal(resolutions, 2);
  assert.deepEqual(seeds, [['study', ['studies']]]);
});

test('a failed shared snapshot does not poison canonical baseline retries', async () => {
  let snapshots = 0, seeded = false;
  const store = { userId: 'u', ensureReady: async () => {}, getLearningSourceVersion: () => 1,
    getLearningSnapshot: async () => {
      if (++snapshots === 1) throw new Error('temporary source failure');
      return { proficiencies: [{ wordId: 'running' }] };
    },
    system: {}, seedCanonicalWordMemory: async () => { seeded = true; },
  } as unknown as SeedStore;
  await assert.rejects(seedCanonicalMemoryBaselines(store, ['run'], resolveIds), /temporary source failure/);
  await seedCanonicalMemoryBaselines(store, ['run'], resolveIds);
  assert.equal(snapshots, 2);
  assert.equal(seeded, true);
});

test('successful seeds skip repeated word reads while failures remain retryable and a restore rebuilds aliases', async () => {
  let version = 1, snapshots = 0, seeds = 0;
  const store = { userId: 'u', ensureReady: async () => {}, getLearningSourceVersion: () => version,
    getLearningSnapshot: async () => { snapshots++; return { proficiencies: [{ wordId: 'running' }] }; },
    system: {}, seedCanonicalWordMemory: async () => {
      if (++seeds === 1) throw new Error('temporary seed failure');
    },
  } as unknown as SeedStore;
  await assert.rejects(seedCanonicalMemoryBaselines(store, ['run'], resolveIds), /temporary seed failure/);
  await seedCanonicalMemoryBaselines(store, ['run'], resolveIds);
  await seedCanonicalMemoryBaselines(store, ['run', 'run'], resolveIds);
  assert.equal(seeds, 2);
  assert.equal(snapshots, 1);
  version++;
  await seedCanonicalMemoryBaselines(store, ['run'], resolveIds);
  assert.equal(seeds, 3);
  assert.equal(snapshots, 2);
});
