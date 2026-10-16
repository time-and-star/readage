import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createNativeDictionaryService, createNativeDictionaryIdentityResolver, lookupNativeDictionary, reconcileNativeDictionarySettings, readNativeDictionarySettings, toNativeDictionaryEntry,
  toNativeEnglishCard, toNativeEnglishRecord,
  type NativeDictionaryPlugin, type NativeDictionaryStatus,
} from '../src/lib/platform/nativeDictionary';
import { DICTIONARY_ENTRY_SCHEMA_VERSION, DICTIONARY_PROTOCOL_VERSION, type AdapterMatch, type DictionaryEntry, type DictionaryMetadata } from '../packages/dictionary/contracts';
import type { DictionarySettings } from '../src/lib/dictionarySettingsClient';

const ids = ['native-reviewed', 'ecdict', 'wordnet-3.1', 'wiktionary-fr', 'wiktionary-fr-zh', 'wiktionary-ja-zh'];
const version = 'fixture-2026.10';
function metadata(id: string, language = 'en', definitions = ['en', 'zh']): DictionaryMetadata {
  return { id, name: `Fixture ${id}`, entryCount: 7, description: `isolated ${language} fixture`, languages: [language], definitionLanguages: definitions,
    contentVersion: version, schemaVersion: DICTIONARY_ENTRY_SCHEMA_VERSION, adapterVersion: `${id}.fixture.v1`,
    capabilities: { lookup: true, details: true, resources: 'unsupported', originalContent: 'unsupported' },
    provenance: [{ kind: id.startsWith('wiktionary') ? 'Wiktionary' : 'fixture', label: `Original ${id}`, detail: 'https://fixture.invalid/source', status: 'confirmed' }] };
}
function status(sources: DictionaryMetadata[] = ids.map(id => metadata(id, id.includes('-fr') ? 'fr' : id.includes('-ja') ? 'ja' : 'en'))): NativeDictionaryStatus {
  return { available: true, sources: sources.map(item => ({ id: item.id, name: item.name, entryCount: item.entryCount!, contentVersion: item.contentVersion, available: true, metadata: item })) };
}
function selection(sourceOrder = ids, enabledSources = sourceOrder, defaultSource = enabledSources[0]): DictionarySettings {
  return { version: 'dictionary-settings.v1', revision: 'isolated-fixture-revision', sourceOrder: [...sourceOrder], enabledSources: [...enabledSources], defaultSource };
}
function entry(dictionaryId: string, language = 'en', headword = 'bank', partOfSpeech = 'noun'): DictionaryEntry {
  return { dictionaryId, entryId: `${language}:${headword}:original-id`, language, headword, contentVersion: version, schemaVersion: DICTIONARY_ENTRY_SCHEMA_VERSION,
    provenance: [{ kind: 'fixture-source', label: `Original ${dictionaryId}`, detail: 'https://fixture.invalid/entry', status: 'confirmed' }],
    readings: [{ text: language === 'ja' ? 'ねこ' : '/bæŋk/', language, notation: language === 'ja' ? 'kana' : 'IPA', label: 'original reading' }],
    forms: [{ text: `${headword}-plural`, label: 'original plural' }], levels: [{ system: 'CEFR', value: 'B1' }],
    content: { kind: 'structured', senses: [
      { id: 'sense:2', partOfSpeech, definitions: [{ language: language === 'fr' ? 'zh' : 'en', text: language === 'fr' ? '马。' : 'a financial institution' }],
        translations: [{ language: 'zh', text: '银行' }], labels: ['formal'], provenance: [{ kind: 'sense-provenance', status: 'confirmed' }],
        examples: [{ id: 'example:exact-id', text: { language, text: 'An original example.' }, translations: [{ language: 'zh-Hans', text: '原例句。' }], provenance: [{ kind: 'example-source', label: 'Example provenance' }] }] },
      { id: 'sense:1', partOfSpeech, definitions: [{ language: 'en', text: 'the edge of a river' }], translations: [{ language: 'zh', text: '河岸' }], examples: [] },
    ] }, extensions: { 'fixture.unknown': { preserved: ['original order', 2] } } };
}
type LookupOptions = Parameters<NativeDictionaryPlugin['lookupSource']>[0];
function plugin(fixtureStatus: NativeDictionaryStatus, lookupSource: NativeDictionaryPlugin['lookupSource'], getEntry?: NativeDictionaryPlugin['getEntry']): NativeDictionaryPlugin {
  return { status: async () => fixtureStatus,
    lookupSource,
    lookupLemmas: async () => { throw new Error('This fixture must not resolve learning identities.'); },
    lookupWords: async () => { throw new Error('Canonical/foreign lookups must not use the English compatibility path.'); },
    getEntry: getEntry ?? (async () => ({ status: fixtureStatus })) };
}

