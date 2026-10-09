import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createDictionaryRuntime } from '../server/dictionary/runtime';
import { toEnglishDictionaryEntry } from '../server/dictionary/compatibility';
import { buildDictionaryExplanation } from '../server/dictionary/service';
import { createInMemoryDictionary } from '../packages/dictionary/examples/inMemory';
import { toDictionarySourceWordCard, toDictionaryWordCard } from '../src/lib/dictionaryClient';
import { getCompactWordCard } from '../src/lib/compactWordCard';
import { DictionarySourceSections } from '../src/components/DictionarySourceSections';
import { DictionarySourceIssues } from '../src/components/DictionarySourceIssues';
import { fetchWordCard, createWordCardRequest } from '../src/lib/wordCard';
import { dictionaryCacheKey } from '../packages/dictionary/cache';
import { dictionaryCatalogCache } from '../src/lib/dictionaryCatalog';

function runtime(options: Parameters<typeof createDictionaryRuntime>[0] = {}) {
  return createDictionaryRuntime({ manifestPath: 'data/dictionary/revisions/manifest.json', additionalDictionaries: [createInMemoryDictionary({ id: 'public-demo', language: 'en', contentVersion: 'v1',
    entries: [{ id: 'bank-public', headword: 'bank', definitions: [{ language: 'en', text: 'external dictionary definition, kept separate' }] }] })],
    sourceOrder: ['native-reviewed', 'ecdict', 'public-demo'], ...options });
}

test('the old English lookup preserves every found source in configured order and keeps legacy fields', async () => {
  const app = runtime();
  const entry = toEnglishDictionaryEntry(await app.service.lookup({ text: 'bank', language: 'en' }))!;
  assert.deepEqual(entry.dictionarySources.map(source => source.dictionaryRef.dictionaryId), ['native-reviewed', 'ecdict', 'public-demo']);
  assert.equal(entry.dictionaryRef.dictionaryId, 'native-reviewed');
  assert.equal(entry.learningTermRef!.stableId, 'bank');
  assert.ok(entry.phonetic, 'the old primary fields can still carry explicitly sourced supplementation');
  assert.equal(entry.dictionarySources[0].record.phonetic, '', 'each source view retains its own raw data');
  assert.equal(entry.dictionarySources[2].record.partOfSpeechGroups[0].senses[0].definitionEn, 'external dictionary definition, kept separate');
  assert.deepEqual(toDictionaryWordCard(entry).dictionarySources, entry.dictionarySources);
  assert.deepEqual(buildDictionaryExplanation('bank', entry).dictionarySources, entry.dictionarySources);
  for (const source of entry.dictionarySources) assert.equal(source.dictionaryRef.fieldSources.senses.dictionaryId, source.dictionaryRef.dictionaryId);
});

test('all source sections render together with separate labels, definitions and unique accessible IDs', async () => {
  const entry = toEnglishDictionaryEntry(await runtime().service.lookup({ text: 'bank', language: 'en' }))!;
  const html = renderToStaticMarkup(React.createElement(DictionarySourceSections, { sources: entry.dictionarySources }));
  assert.ok(html.indexOf('ReadAge 自编词典') < html.indexOf('ECDICT 内置词典'));
  assert.ok(html.indexOf('ECDICT 内置词典') < html.indexOf('public-demo'));
  assert.ok(html.includes('银行'));
  assert.ok(html.includes('external dictionary definition, kept separate'));
  assert.equal([...html.matchAll(/<details open=""/g)].length, 3, 'all sources initially show their definitions and can be folded separately');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  const previews = entry.dictionarySources.map(source => getCompactWordCard(toDictionarySourceWordCard(source), 'bank'));
  assert.ok(previews[0].meaningZh?.includes('银行'));
  assert.equal(previews[2].meaningZh, undefined, 'a Chinese meaning cannot leak from the old dictionary into an external source');
  assert.equal(previews[2].definitionEn, 'external dictionary definition, kept separate');
});

