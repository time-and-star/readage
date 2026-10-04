import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createWordCardRequest,
  fetchWordCard,
} from '../src/lib/wordCard';

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
  globalThis.fetch = (async (url, options) => {
    assert.equal(url, '/api/dictionary/lookup');
    const { words } = JSON.parse(String(options?.body));
    assert.equal(words.length, 1);
    queries.push(words[0]);
    return new Response(JSON.stringify({ ok: true, results: [{ query: words[0], lemma: words[0],
      phonetic: '', cefrLevel: null, partOfSpeech: 'test', basicMeaningsZh: [],
      definitionEn: 'definition', definitionsEn: [] }] }));
  }) as typeof fetch;
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
  globalThis.fetch = (async (url) => {
    assert.equal(url, '/api/dictionary/lookup');
    return new Response(
      JSON.stringify({
        ok: true,
        results: [{ query: 'running', lemma: 'run', partOfSpeech: 'verb', phonetic: '',
          cefrLevel: null, definitionEn: 'to move quickly on foot', definitionsEn: [], basicMeaningsZh: ['跑'] }],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ); }) as typeof fetch;

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
  globalThis.fetch = (async (url, options) => {
    assert.equal(url, '/api/dictionary/lookup', 'individual words must not call the AI endpoint');
    const body = JSON.parse(String(options?.body)) as { words: string[] };
    assert.equal(body.words.length, 1);
    const query = body.words[0];
    assert.ok(query === 'financial' || query === 'advice');
    queries.push(query);
    return new Response(JSON.stringify({ ok: true, results: [dictionaryEntries[query]] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    for (const word of ['financial', 'advice']) {
      const request = createWordCardRequest(word, sentence)!;
      assert.deepEqual(request, { selectedText: word, contextSentence: sentence });
      const card = await fetchWordCard(request, { articleId: 'a1' });
      assert.equal(card.wordOrPhrase, word);
      assert.equal(card.source, 'dictionary');
    }
    assert.deepEqual(queries, ['financial', 'advice']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a failed lookup reports an error instead of fabricating a definition', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('network down');
  }) as typeof fetch;

  try {
    const request = createWordCardRequest('curious', 'A curious case.')!;
    await assert.rejects(fetchWordCard(request), /词典暂时无法连接/);
  } finally {
    globalThis.fetch = originalFetch;
  }
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
  globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true, results: [{
    query: 'running', lemma: 'run', phonetic: '', cefrLevel: null, partOfSpeech: 'verb',
    basicMeaningsZh: ['跑'], definitionEn: 'move quickly', definitionsEn: [],
  }] }))) as typeof fetch;
  try {
    const request = createWordCardRequest('running')!;
    const result = await fetchWordCard(request);
    globalThis.fetch = (async () => { throw new Error('offline'); }) as typeof fetch;
    assert.deepEqual(await fetchWordCard(request), JSON.parse(JSON.stringify(result)));
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
  globalThis.fetch = (async () => {
    calls++;
    return new Response(JSON.stringify({ ok: true, results: [{ query: 'speed', lemma: 'speed',
      phonetic: '', cefrLevel: null, partOfSpeech: 'noun', basicMeaningsZh: ['速度'],
      definitionEn: 'rate of motion', definitionsEn: [] }] }));
  }) as typeof fetch;
  try {
    assert.equal((await fetchWordCard(createWordCardRequest('speed')!)).wordOrPhrase, 'speed');
    assert.equal(calls, 1);
    assert.ok(values.has('english-ai:v4:word-card:speed'));
  } finally {
    globalThis.fetch = originalFetch;
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