test('Android discovers six source metadata without replacing canonical languages, versions, counts or user order', async () => {
  const fixtureStatus = status();
  const ordered = ['wiktionary-ja-zh', 'wiktionary-fr-zh', 'native-reviewed', 'ecdict', 'wordnet-3.1', 'wiktionary-fr'];
  const core = await createNativeDictionaryService(fixtureStatus, selection(ordered, ['native-reviewed', 'wiktionary-ja-zh'], 'wiktionary-ja-zh'), plugin(fixtureStatus, async () => ({ matches: [] })));
  const catalog = core.listSources();
  assert.equal(catalog.protocolVersion, DICTIONARY_PROTOCOL_VERSION);
  assert.equal(catalog.defaultSource, 'wiktionary-ja-zh');
  assert.deepEqual(catalog.sources.map(source => source.id), ordered);
  for (const [index, source] of catalog.sources.entries()) {
    const { priority, enabled, available, ...publicMetadata } = source;
    assert.equal(priority, index); assert.equal(available, true); assert.equal(enabled, ['native-reviewed', 'wiktionary-ja-zh'].includes(source.id));
    assert.deepEqual(publicMetadata, fixtureStatus.sources.find(item => item.id === source.id)!.metadata);
  }
});

test('foreign lookups use registered normalization and retain every canonical field in lookup and details', async () => {
  const fixtureStatus = status();
  const french = entry('wiktionary-fr', 'fr', 'école');
  const japanese = entry('wiktionary-ja-zh', 'ja', '猫');
  const calls: LookupOptions[] = [];
  const mock = plugin(fixtureStatus, async options => {
    calls.push(options);
    const found = options.dictionaryId === french.dictionaryId ? french : options.dictionaryId === japanese.dictionaryId ? japanese : undefined;
    return { matches: found ? [{ entry: found, matchKind: 'normalized' }] : [] };
  }, async options => ({ status: fixtureStatus, entry: { dictionaryId: options.dictionaryId, contentVersion: version, entry: options.dictionaryId === french.dictionaryId ? french : japanese } }));
  const core = await createNativeDictionaryService(fixtureStatus, selection(), mock);
  for (const [text, expected] of [['L’ÉCOLE', french], ['猫', japanese]] as const) {
    const result = await core.lookup({ text, language: expected.language, dictionaryIds: [expected.dictionaryId], preferredDefinitionLanguages: ['zh'] });
    assert.equal(result.status, 'found'); assert.equal(result.languageCapabilities.normalization, 'supported');
    assert.equal(result.languageCapabilities.candidates, 'supported');
    assert.deepEqual(result.sources[0].matches[0].entry, expected);
    const detail = await core.getEntry({ dictionaryId: expected.dictionaryId, entryId: expected.entryId });
    assert.equal(detail.status, 'found'); assert.deepEqual(detail.entry, expected);
    assert.equal(detail.catalogVersion, result.catalogVersion);
  }
  assert.deepEqual(calls[0].candidates.map(candidate => candidate.text), ["l'école", 'école']);
  assert.equal(calls[0].exactOnly, false); assert.equal(calls[1].exactOnly, false);
  assert.deepEqual(calls[1].candidates.map(candidate => candidate.text), ['猫']);
});