test('a failed source is named alongside healthy entries and remains retryable without a partial cache', async () => {
  const failed = createInMemoryDictionary({ id: 'failed-source', language: 'en', contentVersion: 'v1', entries: [] });
  failed.metadata.name = '测试词典';
  failed.lookup = async () => { throw new Error('unreadable pack'); };
  const app = createDictionaryRuntime({ additionalDictionaries: [failed], enabledSources: ['native-reviewed', 'failed-source'],
    sourceOrder: ['native-reviewed', 'ecdict', 'failed-source'] });
  const entry = toEnglishDictionaryEntry(await app.service.lookup({ text: 'bank', language: 'en' }))!;
  assert.equal(entry.dictionarySources.length, 1);
  assert.equal(entry.dictionarySourceIssues?.[0].dictionaryName, '测试词典');
  assert.deepEqual(toDictionaryWordCard(entry).dictionarySourceIssues, entry.dictionarySourceIssues);
  assert.deepEqual(buildDictionaryExplanation('bank', entry).dictionarySourceIssues, entry.dictionarySourceIssues);
  const html = renderToStaticMarkup(React.createElement(DictionarySourceIssues, { issues: entry.dictionarySourceIssues, onRetry() {} }));
  assert.ok(html.includes('测试词典'));
  assert.ok(html.includes('重试词典'));

  const originalFetch = globalThis.fetch;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map<string, string>(); let lookups = 0;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  } });
  globalThis.fetch = (async url => {
    if (String(url).endsWith('/v1/sources')) return new Response(JSON.stringify({ ok: true, catalog: app.service.listSources() }));
    lookups++; return new Response(JSON.stringify({ ok: true, results: [entry] }));
  }) as typeof fetch;
  try {
    await fetchWordCard(createWordCardRequest('bank')!);
    await fetchWordCard(createWordCardRequest('bank')!);
    assert.equal(lookups, 2, 'a retry must query the failed source again');
    assert.ok(![...values.keys()].some(key => key.startsWith('english-ai:v6:word-card:')));
  } finally {
    globalThis.fetch = originalFetch;
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('an enabled dictionary miss is explained separately from an outage and remains cacheable', async () => {
  const app = createDictionaryRuntime();
  const entry = toEnglishDictionaryEntry(await app.service.lookup({ text: 'C', language: 'en' }))!;
  assert.deepEqual(entry.dictionarySourceMisses, [{ dictionaryId: 'native-reviewed', dictionaryName: 'ReadAge 自编词典' }]);
  assert.equal(entry.dictionarySourceIssues, undefined);
  assert.deepEqual(toDictionaryWordCard(entry).dictionarySourceMisses, entry.dictionarySourceMisses);
  assert.deepEqual(buildDictionaryExplanation('C', entry).dictionarySourceMisses, entry.dictionarySourceMisses);
  const html = renderToStaticMarkup(React.createElement(DictionarySourceIssues, { misses: entry.dictionarySourceMisses, onRetry() {} }));
  assert.match(html, /ReadAge 自编词典未收录此词/);
  assert.doesNotMatch(html, /暂时无法读取|重试词典/);
  const see = toEnglishDictionaryEntry(await app.service.lookup({ text: 'see', language: 'en' }))!;
  assert.ok(see.dictionarySources.some(source => source.dictionaryRef.dictionaryId === 'native-reviewed'));
  assert.equal(see.dictionarySourceMisses, undefined);
  const disabled = createDictionaryRuntime({ enabledSources: ['ecdict'], defaultSource: 'ecdict' });
  assert.equal(toEnglishDictionaryEntry(await disabled.service.lookup({ text: 'C', language: 'en' }))!.dictionarySourceMisses, undefined);

  const originalFetch = globalThis.fetch;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map<string, string>(); let lookups = 0;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  } });
  globalThis.fetch = (async () => { lookups++; return new Response(JSON.stringify({ ok: true, results: [entry] })); }) as typeof fetch;
  try {
    await dictionaryCatalogCache.applyCatalog(app.service.listSources(), false);
    const request = createWordCardRequest('C')!;
    await fetchWordCard(request);
    const cached = await fetchWordCard(request);
    assert.equal(lookups, 1, 'a confirmed miss does not need retries or disable offline caching');
    assert.deepEqual(cached.dictionarySourceMisses, entry.dictionarySourceMisses);
  } finally {
    globalThis.fetch = originalFetch;
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('disabled, missing and explicitly selected sources do not add unrelated sections or change learning identity', async () => {
  const app = runtime({ enabledSources: ['native-reviewed', 'public-demo'] });
  const all = toEnglishDictionaryEntry(await app.service.lookup({ text: 'bank', language: 'en' }))!;
  assert.deepEqual(all.dictionarySources.map(source => source.dictionaryRef.dictionaryId), ['native-reviewed', 'public-demo']);
  const one = toEnglishDictionaryEntry(await app.service.lookup({ text: 'bank', language: 'en', dictionaryIds: ['public-demo'] }))!;
  assert.equal(one.dictionarySources.length, 1);
  assert.equal(one.learningTermRef!.stableId, all.learningTermRef!.stableId);
  const missing = toEnglishDictionaryEntry(await app.service.lookup({ text: 'serendipity', language: 'en' }));
  assert.equal(missing, null);
  const externalFirst = runtime({ sourceOrder: ['public-demo', 'native-reviewed', 'ecdict'], defaultSource: 'public-demo' });
  const changed = toEnglishDictionaryEntry(await externalFirst.service.lookup({ text: 'bank', language: 'en' }))!;
  assert.equal(changed.dictionarySources[0].dictionaryRef.dictionaryId, 'public-demo');
  assert.equal(changed.learningTermRef!.stableId, all.learningTermRef!.stableId);
});

test('original dictionary HTML remains independent content without invented editorial senses', async () => {
  const imported = createInMemoryDictionary({ id: 'mdx-example', language: 'en', contentVersion: 'v1', entries: [] });
  const original = { dictionaryId: 'mdx-example', entryId: 'bank-html', headword: 'bank', language: 'en',
    contentVersion: 'v1', schemaVersion: 'dictionary-entry.v1', readings: [], provenance: [{ kind: 'imported', label: 'MDX 示例' }],
    content: { kind: 'original' as const, mediaType: 'text/html', content: '<p><b>bank</b> 自己导入的词典释义</p><script>unsafe()</script>' },
    extensions: { 'readage.originalPlainText.v1': { language: 'en', text: 'bank 自己导入的词典释义' } } };
  imported.metadata.capabilities.originalContent = 'supported';
  imported.lookup = async () => [{ entry: original, matchKind: 'exact' }];
  const app = createDictionaryRuntime({ additionalDictionaries: [imported], enabledSources: ['mdx-example'],
    sourceOrder: ['mdx-example', 'native-reviewed', 'ecdict'], defaultSource: 'mdx-example' });
  const entry = toEnglishDictionaryEntry(await app.service.lookup({ text: 'bank', language: 'en' }))!;
  assert.equal(entry.definitionEn, 'bank 自己导入的词典释义');
  assert.equal(entry.partOfSpeechGroups.length, 0);
  assert.equal(entry.dictionarySources.length, 1);
  assert.equal(entry.learningTermRef?.stableId, 'bank');
  const preview = getCompactWordCard(toDictionarySourceWordCard(entry.dictionarySources[0]), 'bank');
  assert.equal(preview.originalText, 'bank 自己导入的词典释义');
  assert.equal(preview.partOfSpeech, undefined);
  const html = renderToStaticMarkup(React.createElement(DictionarySourceSections, { sources: entry.dictionarySources }));
  assert.ok(html.includes('<b>bank</b>'));
  assert.ok(html.includes('自己导入的词典释义'));
  assert.ok(!html.includes('unsafe()'));
});

test('single-source display caches are replaced, and the full ordered source list remains available offline', async () => {
  const entry = toEnglishDictionaryEntry(await runtime().service.lookup({ text: 'bank', language: 'en' }))!;
  const catalog = { protocolVersion: 'dictionary-api.v1', catalogVersion: entry.dictionaryRef.catalogVersion, defaultSource: 'native-reviewed', sources: [] };
  const originalFetch = globalThis.fetch;
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map<string, string>();
  const oldKey = 'english-ai:v5:word-card:' + dictionaryCacheKey('en', catalog.catalogVersion, 'bank').replace('dictionary-cache.v2', 'dictionary-cache.v1');
  values.set(oldKey, JSON.stringify({ source: 'dictionary', definition: 'old single source cache', wordOrPhrase: 'bank' }));
  let lookups = 0;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  } });
  globalThis.fetch = (async url => {
    if (String(url).endsWith('/v1/sources')) return new Response(JSON.stringify({ ok: true, catalog }));
    lookups++; return new Response(JSON.stringify({ ok: true, results: [entry] }));
  }) as typeof fetch;
  try {
    const card = await fetchWordCard(createWordCardRequest('bank')!);
    assert.equal(lookups, 1);
    assert.equal(card.dictionarySources!.length, 3);
    globalThis.fetch = (async () => { throw new Error('offline'); }) as typeof fetch;
    assert.deepEqual((await fetchWordCard(createWordCardRequest('bank')!)).dictionarySources, card.dictionarySources);
    assert.ok(values.has(oldKey), 'learning and other existing data are not deleted by a display upgrade');
  } finally {
    globalThis.fetch = originalFetch;
    if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
