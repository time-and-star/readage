import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  readFlashcardStudyPreferences, saveFlashcardAutoSpeakCount, saveFlashcardDesiredRetention,
  saveFlashcardStudyPreferences, validateFlashcardDesiredRetention,
} from '../src/lib/flashcardPreferences';
import { getFlashcardPlanSettingsKey } from '../src/lib/flashcardSessionSettings';
import type { MemoryStorage } from '../src/lib/memoryV2/storage';

const key = 'flashcard-study-preferences:u';
function setup(record?: unknown) {
  const values = new Map<string, unknown>(record ? [[key, structuredClone(record)]] : []);
  const storage = {
    async getMeta<T>(name: string): Promise<T | null> { return structuredClone(values.get(name) as T ?? null); },
    async setMeta(name: string, value: unknown) { values.set(name, structuredClone(value)); },
    async saveMemoryState() { assert.fail('Saving a preference must not reschedule a word.'); },
  } as unknown as MemoryStorage;
  return { storage, values };
}

test('retention accepts all integer percentages from 80 through 97 and rejects invalid targets before writing', async () => {
  const { storage, values } = setup();
  for (let percent = 80; percent <= 97; percent += 1) {
    const value = percent / 100;
    assert.doesNotThrow(() => validateFlashcardDesiredRetention(value));
    assert.equal((await saveFlashcardDesiredRetention(storage, 'u', value)).desiredRetention, value);
  }
  const before = structuredClone(values.get(key));
  for (const value of [-1, 0, 0.79, 0.98, 1, 90, 0.905, NaN, Infinity, undefined, null, '0.9']) {
    assert.throws(() => validateFlashcardDesiredRetention(value as number), /80% 到 97%/);
    await assert.rejects(saveFlashcardDesiredRetention(storage, 'u', value as number), /80% 到 97%/);
    assert.deepEqual(values.get(key), before);
  }
});

test('legacy and corrupt targets remain absent so consumers retain the 90 percent baseline', async () => {
  const baseline = { version: 1, userId: 'u', dailyNewWordLimit: 10, importedWordIds: ['run'], aliasBaselines: [] };
  for (const desiredRetention of [undefined, 0.5, 0.999, 0.901, '0.95', null]) {
    const { storage } = setup({ ...baseline, desiredRetention });
    const preferences = await readFlashcardStudyPreferences(storage, 'u');
    assert.equal(preferences.desiredRetention, undefined);
    assert.equal(preferences.desiredRetention ?? 0.9, 0.9);
    assert.deepEqual(preferences.importedWordIds, ['run']);
  }
});

test('retention roundtrips per user while preserving enrollment, aliases, speech and later daily changes', async () => {
  const baseline = {
    version: 1, userId: 'u', dailyNewWordLimit: null, autoSpeakCount: 2,
    importedWordIds: ['run'], pausedWordIds: ['run'], excludedWordIds: ['removed'],
    aliasBaselines: [{ wordId: 'run', legacyWordIds: ['running'] }],
  };
  const { storage, values } = setup(baseline);
  const saved = await saveFlashcardDesiredRetention(storage, 'u', 0.95);
  assert.deepEqual(saved, {
    dailyNewWordLimit: null, autoSpeakCount: 2, desiredRetention: 0.95,
    importedWordIds: ['run'], pausedWordIds: ['run'], excludedWordIds: ['removed'],
  });
  assert.deepEqual(await readFlashcardStudyPreferences(storage, 'u'), saved);
  assert.equal((await readFlashcardStudyPreferences(storage, 'other')).desiredRetention, undefined);
  const stored = values.get(key) as typeof baseline & { updatedAt: string };
  assert.deepEqual(stored.aliasBaselines, baseline.aliasBaselines);
  assert.ok(Number.isFinite(Date.parse(stored.updatedAt)));
  await saveFlashcardStudyPreferences(storage, 'u', 0);
  const speechSaved = await saveFlashcardAutoSpeakCount(storage, 'u', 3);
  assert.equal(speechSaved.desiredRetention, 0.95);
  assert.equal(speechSaved.dailyNewWordLimit, 0);
  assert.deepEqual(speechSaved.importedWordIds, ['run']);
});

test('failed and silently dropped preference writes report failure and can be retried', async () => {
  const { storage } = setup();
  await saveFlashcardDesiredRetention(storage, 'u', 0.9);
  const write = storage.setMeta!.bind(storage);
  storage.setMeta = async () => { throw new Error('storage unavailable'); };
  await assert.rejects(saveFlashcardDesiredRetention(storage, 'u', 0.95), /storage unavailable/);
  assert.equal((await readFlashcardStudyPreferences(storage, 'u')).desiredRetention, 0.9);
  storage.setMeta = async () => {};
  await assert.rejects(saveFlashcardDesiredRetention(storage, 'u', 0.95), /尚未完整保存/);
  storage.setMeta = write;
  assert.equal((await saveFlashcardDesiredRetention(storage, 'u', 0.95)).desiredRetention, 0.95);
});

test('interval preview refresh detects a new target but treats an explicit legacy default as unchanged', () => {
  const preferences = { dailyNewWordLimit: 10, importedWordIds: ['run', 'jump'] };
  const baseline = getFlashcardPlanSettingsKey(preferences);
  assert.equal(getFlashcardPlanSettingsKey({ ...preferences, desiredRetention: 0.9 }), baseline);
  assert.equal(getFlashcardPlanSettingsKey({ ...preferences, importedWordIds: ['jump', 'run'] }), baseline);
  assert.notEqual(getFlashcardPlanSettingsKey({ ...preferences, desiredRetention: 0.95 }), baseline);
});