test('Chinese French source uses disabled English edition for verified morphology regardless of registration order', async () => {
  const fr = metadata('wiktionary-fr', 'fr', ['en']);
  const zh = metadata('wiktionary-fr-zh', 'fr', ['zh']);
  const fixtureStatus = status([zh, fr]);
  const englishHorse = entry(fr.id, 'fr', 'cheval');
  const chineseHorse = entry(zh.id, 'fr', 'cheval');
  const calls: LookupOptions[] = [];
  const mock = plugin(fixtureStatus, async options => {
    calls.push(options);
    if (options.dictionaryId === fr.id) return { matches: [{ entry: englishHorse, matchKind: 'inflection' }] };
    return { matches: options.candidates.some(candidate => candidate.text === 'cheval') ? [{ entry: chineseHorse, matchKind: 'exact' }] : [] };
  });
  const core = await createNativeDictionaryService(fixtureStatus, selection([zh.id, fr.id], [zh.id]), mock);
  const result = await core.lookup({ text: 'chevaux', language: 'fr', dictionaryIds: [zh.id] });
  assert.equal(result.status, 'found'); assert.deepEqual(result.sources.map(source => source.dictionaryId), [zh.id]);
  const match = result.sources[0].matches[0]; assert.equal(match.matchKind, 'inflection');
  assert.equal(match.entry.dictionaryId, zh.id); assert.equal(match.entry.entryId, chineseHorse.entryId);
  assert.deepEqual(match.entry.content, chineseHorse.content); assert.deepEqual(match.entry.readings, chineseHorse.readings);
  assert.deepEqual(match.entry.provenance.slice(0, -1), chineseHorse.provenance);
  assert.deepEqual(match.entry.provenance.at(-1), { kind: 'morphology', label: '词形：英文维基词典', detail: 'https://fixture.invalid/source', status: 'confirmed' });
  assert.deepEqual(match.entry.extensions?.['dictionary.morphology'], { dictionaryId: fr.id, dictionaryName: fr.name,
    contentVersion: version, adapterVersion: fr.adapterVersion, surface: 'chevaux', headword: 'cheval', partOfSpeech: ['noun'] });
  assert.deepEqual(match.entry.extensions?.['fixture.unknown'], chineseHorse.extensions?.['fixture.unknown']);
  assert.deepEqual(calls.map(call => call.dictionaryId), [zh.id, fr.id, zh.id]);
  assert.equal((await core.lookup({ text: 'chevaux', language: 'fr', dictionaryIds: [fr.id] })).status, 'invalid_request');
});

test('French fallback rejects unverified headwords, non-French matches and incompatible part of speech', async () => {
  const fixtureStatus = status([metadata('wiktionary-fr-zh', 'fr'), metadata('wiktionary-fr', 'fr')]);
  for (const dependency of [
    { entry: entry('wiktionary-fr', 'fr', 'cheval'), matchKind: 'exact' },
    { entry: entry('wiktionary-fr', 'en', 'cheval'), matchKind: 'inflection' },
    { entry: entry('wiktionary-fr', 'fr', 'cheval'), matchKind: 'inflection' },
  ] satisfies AdapterMatch[]) {
    const core = await createNativeDictionaryService(fixtureStatus, selection(['wiktionary-fr-zh', 'wiktionary-fr'], ['wiktionary-fr-zh']), plugin(fixtureStatus, async options => {
      if (options.dictionaryId === 'wiktionary-fr') return { matches: [dependency] };
      return { matches: options.candidates.some(candidate => candidate.text === 'cheval') ? [{ entry: entry('wiktionary-fr-zh', 'fr', 'cheval', 'verb'), matchKind: 'exact' }] : [] };
    }));
    const result = await core.lookup({ text: 'chevaux', language: 'fr' });
    assert.equal(result.status, 'not_found'); assert.deepEqual(result.sources[0].matches, []);
  }
});

