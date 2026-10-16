import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDictionaryRuntime } from '../server/dictionary/runtime';
import { toEnglishDictionaryEntry } from '../server/dictionary/compatibility';
import { NativeReviewedAdapter } from '../packages/dictionary/server/nativeReviewed';
import { initializeWordMemory, submitFsrsReview } from '../src/lib/memoryV2/fsrsIntegration';
import { replayWordJournal, type WordJournal } from '../src/lib/browserExtension/replay';
import { createExactLanguageAdapter, createInMemoryDictionary } from '../packages/dictionary/examples/inMemory';

test('the application service exposes registration for an additional language and source', async () => {
  const runtime = createDictionaryRuntime();
  runtime.service.registerLanguage(createExactLanguageAdapter('fr'));
  runtime.service.registerDictionary(createInMemoryDictionary({ id: 'extra-french', language: 'fr', contentVersion: 'v1',
    entries: [{ id: 'french-1', headword: 'été', definitions: [{ language: 'zh', text: '夏天' }] }] }));
  const result = await runtime.service.lookup({ text: 'été', language: 'fr' });
  assert.equal(result.status, 'found');
  assert.equal(result.sources[0].dictionaryId, 'extra-french');
});

test('the complete authored source works with the old source disabled or missing and remains independent', async () => {
  for (const enabledSources of [['native-reviewed'], ['native-reviewed', 'ecdict']]) {
    const runtime = createDictionaryRuntime({ enabledSources, dataDir: path.resolve('data/no-such-dictionary-directory') });
    const result = await runtime.service.lookup({ text: 'bank', language: 'en' });
    const entry = toEnglishDictionaryEntry(result)!;
    assert.equal(result.status, 'found');
    assert.equal(runtime.native.count, 17974);
    assert.equal(runtime.native.metadata.entryCount, 17974);
    assert.equal(entry.dictionaryRef.dictionaryId, 'native-reviewed');
    assert.ok(entry.phonetic, 'the complete ReadAge source supplies its own pronunciation');
    assert.ok(entry.dictionarySources[0].readageContent?.senses.some(sense => sense.titleZh === '银行'));
    assert.equal(entry.learningTermRef?.stableId, 'bank');
    if (enabledSources.includes('ecdict')) assert.equal(result.sources.find(item => item.dictionaryId === 'ecdict')?.status, 'unavailable');
    assert.equal((await runtime.service.getEntry({ dictionaryId: 'native-reviewed', entryId: 'bank' })).status, 'found');
  }
});

test('a native-only term is indexed directly; pending editorial records are excluded and versioned', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'readage-dictionary-test-'));
  try {
    const revisionFile = path.join(directory, 'reviewed.jsonl');
    const manifestPath = path.join(directory, 'manifest.json');
    const seed = JSON.parse(fs.readFileSync('data/dictionary/revisions/curated-50.jsonl', 'utf8').split(/\r?\n/)[0]);
    seed.lemma = seed.query = 'nativeonlyzz';
    const pending = structuredClone(seed); pending.lemma = pending.query = 'pendingonlyzz'; pending.edit.reviewStatus = 'needs-review';
    fs.writeFileSync(revisionFile, [seed, pending].map(item => JSON.stringify(item)).join('\n'));
    fs.writeFileSync(manifestPath, JSON.stringify({ format: 'dictionary-revisions.v1', contentVersion: 'native-test.v1', revisionFile,
      batches: [{ status: 'reviewing', revisionFile: 'should-never-be-read.jsonl' }] }));
    const options = { enabledSources: ['native-reviewed'], dataDir: path.join(directory, 'missing-pack'), revisionFile, manifestPath };
    const runtime = createDictionaryRuntime(options);
    assert.equal(runtime.native.count, 1);
    assert.equal(runtime.native.metadata.entryCount, 1, 'coverage reflects the installed reviewed records');
    const found = await runtime.service.lookup({ text: 'nativeonlyzz', language: 'en' });
    assert.equal(found.status, 'found');
    assert.equal(found.learningTermRef?.stableId, 'nativeonlyzz');
    assert.equal((await runtime.service.lookup({ text: 'pendingonlyzz', language: 'en' })).status, 'not_found');
    const before = runtime.service.listSources().catalogVersion;
    seed.partOfSpeechGroups[0].senses[0].definitionEn = 'changed reviewed definition';
    fs.writeFileSync(revisionFile, JSON.stringify(seed));
    assert.equal(runtime.service.listSources().catalogVersion, before, 'running configuration/data are a startup snapshot');
    assert.notEqual(createDictionaryRuntime(options).service.listSources().catalogVersion, before);
    fs.writeFileSync(revisionFile, 'invalid json');
    const failed = new NativeReviewedAdapter({ revisionFile, manifestPath });
    assert.equal(failed.metadata.entryCount, undefined, 'an unreadable source cannot claim an installed entry count');
    await assert.rejects(failed.lookup({ text: 'nativeonlyzz', language: 'en', candidates: [{ text: 'nativeonlyzz', kind: 'exact' }] }));
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('readage-dictionary-test-'));
    fs.rmSync(directory, { recursive: true });
  }
});

