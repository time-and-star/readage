import assert from 'node:assert/strict';
import test from 'node:test';
import { DICTIONARY_PROTOCOL_VERSION } from '../packages/dictionary/contracts';
import { dictionaryCacheKey } from '../packages/dictionary/cache';
import {
  createWordCardRequest,
  fetchWordCard,
} from '../src/lib/wordCard';

// Catalogue requests are separate from the lookup counts checked below.
const catalog = { protocolVersion: DICTIONARY_PROTOCOL_VERSION, catalogVersion: 'test-catalog.v1', defaultSource: 'native-reviewed', sources: [] };
const withCatalog = (fetcher: typeof fetch): typeof fetch => (async (url, options) =>
  String(url).endsWith('/v1/sources') ? new Response(JSON.stringify({ ok: true, catalog })) : fetcher(url, options)) as typeof fetch;

test('word card requests keep the clicked word and its article context', () => {
  assert.deepEqual(
    createWordCardRequest('world.', 'Hello world.'),
    { selectedText: 'world', contextSentence: 'Hello world.' },
  );
});

test('word card requests keep multi-word phrases', () => {
  assert.deepEqual(
    createWordCardRequest('break a leg!', 'I hope you break a leg tonight.'),
    { selectedText: 'break a leg', contextSentence: 'I hope you break a leg tonight.' },
  );
});

test('lookup normalization preserves contractions and compounds without concatenating separated words', () => {
  for (const [input, selectedText] of [['‘can’t,’', "can't"], ['well‑known', 'well-known'],
    ['co\u00adoperate', 'cooperate'], ['financial/advice', 'financial advice'],
    ['financial—advice', 'financial advice']] as const) {
    assert.equal(createWordCardRequest(input)?.selectedText, selectedText);
  }
});

test('contractions and hyphenated compounds use a single dictionary lookup', async () => {
  const originalFetch = globalThis.fetch;
  const queries: string[] = [];
  globalThis.fetch = withCatalog((async (url, options) => {
    assert.equal(url, '/api/dictionary/lookup');
    const { words } = JSON.parse(String(options?.body));
    assert.equal(words.length, 1);
    queries.push(words[0]);
    return new Response(JSON.stringify({ ok: true, results: [{ query: words[0], lemma: words[0],
      phonetic: '', cefrLevel: null, partOfSpeech: 'test', basicMeaningsZh: [],
      definitionEn: 'definition', definitionsEn: [] }] }));
  }) as typeof fetch);
  try {
    for (const word of ['can’t', 'well‑known']) await fetchWordCard(createWordCardRequest(word)!);
    assert.deepEqual(queries, ["can't", 'well-known']);
  } finally { globalThis.fetch = originalFetch; }
});

test('word card requests reject clicks that contain no lookup text', () => {
  assert.equal(createWordCardRequest('---', 'No lookup.'), null);
  assert.equal(createWordCardRequest('   ', ''), null);
});