test('direct Chinese lookup skips dependency; unavailable morphology produces source unavailable rather than guessed content', async () => {
  const fixtureStatus = status([metadata('wiktionary-fr-zh', 'fr'), metadata('wiktionary-fr', 'fr')]);
  fixtureStatus.sources[1].available = false;
  let calls = 0;
  const core = await createNativeDictionaryService(fixtureStatus, selection(['wiktionary-fr-zh', 'wiktionary-fr'], ['wiktionary-fr-zh']), plugin(fixtureStatus, async options => {
    calls++;
    return { matches: options.candidates.some(candidate => candidate.text === 'cheval') ? [{ entry: entry('wiktionary-fr-zh', 'fr', 'cheval'), matchKind: 'exact' }] : [] };
  }));
  assert.equal((await core.lookup({ text: 'cheval', language: 'fr' })).status, 'found'); assert.equal(calls, 1);
  const unknown = await core.lookup({ text: 'chevaux', language: 'fr' });
  assert.equal(unknown.status, 'unavailable'); assert.equal(unknown.sources[0].status, 'unavailable');
  assert.deepEqual(unknown.sources[0].matches, []);
});

test('generic canonical WordNet can open English compatibility card without an English record extension', async () => {
  const fixtureStatus = status([metadata('wordnet-3.1')]);
  const canonical = entry('wordnet-3.1');
  const core = await createNativeDictionaryService(fixtureStatus, selection(['wordnet-3.1']), plugin(fixtureStatus, async () => ({ matches: [{ entry: canonical, matchKind: 'exact' }] })));
  const result = await core.lookup({ text: 'BANK', language: 'en' });
  const record = toNativeEnglishRecord(canonical); assert.ok(record);
  assert.equal(record.lemma, 'bank'); assert.equal(record.phonetic, '/bæŋk/'); assert.equal(record.cefrLevel, 'B1');
  assert.deepEqual(record.partOfSpeechGroups.flatMap(group => group.senses.map(sense => sense.id)), ['sense:2', 'sense:1']);
  assert.equal(record.partOfSpeechGroups[0].senses[0].examples[0].id, 'example:exact-id');
  assert.equal(record.partOfSpeechGroups[0].senses[0].examples[0].zh, '原例句。');
  const card = toNativeEnglishCard(result); assert.ok(card);
  assert.equal(card.query, 'BANK'); assert.equal(card.lemma, 'bank');
  assert.equal((card.dictionaryRef as { entryId: string }).entryId, canonical.entryId);
  const sources = card.dictionarySources as Array<{ record: unknown; dictionaryRef: { dictionaryId: string; entryId: string } }>;
  assert.equal(sources.length, 1); assert.deepEqual(sources[0].record, record);
  assert.equal(sources[0].dictionaryRef.dictionaryId, 'wordnet-3.1'); assert.equal(sources[0].dictionaryRef.entryId, canonical.entryId);
  assert.equal(toNativeEnglishRecord(entry('wiktionary-fr', 'fr')), null);
});

test('legacy two-source status still uses local English lookup and morphology without canonical plugin calls', async () => {
  const fixtureStatus: NativeDictionaryStatus = { available: true, sources: ['native-reviewed', 'ecdict'].map(id => ({ id, name: id, available: true, entryCount: 2, contentVersion: version })) };
  const requested: string[] = [];
  const mock: NativeDictionaryPlugin = {
    ...plugin(fixtureStatus, async () => { throw new Error('Legacy source must not request the canonical API.'); }),
    lookupWords: async ({ words }) => {
      requested.push(...words);
      return { status: fixtureStatus, results: words.map(query => ({ query, sources: [{ dictionaryId: 'ecdict', contentVersion: version,
        record: { word: 'study', phonetic: 'ˈstʌdi', definition: 'v. to learn', translation: 'v. 学习', pos: 'v', tag: 'cet4', exchange: 's:studies/d:studied' } }] })) };
    },
  };
  const core = await createNativeDictionaryService(fixtureStatus, selection(['native-reviewed', 'ecdict'], ['ecdict']), mock);
  const result = await core.lookup({ text: 'studies', language: 'en' });
  assert.equal(result.status, 'found'); assert.deepEqual(result.sources.map(source => source.dictionaryId), ['ecdict']);
  assert.equal(result.sources[0].matches[0].matchKind, 'inflection'); assert.equal(result.sources[0].matches[0].entry.headword, 'study');
  assert.deepEqual(requested, ['studies']);
  assert.equal((toNativeEnglishCard(result) as { lemma: string }).lemma, 'study');
});