test('display source switches leave English identities fixed and supplementation retains field provenance', async () => {
  // This fixture deliberately has no native pronunciation, to exercise supplementation.
  const fixture = { manifestPath: path.resolve('data/dictionary/revisions/manifest.json') };
  const nativeFirst = createDictionaryRuntime(fixture);
  const legacyFirst = createDictionaryRuntime({ ...fixture, sourceOrder: ['ecdict', 'native-reviewed'], defaultSource: 'ecdict' });
  const surfaces = ['running', 'books', 'studies', 'saw', 'went', 'over time'];
  const left = await nativeFirst.resolveLearningTerms(surfaces);
  const right = await legacyFirst.resolveLearningTerms(surfaces);
  assert.deepEqual(left, right);
  assert.deepEqual(left.slice(0, 3).map(ref => ref.stableId), ['run', 'book', 'study']);
  const curated = toEnglishDictionaryEntry(await nativeFirst.service.lookup({ text: 'running', language: 'en' }))!;
  const pack = toEnglishDictionaryEntry(await legacyFirst.service.lookup({ text: 'running', language: 'en' }))!;
  assert.equal(curated.dictionaryRef.dictionaryId, 'native-reviewed');
  assert.equal(pack.dictionaryRef.dictionaryId, 'ecdict');
  assert.equal(curated.learningTermRef?.stableId, pack.learningTermRef?.stableId);
  assert.equal(curated.dictionaryRef.fieldSources.senses.dictionaryId, 'native-reviewed');
  assert.equal(curated.dictionaryRef.fieldSources.phonetic.dictionaryId, 'ecdict');
  assert.ok(curated.phonetic);
  assert.ok(curated.partOfSpeechGroups.flatMap(group => group.senses).some(sense => sense.definitionZh?.includes('经营')));
  const raw = (await nativeFirst.service.getEntry({ dictionaryId: 'native-reviewed', entryId: 'run' })).entry!;
  assert.deepEqual(raw.readings, [], 'compatibility supplements never mutate the independent native source');

  const wordId = curated.learningTermRef!.stableId;
  const initial = initializeWordMemory('test-user', wordId);
  initial.nextReview = initial.fsrsCard.due = '2026-09-01T12:00:00.000Z';
  const reviewed = submitFsrsReview(initial, 'Good', new Date('2026-09-01T12:00:00Z'));
  const journal: WordJournal = { version: 1, userId: 'test-user', wordId, baselineState: reviewed, baselineDaily: [], baselineRaw: [],
    events: [{ userId: 'test-user', wordId, articleId: 'same-article', occurrenceId: 'same-occurrence',
      eventType: 'exposure', occurredAt: '2026-10-06T01:00:00Z', localDate: '2026-10-06' }] };
  const before = structuredClone(journal);
  const after = replayWordJournal(journal, 'UTC', new Date('2026-10-06T02:00:00Z'));
  const duplicated = replayWordJournal({ ...journal, events: [...journal.events, { ...journal.events[0], wordId: pack.learningTermRef!.stableId }] },
    'UTC', new Date('2026-10-06T02:00:00Z'));
  assert.deepEqual(duplicated, after, 'changing display source cannot duplicate an occurrence or review');
  assert.deepEqual(journal, before, 'existing learning storage is not rewritten');
  assert.deepEqual(after.state.fsrsReviews, reviewed.fsrsReviews, 'existing review state survives source changes');
});