test('single-word lookup works without accessing the authenticated AI endpoint', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = withCatalog((async (url) => {
    assert.equal(url, '/api/dictionary/lookup');
    return new Response(
      JSON.stringify({
        ok: true,
        results: [{ query: 'running', lemma: 'run', partOfSpeech: 'verb', phonetic: '',
          cefrLevel: null, definitionEn: 'to move quickly on foot', definitionsEn: [], basicMeaningsZh: ['跑'] }],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ); }) as typeof fetch);

  try {
    const request = createWordCardRequest('running', 'She is running late.')!;
    const card = await fetchWordCard(request, { articleId: 'a1' });
    assert.equal(card.wordOrPhrase, 'run');
    assert.equal(card.source, 'dictionary');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('financial and advice remain separate dictionary lookups in the same sentence', async () => {
  const originalFetch = globalThis.fetch;
  const sentence = 'Get financial advice from professionals.';
  const queries: string[] = [];
  const dictionaryEntries = {
    financial: { query: 'financial', lemma: 'financial', partOfSpeech: 'adjective', phonetic: '',
      cefrLevel: null, definitionEn: 'involving financial matters', definitionsEn: [], basicMeaningsZh: ['金融的'] },
    advice: { query: 'advice', lemma: 'advice', partOfSpeech: 'noun', phonetic: '',
      cefrLevel: null, definitionEn: 'a proposal for an appropriate course of action', definitionsEn: [], basicMeaningsZh: ['建议'] },
  };
  globalThis.fetch = withCatalog((async (url, options) => {
    assert.equal(url, '/api/dictionary/lookup', 'individual words must not call the AI endpoint');
    const body = JSON.parse(String(options?.body)) as { words: string[] };
    assert.equal(body.words.length, 1);
    const query = body.words[0];
    assert.ok(query === 'financial' || query === 'advice');
    queries.push(query);
    return new Response(JSON.stringify({ ok: true, results: [dictionaryEntries[query]] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch);

  try {
    for (const word of ['financial', 'advice']) {
      const request = createWordCardRequest(word, sentence)!;
      assert.deepEqual(request, { selectedText: word, contextSentence: sentence });
      const card = await fetchWordCard(request, { articleId: 'a1' });
      assert.equal(card.wordOrPhrase, word);
      assert.equal(card.source, 'dictionary');
      assert.equal(card.readingOriginalSentence, sentence);
      assert.equal(card.readingOriginalWord, word);
    }
    assert.deepEqual(queries, ['financial', 'advice']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a failed lookup reports an error instead of fabricating a definition', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = withCatalog((async () => {
    throw new Error('network down');
  }) as typeof fetch);

  try {
    const request = createWordCardRequest('curious', 'A curious case.')!;
    await assert.rejects(fetchWordCard(request), /词典暂时无法连接/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a dictionary miss stays local and does not invoke the disabled AI explanation', async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = withCatalog((async url => {
    calls.push(String(url));
    assert.equal(url, '/api/dictionary/lookup');
    return new Response(JSON.stringify({ ok: true, results: [null] }));
  }) as typeof fetch);
  try {
    await assert.rejects(fetchWordCard(createWordCardRequest('zzunlistedword')!), /词典未收录/);
    assert.deepEqual(calls, ['/api/dictionary/lookup']);
  } finally { globalThis.fetch = originalFetch; }
});

test('a phrase queries the enabled dictionaries before offering translation after a miss', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = withCatalog((async (url, options) => {
    calls++;
    assert.equal(url, '/api/dictionary/lookup');
    assert.deepEqual(JSON.parse(String(options?.body)), { words: ['break a leg'] });
    return new Response(JSON.stringify({ ok: true, results: [null] }));
  }) as typeof fetch);
  try {
    await assert.rejects(fetchWordCard(createWordCardRequest('break a leg')!), /点击“翻译”/);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test('a phrase found in a user dictionary returns its original content without invoking AI', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = withCatalog((async url => {
    assert.equal(url, '/api/dictionary/lookup');
    return new Response(JSON.stringify({ ok: true, results: [{ query: 'break a leg', lemma: 'break a leg',
      phonetic: '', cefrLevel: null, partOfSpeech: '', basicMeaningsZh: [], definitionsEn: [],
      definitionEn: '祝你好运', dictionarySources: [{ dictionaryRef: { dictionaryId: 'my-mdx', dictionaryName: '我的词典' },
        originalContent: { mediaType: 'text/html', content: '<p>祝你好运</p>', plainText: '祝你好运' } }] }] }));
  }) as typeof fetch);
  try {
    const card = await fetchWordCard(createWordCardRequest('break a leg')!);
    assert.equal(card.source, 'dictionary');
    assert.equal(card.wordOrPhrase, 'break a leg');
    assert.equal(card.originalDictionaryContent?.plainText, '祝你好运');
  } finally { globalThis.fetch = originalFetch; }
});

test('a cached definition remains available when the dictionary is offline; cancelled requests stay cancelled', async () => {
  const originalFetch = globalThis.fetch;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  } });
  globalThis.fetch = withCatalog((async () => new Response(JSON.stringify({ ok: true, results: [{
    query: 'running', lemma: 'run', phonetic: '', cefrLevel: null, partOfSpeech: 'verb',
    basicMeaningsZh: ['跑'], definitionEn: 'move quickly', definitionsEn: [],
  }] }))) as typeof fetch);
  try {
    const request = createWordCardRequest('running')!;
    const result = await fetchWordCard(request);
    globalThis.fetch = withCatalog((async () => { throw new Error('offline'); }) as typeof fetch);
    assert.deepEqual(await fetchWordCard(request), { ...JSON.parse(JSON.stringify(result)), readingOriginalSentence: undefined });
    const legacyCard = { ...result, dictionaryRef: { dictionaryId: 'native-reviewed', dictionaryName: 'readge 自编词典' },
      dictionarySourceMisses: [{ dictionaryId: 'native-reviewed', dictionaryName: 'readge 自编词典' },
        { dictionaryId: 'custom', dictionaryName: 'ReadAge 学习词典' }] };
    const cacheKey = 'english-ai:v7:word-card:' + dictionaryCacheKey('en', catalog.catalogVersion, 'running');
    const storedCard = JSON.stringify(legacyCard);
    values.set(cacheKey, storedCard);
    const displayed = await fetchWordCard(request);
    assert.equal(displayed.dictionaryRef?.dictionaryName, 'ReadAge 自编词典');
    assert.deepEqual(displayed.dictionarySourceMisses?.map(source => source.dictionaryName), ['ReadAge 自编词典', 'ReadAge 学习词典']);
    assert.equal(values.get(cacheKey), storedCard, 'display changes do not rewrite cached content');
    const controller = new AbortController(); controller.abort();
    await assert.rejects(fetchWordCard(request, { signal: controller.signal }), /cancelled/);
  } finally {
    globalThis.fetch = originalFetch;
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('old cards with incorrectly stemmed headwords are refreshed from the dictionary', async () => {
  const originalFetch = globalThis.fetch;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map([['english-ai:v3:word-card:speed', JSON.stringify({
    source: 'dictionary', wordOrPhrase: 'spe', definition: 'incorrect old entry',
  })]]);
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  } });
  let calls = 0;
  globalThis.fetch = withCatalog((async () => {
    calls++;
    return new Response(JSON.stringify({ ok: true, results: [{ query: 'speed', lemma: 'speed',
      phonetic: '', cefrLevel: null, partOfSpeech: 'noun', basicMeaningsZh: ['速度'],
      definitionEn: 'rate of motion', definitionsEn: [] }] }));
  }) as typeof fetch);
  try {
    assert.equal((await fetchWordCard(createWordCardRequest('speed')!)).wordOrPhrase, 'speed');
    assert.equal(calls, 1);
    assert.ok(values.has('english-ai:v7:word-card:' + dictionaryCacheKey('en', catalog.catalogVersion, 'speed')));
  } finally {
    globalThis.fetch = originalFetch;
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