test('cancellation rejects promptly while native lookup is pending and a late callback is not accepted', async () => {
  const fixtureStatus = status([metadata('wiktionary-ja-zh', 'ja')]);
  let finish!: (value: { matches: AdapterMatch[] }) => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const core = await createNativeDictionaryService(fixtureStatus, selection(['wiktionary-ja-zh']), plugin(fixtureStatus, () => {
    started(); return new Promise(resolve => { finish = resolve; });
  }));
  const controller = new AbortController();
  const pending = core.lookup({ text: '猫', language: 'ja' }, controller.signal);
  await ready; controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
  finish({ matches: [{ entry: entry('wiktionary-ja-zh', 'ja', '猫'), matchKind: 'exact' }] });
});

test('native entry wrapper rejects incompatible source or version and details reports unavailable safely', async () => {
  const fixtureStatus = status([metadata('wordnet-3.1')]);
  const canonical = entry('wordnet-3.1');
  assert.throws(() => toNativeDictionaryEntry({ dictionaryId: 'ecdict', contentVersion: version, entry: canonical }, 'bank'), /版本无效/);
  assert.throws(() => toNativeDictionaryEntry({ dictionaryId: canonical.dictionaryId, contentVersion: 'wrong-version', entry: canonical }, 'bank'), /版本无效/);
  const core = await createNativeDictionaryService(fixtureStatus, selection(['wordnet-3.1']), plugin(fixtureStatus, async () => ({ matches: [] }), async () => ({ status: fixtureStatus,
    entry: { dictionaryId: 'wordnet-3.1', contentVersion: 'wrong-version', entry: canonical } })));
  const result = await core.getEntry({ dictionaryId: 'wordnet-3.1', entryId: canonical.entryId });
  assert.equal(result.status, 'unavailable'); assert.equal(result.entry, null); assert.equal(result.error?.code, 'SOURCE_UNAVAILABLE');
});

test('source reconciliation keeps unchanged disabled preferences and adds new installed sources disabled', () => {
  const previous = selection(['ecdict', 'native-reviewed'], ['ecdict']);
  assert.equal(reconcileNativeDictionarySettings(previous, ['native-reviewed', 'ecdict']), previous);
  const updated = reconcileNativeDictionarySettings(previous, ids);
  assert.deepEqual(updated.enabledSources, ['ecdict']);
  assert.deepEqual(updated.sourceOrder, ['ecdict', 'native-reviewed', 'wordnet-3.1', 'wiktionary-fr', 'wiktionary-fr-zh', 'wiktionary-ja-zh']);
  assert.equal(updated.defaultSource, 'ecdict'); assert.notEqual(updated.revision, previous.revision);
  assert.deepEqual(previous.sourceOrder, ['ecdict', 'native-reviewed']);
});

test('source reconciliation removes missing IDs, repairs removed default and initializes new installation', () => {
  const previous = selection(['wiktionary-fr', 'ecdict', 'native-reviewed'], ['wiktionary-fr', 'ecdict'], 'wiktionary-fr');
  const updated = reconcileNativeDictionarySettings(previous, ['native-reviewed', 'ecdict', 'wiktionary-ja-zh']);
  assert.deepEqual(updated.sourceOrder, ['ecdict', 'native-reviewed', 'wiktionary-ja-zh']);
  assert.deepEqual(updated.enabledSources, ['ecdict']); assert.equal(updated.defaultSource, 'ecdict');
  const noneRemain = reconcileNativeDictionarySettings(selection(['gone'], ['gone']), ['ecdict', 'native-reviewed']);
  assert.deepEqual(noneRemain.enabledSources, ['ecdict']); assert.equal(noneRemain.defaultSource, 'ecdict');
  const initial = reconcileNativeDictionarySettings(undefined, ids);
  assert.deepEqual(initial.enabledSources, ids); assert.deepEqual(initial.sourceOrder, ids); assert.equal(initial.defaultSource, 'native-reviewed');
  const duplicate = reconcileNativeDictionarySettings({ ...previous, enabledSources: ['ecdict', 'ecdict'] }, ids);
  assert.deepEqual(duplicate.enabledSources, ids);
});

