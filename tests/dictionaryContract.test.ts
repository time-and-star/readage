import test from 'node:test';
import assert from 'node:assert/strict';
import { createDictionaryService } from '../packages/dictionary/core';
import { DICTIONARY_PROTOCOL_VERSION, type DictionaryAdapter } from '../packages/dictionary/contracts';
import { createExactLanguageAdapter, createInMemoryDictionary } from '../packages/dictionary/examples/inMemory';
import { englishLanguageAdapter } from '../packages/dictionary/languages/english';

function source(id: string, version = 'v1', language = 'en', headword = 'bank') {
  return createInMemoryDictionary({ id, contentVersion: version, language,
    entries: [{ id: `${id}:entry`, headword, definitions: [{ language: 'zh', text: id }] }] });
}

test('registration, source priority, independent senses and explicit source selection are stable v1 contracts', async () => {
  const service = createDictionaryService({ enabledSources: ['a', 'b'], sourceOrder: ['b', 'a'], defaultSource: 'b' });
  service.registerLanguage(englishLanguageAdapter);
  service.registerDictionary(source('a')); service.registerDictionary(source('b')); service.registerDictionary(source('disabled'));
  assert.throws(() => service.registerLanguage(englishLanguageAdapter), /already registered/);
  assert.throws(() => service.registerDictionary(source('a')), /already registered/);
  const result = await service.lookup({ text: 'BANK', language: 'en-US', preferredDefinitionLanguages: ['zh'] });
  assert.equal(result.protocolVersion, DICTIONARY_PROTOCOL_VERSION);
  assert.equal(result.status, 'found');
  assert.deepEqual(result.sources.map(item => item.dictionaryId), ['b', 'a']);
  assert.equal(result.sources[0].matches[0].entry.content.kind, 'structured');
  assert.equal(result.sources[1].matches[0].entry.dictionaryId, 'a');
  assert.deepEqual((await service.lookup({ text: 'bank', language: 'en', dictionaryIds: ['a'] })).sources.map(item => item.dictionaryId), ['a']);
  assert.equal((await service.lookup({ text: 'bank', language: 'en', dictionaryIds: ['disabled'] })).status, 'invalid_request');
  assert.equal((await service.lookup({ text: 'bank', language: 'en', dictionaryIds: ['missing'] })).status, 'invalid_request');
  assert.equal(service.listSources().defaultSource, 'b');
  assert.equal(service.listSources().sources.find(item => item.id === 'disabled')?.enabled, false);
});

test('version/configuration/adapter changes change the catalogue while dictionary IDs remain stable', () => {
  const adapter = source('a');
  const service = createDictionaryService(); service.registerDictionary(adapter);
  const before = service.listSources().catalogVersion;
  adapter.metadata.contentVersion = 'v2';
  assert.notEqual(service.listSources().catalogVersion, before);
  const contentChanged = service.listSources().catalogVersion;
  adapter.metadata.adapterVersion = 'adapter.v2';
  assert.notEqual(service.listSources().catalogVersion, contentChanged);
  const reordered = createDictionaryService({ enabledSources: [] }); reordered.registerDictionary(adapter);
  assert.notEqual(reordered.listSources().catalogVersion, service.listSources().catalogVersion);
});

test('no language processor preserves exact Unicode; a non-English adapter registers without core changes', async () => {
  const service = createDictionaryService();
  const word = '𠮷・かなＡ';
  service.registerDictionary(source('unicode', 'v1', 'ja', word));
  const exact = await service.lookup({ text: word, language: 'ja' });
  assert.equal(exact.status, 'found');
  assert.equal(exact.languageCapabilities.normalization, 'unsupported');
  assert.equal(exact.languageCapabilities.segmentation, 'unsupported');
  assert.equal(exact.learningTermRef?.stableId, word);
  assert.equal((await service.lookup({ text: '𠮷・かなA', language: 'ja' })).status, 'not_found');
  service.registerLanguage(createExactLanguageAdapter('ja'));
  const registered = await service.lookup({ text: word, language: 'ja' });
  assert.equal(registered.status, 'found');
  assert.equal(registered.languageCapabilities.candidates, 'supported');
  const entry = registered.sources[0].matches[0].entry;
  assert.equal(entry.language, 'ja');
  assert.equal(entry.content.kind === 'structured' && entry.content.senses[0].definitions[0].language, 'zh');
  assert.equal((await service.getEntry({ dictionaryId: 'unicode', entryId: 'unicode:entry' })).entry?.headword, word);
});

test('batch results retain duplicates, misses and failures in their original positions', async () => {
  const service = createDictionaryService(); service.registerDictionary(source('a'));
  const results = await service.lookupMany(['bank', 'miss', 'bank', ''].map(text => ({ text, language: 'en' })));
  assert.deepEqual(results.map(result => result.status), ['found', 'not_found', 'found', 'invalid_request']);
  assert.deepEqual(results.map(result => result.request.text), ['bank', 'miss', 'bank', '']);
  await assert.rejects(service.lookupMany(Array.from({ length: 51 }, () => ({ text: 'bank', language: 'en' }))), /at most 50/);
});

test('source failures remain unavailable and a surviving source can return its own entry', async () => {
  const failing: DictionaryAdapter = { ...source('failure'), getStatus: () => ({ available: false }),
    lookup: async () => { throw new Error('private filesystem path'); }, getEntry: async () => { throw new Error('disk'); } };
  const service = createDictionaryService(); service.registerDictionary(failing);
  assert.equal((await service.lookup({ text: 'bank', language: 'en' })).status, 'unavailable');
  assert.equal((await service.getEntry({ dictionaryId: 'failure', entryId: 'failure:entry' })).status, 'unavailable');
  assert.equal((await service.lookup({ text: 'bank', language: 'en', context: 42 as unknown as string })).status, 'invalid_request');
  service.registerDictionary(source('healthy'));
  const partial = await service.lookup({ text: 'bank', language: 'en' });
  assert.equal(partial.status, 'found');
  assert.deepEqual(partial.sources.map(item => item.status), ['unavailable', 'found']);
  assert.ok(!JSON.stringify(partial).includes('private filesystem'));
  assert.equal((await service.lookup({ text: 'absent', language: 'en' })).status, 'unavailable');
});

test('single, batch and detail requests cancel promptly even when an adapter ignores the signal', async () => {
  const service = createDictionaryService();
  service.registerDictionary({ ...source('slow'), lookup: () => new Promise(() => {}), getEntry: () => new Promise(() => {}) });
  const controller = new AbortController();
  const one = service.lookup({ text: 'bank', language: 'en' }, controller.signal);
  const many = service.lookupMany([{ text: 'bank', language: 'en' }], controller.signal);
  const detail = service.getEntry({ dictionaryId: 'slow', entryId: 'slow:entry' }, controller.signal);
  controller.abort();
  await Promise.all([one, many, detail].map(work => assert.rejects(work, { name: 'AbortError' })));
});
