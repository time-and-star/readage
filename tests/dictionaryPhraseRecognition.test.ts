import assert from 'node:assert/strict';
import test from 'node:test';
import type { GrammarExplanation } from '../src/types';
import type { DictionaryRecord } from '../packages/dictionary/compat/englishTypes';
import { recognizeDictionaryPhraseAtToken } from '../src/lib/dictionaryPhraseRecognition';
import { fetchReadingWordCard } from '../src/lib/readingWordCard';
import type { FetchWordCardOptions, WordCardRequest } from '../src/lib/wordCard';

function card(phrases: string[]): GrammarExplanation {
  return {
    wordOrPhrase: 'take', type: 'v.', definition: 'move or remove something', grammarRules: [], exampleSentences: [],
    collocations: phrases.map(en => ({ en, zh: '' })),
  };
}

test('recognizes a dictionary collocation around the clicked word despite surrounding punctuation', () => {
  const paragraph = 'They decided to “take off” early.';
  assert.equal(recognizeDictionaryPhraseAtToken(paragraph, 3, card(['take off'])), 'take off');
  assert.equal(recognizeDictionaryPhraseAtToken(paragraph, 4, card(['take off'])), 'take off');
});

test('uses the longest exact dictionary phrase containing the clicked word', () => {
  const paragraph = 'They decided to take off early.';
  assert.equal(recognizeDictionaryPhraseAtToken(paragraph, 3, card(['take off', 'take off early'])), 'take off early');
});

test('uses the dictionary-confirmed headword only for the clicked inflected token', () => {
  const lookedUp = { ...card(['look for']), wordOrPhrase: 'look', exchanges: [{ label: '过去式', value: 'looked' }] };
  assert.equal(recognizeDictionaryPhraseAtToken('We looked for a quiet place.', 1, lookedUp), 'look for');
  assert.equal(recognizeDictionaryPhraseAtToken('They looked at the sign.', 1, lookedUp), null);
});

test('does not recognize phrases across punctuation, links, or an unrelated clicked token', () => {
  assert.equal(recognizeDictionaryPhraseAtToken('They take, off early.', 1, card(['take off'])), null);
  assert.equal(recognizeDictionaryPhraseAtToken('They take [off](https://example.com) early.', 1, card(['take off'])), null);
  assert.equal(recognizeDictionaryPhraseAtToken('They decided to take off early.', 5, card(['take off'])), null);
});

test('does not infer a phrase that the dictionary did not provide', () => {
  assert.equal(recognizeDictionaryPhraseAtToken('They decided to take off early.', 3, card([])), null);
});

test('reads structured phrase entries from the canonical dictionary record', () => {
  const source = { kind: 'unknown' as const, status: 'confirmed' as const };
  const dictionaryRecord: DictionaryRecord = {
    schemaVersion: 'dictionary.v2', query: 'look', lemma: 'look', phonetic: '', phonetics: [], wordForms: [], wordFamily: [],
    cefrLevel: null, tags: [], partOfSpeechGroups: [], supplementaryChinese: [],
    phrases: [{ id: 'look-for', phrase: 'look for', examples: [], source: [source], reviewStatus: 'unreviewed' }],
    edit: { source: [source], revisionVersion: 'fixture:1', reviewStatus: 'unreviewed' },
  };
  assert.equal(recognizeDictionaryPhraseAtToken('We looked for a quiet place.', 1,
    { ...card([]), wordOrPhrase: 'look', exchanges: [{ label: 'past', value: 'looked' }], dictionaryRecord }), 'look for');
});

test('looks up a confirmed collocation as a phrase and reports the display term', async () => {
  const calls: string[] = [];
  const fetch = async (request: WordCardRequest, _options: FetchWordCardOptions) => {
    calls.push(request.selectedText);
    return request.selectedText === 'take'
      ? card(['take off'])
      : { ...card([]), wordOrPhrase: 'take off' };
  };
  const result = await fetchReadingWordCard({ selectedText: 'take', contextSentence: 'They decided to take off early.' },
    { articleId: 'test-article', clickedTokenIndex: 3 }, fetch);
  assert.deepEqual(calls, ['take', 'take off']);
  assert.equal(result.card.wordOrPhrase, 'take off');
  assert.equal(result.recognizedPhrase, 'take off');
});

test('keeps the clicked word when no dictionary phrase matches or phrase lookup fails', async () => {
  const request = { selectedText: 'take', contextSentence: 'They decided to take off early.' };
  const noMatch = await fetchReadingWordCard(request, { articleId: 'test-article', clickedTokenIndex: 3 },
    async () => card([]));
  assert.equal(noMatch.card.wordOrPhrase, 'take');
  assert.equal(noMatch.recognizedPhrase, undefined);

  const fallback = await fetchReadingWordCard(request, { articleId: 'test-article', clickedTokenIndex: 3 },
    async query => {
      if (query.selectedText === 'take off') throw new Error('phrase unavailable');
      return card(['take off']);
    });
  assert.equal(fallback.card.wordOrPhrase, 'take');
  assert.equal(fallback.recognizedPhrase, undefined);
});

test('propagates cancellation during optional phrase lookup instead of showing stale results', async () => {
  const controller = new AbortController();
  await assert.rejects(fetchReadingWordCard({ selectedText: 'take', contextSentence: 'They take off early.' },
    { articleId: 'test-article', clickedTokenIndex: 1, signal: controller.signal }, async query => {
      if (query.selectedText === 'take off') {
        controller.abort();
        throw new Error('Lookup cancelled');
      }
      return card(['take off']);
    }));
});