test('unreadable native settings remain distinguishable until explicit repair and preserve disabled sources', () => {
  assert.equal(readNativeDictionarySettings(null,ids).warning,undefined);
  for(const raw of ['{broken',JSON.stringify({version:'wrong'}),JSON.stringify({version:'dictionary-settings.v1',sourceOrder:ids,enabledSources:[],defaultSource:ids[0],revision:'old'})]) {
    const snapshot=readNativeDictionarySettings(raw,ids);
    assert.match(snapshot.warning!,/修复/);assert.match(snapshot.settings.revision,/^unreadable:/);
    assert.equal(raw.includes('unreadable'),false,'reading an invalid setting must not mutate its saved bytes');
  }
  const previous=selection(['ecdict','native-reviewed'],['ecdict']);
  const reconciled=readNativeDictionarySettings(JSON.stringify(previous),ids);
  assert.match(reconciled.warning!,/修复/);assert.deepEqual(reconciled.settings.enabledSources,['ecdict']);
  const repaired=readNativeDictionarySettings(JSON.stringify(reconciled.settings),ids);
  assert.equal(repaired.warning,undefined);assert.deepEqual(repaired.settings.enabledSources,['ecdict']);
});
test('native identity batches use only the lightweight lemma API and keep canonical mappings cached', async () => {
  const fixtureStatus = status();
  const batches: string[][] = [];
  const resolver = createNativeDictionaryIdentityResolver({ lookupLemmas: async ({ words }) => {
    batches.push(words);
    return { status: fixtureStatus, lemmas: words.map(word => word === 'studies' ? 'study' : word === 'unlisted' ? null : word) };
  } });
  assert.deepEqual(await resolver.resolve(['Studies', 'between', 'studies', 'unlisted']), ['study', 'between', 'study', 'unlisted']);
  assert.deepEqual(batches, [['studies', 'between', 'unlisted']]);
  assert.deepEqual(await resolver.resolve(['study', 'studies', 'unlisted']), ['study', 'study', 'unlisted']);
  assert.equal(batches.length, 1);
});

test('native identity failures and malformed results remain retryable instead of caching guessed IDs', async () => {
  for (const invalid of [[], [''], [17], ['study', 'extra']]) {
    let calls = 0;
    const resolver = createNativeDictionaryIdentityResolver({ lookupLemmas: async () => {
      calls++;
      return { status: status(), lemmas: calls === 1 ? invalid as Array<string | null> : ['study'] };
    } });
    await assert.rejects(resolver.resolve(['studies']), /无效的学习词条身份/);
    assert.deepEqual(await resolver.resolve(['studies']), ['study']);
    assert.equal(calls, 2);
  }
  let calls = 0;
  const resolver = createNativeDictionaryIdentityResolver({ lookupLemmas: async () => {
    if (++calls === 1) throw new Error('read failure');
    return { status: status(), lemmas: ['study'] };
  } });
  await assert.rejects(resolver.resolve(['studies']), /read failure/);
  assert.deepEqual(await resolver.resolve(['studies']), ['study']);
});

test('without ECDICT, native identity accepts only available authored exact terms', async () => {
  const fixtureStatus = status([metadata('native-reviewed')]);
  const exact = createNativeDictionaryIdentityResolver({ lookupLemmas: async () => ({ status: fixtureStatus, lemmas: ['study'] }) });
  assert.deepEqual(await exact.resolve(['STUDY']), ['study']);
  for (const lemmas of [['study'], [null]]) {
    const resolver = createNativeDictionaryIdentityResolver({ lookupLemmas: async () => ({ status: fixtureStatus, lemmas }) });
    await assert.rejects(resolver.resolve(['studies']), /身份核对已停止/);
  }
  fixtureStatus.sources[0].available = false;
  const unavailable = createNativeDictionaryIdentityResolver({ lookupLemmas: async () => ({ status: fixtureStatus, lemmas: ['study'] }) });
  await assert.rejects(unavailable.resolve(['study']), /身份核对已停止/);
});

