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