test('a successful complete card reuses its verified ECDICT identity and preserves source order', async () => {
  const fixtureStatus: NativeDictionaryStatus = { available: true, sources: ['native-reviewed', 'ecdict'].map(id => ({ id, name: id, available: true, entryCount: 2, contentVersion: version })) };
  let fullReads = 0, lemmaReads = 0;
  const mock: NativeDictionaryPlugin = {
    ...plugin(fixtureStatus, async () => { throw new Error('Unexpected canonical lookup'); }),
    lookupLemmas: async () => { lemmaReads++; throw new Error('Card already provided this identity'); },
    lookupWords: async ({ words }) => {
      fullReads++;
      return { status: fixtureStatus, results: words.map(query => ({ query, sources: [{ dictionaryId: 'ecdict', contentVersion: version,
        record: { word: 'study', phonetic: 'ˈstʌdi', definition: 'v. to learn', translation: 'v. 学习', pos: 'v', tag: 'cet4', exchange: 's:studies/d:studied' } }] })) };
    },
  };
  const resolver = createNativeDictionaryIdentityResolver(mock);
  const core = await createNativeDictionaryService(fixtureStatus, selection(['ecdict', 'native-reviewed'], ['ecdict']), mock, resolver);
  const result = await core.lookup({ text: 'studies', language: 'en' });
  assert.deepEqual(core.listSources().sources.map(source => [source.id, source.enabled]), [['ecdict', true], ['native-reviewed', false]]);
  assert.deepEqual(result.sources.map(source => source.dictionaryId), ['ecdict']);
  assert.deepEqual(await resolver.resolve(['studies']), ['study']);
  assert.equal(fullReads, 1); assert.equal(lemmaReads, 0);
  const card = toNativeEnglishCard(result);
  assert.equal(card?.lemma, 'study');
});

test('failed full-card morphology is not reused and an established identity is not replaced', async () => {
  const fixtureStatus: NativeDictionaryStatus = { available: true, sources: [{ id: 'ecdict', name: 'ECDICT', available: true, entryCount: 2, contentVersion: version }] };
  const mock: NativeDictionaryPlugin = {
    ...plugin(fixtureStatus, async () => ({ matches: [] })),
    lookupLemmas: async () => { throw new Error('Morphology read failed'); },
    lookupWords: async ({ words }) => ({ status: fixtureStatus, results: words.map(query => ({ query, sources: [], unavailableSources: ['ecdict'] })) }),
  };
  const resolver = createNativeDictionaryIdentityResolver(mock);
  const core = await createNativeDictionaryService(fixtureStatus, selection(['ecdict']), mock, resolver);
  assert.equal((await core.lookup({ text: 'studies', language: 'en' })).status, 'unavailable');
  await assert.rejects(resolver.resolve(['studies']), /Morphology read failed/);
  resolver.prime('studies', 'study');
  mock.lookupWords = async ({ words }) => ({ status: fixtureStatus, results: words.map(query => ({ query, sources: [{ dictionaryId: 'ecdict', contentVersion: version,
    record: { word: 'studies', phonetic: '', definition: 'n. research', translation: 'n. 研究', pos: 'n', tag: '', exchange: '' } }] })) });
  const freshCore = await createNativeDictionaryService(fixtureStatus, selection(['ecdict']), mock, resolver);
  assert.equal((await freshCore.lookup({ text: 'studies', language: 'en' })).status, 'found');
  assert.deepEqual(await resolver.resolve(['studies']), ['study']);
});

test('a complete card cannot overwrite a pending identity and a verified dictionary miss needs no extra read', async () => {
  const fixtureStatus: NativeDictionaryStatus = { available: true, sources: [{ id: 'ecdict', name: 'ECDICT', available: true, entryCount: 2, contentVersion: version }] };
  let finish!: (value: { status: NativeDictionaryStatus; lemmas: Array<string | null> }) => void;
  let lemmaReads = 0;
  const mock: NativeDictionaryPlugin = {
    ...plugin(fixtureStatus, async () => ({ matches: [] })),
    lookupLemmas: () => { lemmaReads++; return new Promise(resolve => { finish = resolve; }); },
    lookupWords: async ({ words }) => ({ status: fixtureStatus, results: words.map(query => ({ query, sources: query === 'unlisted' ? [] : [{ dictionaryId: 'ecdict', contentVersion: version,
      record: { word: 'studies', phonetic: '', definition: 'n. research', translation: 'n. 研究', pos: 'n', tag: '', exchange: '' } }] })) }),
  };
  const resolver = createNativeDictionaryIdentityResolver(mock);
  const pendingIdentity = resolver.resolve(['studies']);
  const core = await createNativeDictionaryService(fixtureStatus, selection(['ecdict']), mock, resolver);
  assert.equal((await core.lookup({ text: 'studies', language: 'en' })).status, 'found');
  finish({ status: fixtureStatus, lemmas: ['study'] });
  assert.deepEqual(await pendingIdentity, ['study']);
  assert.deepEqual(await resolver.resolve(['studies']), ['study']);
  assert.equal((await core.lookup({ text: 'unlisted', language: 'en' })).status, 'not_found');
  assert.deepEqual(await resolver.resolve(['unlisted']), ['unlisted']);
  assert.equal(lemmaReads, 1);
});

test('a clicked first-batch word resolves while the later 45 background identities remain pending', { timeout: 2_000 }, async () => {
  const words = ['between', ...Array.from({ length: 49 }, (_, index) => `background${index}`)];
  const batches: string[][] = [];
  let releaseRest!: () => void;
  const rest = new Promise<void>(resolve => { releaseRest = resolve; });
  let secondStarted!: () => void;
  const second = new Promise<void>(resolve => { secondStarted = resolve; });
  const resolver = createNativeDictionaryIdentityResolver({ lookupLemmas: async ({ words: batch }) => {
    batches.push(batch);
    if (batches.length > 1) { secondStarted(); await rest; }
    return { status: status(), lemmas: batch };
  } });
  let backgroundFinished = false;
  const background = resolver.resolve(words).then(ids => { backgroundFinished = true; return ids; });
  await second;
  assert.deepEqual(await resolver.resolve(['between']), ['between']);
  assert.equal(backgroundFinished, false);
  assert.equal(batches.length, 2);
  assert.equal(batches[0].length, 5);
  releaseRest();
  assert.deepEqual(await background, words);
  assert.deepEqual(batches.flat(), words);
  assert.equal(batches.length, 10);
  assert.deepEqual(await resolver.resolve([...words].reverse()), [...words].reverse());
  assert.equal(batches.length, 10);
});

test('a tapped card displays while its passive identity is pending, then retains that authoritative ID', { timeout: 2_000 }, async () => {
  const fixtureStatus: NativeDictionaryStatus = { available: true, sources: [{ id: 'ecdict', name: 'ECDICT', available: true, entryCount: 2, contentVersion: version }] };
  let finish!: (value: { status: NativeDictionaryStatus; lemmas: Array<string | null> }) => void;
  const mock: NativeDictionaryPlugin = {
    ...plugin(fixtureStatus, async () => ({ matches: [] })),
    lookupLemmas: () => new Promise(resolve => { finish = resolve; }),
    lookupWords: async ({ words }) => ({ status: fixtureStatus, results: words.map(query => ({ query, sources: [{ dictionaryId: 'ecdict', contentVersion: version,
      record: { word: 'studies', phonetic: '', definition: 'n. research', translation: 'n. 研究', pos: 'n', tag: '', exchange: '' } }] })) }),
  };
  const resolver = createNativeDictionaryIdentityResolver(mock);
  const pending = resolver.resolve(['studies']);
  const core = await createNativeDictionaryService(fixtureStatus, selection(['ecdict']), mock, resolver);
  const result = await lookupNativeDictionary(core, { text: 'studies', language: 'en' }, undefined, resolver);
  assert.equal(result.status, 'found'); assert.equal(result.learningTermRef, undefined);
  assert.equal(toNativeEnglishCard(result)?.lemma, 'studies');
  finish({ status: fixtureStatus, lemmas: ['study'] });
  assert.deepEqual(await pending, ['study']);
  const later = await lookupNativeDictionary(core, { text: 'studies', language: 'en' }, undefined, resolver);
  assert.equal(later.learningTermRef?.stableId, 'study');
});
