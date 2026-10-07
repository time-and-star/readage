import { after, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildDictionaryExplanation,
  getDictionaryHealth,
  isDictionaryExplainFirstEnabled,
  isSingleWordQuery,
  lookupDictionaryWord,
  lookupDictionaryWords,
} from '../server/dictionary/service';

const originalExplainFirst = process.env.DICTIONARY_EXPLAIN_FIRST;
// These compatibility checks exercise the native-first startup defaults,
// independently of the user's persisted display order and enabled sources.
const originalSettingsFile = process.env.DICTIONARY_SETTINGS_FILE;
process.env.DICTIONARY_SETTINGS_FILE = path.join(tmpdir(), `readage-dictionary-test-${randomUUID()}.json`);
after(() => {
  if (originalSettingsFile === undefined) delete process.env.DICTIONARY_SETTINGS_FILE;
  else process.env.DICTIONARY_SETTINGS_FILE = originalSettingsFile;
});

afterEach(() => {
  if (originalExplainFirst === undefined) delete process.env.DICTIONARY_EXPLAIN_FIRST;
  else process.env.DICTIONARY_EXPLAIN_FIRST = originalExplainFirst;
});

describe('local dictionary health', () => {
  it('reports a usable bundled pack', () => {
    const health = getDictionaryHealth();
    assert.equal(health.available, true);
    assert.equal(health.ok, true);
    assert.equal(health.missingRequired.length, 0);
    assert.ok(health.indexedEntries > 100_000, `expected a large index, got ${health.indexedEntries}`);
    assert.equal(health.schemaVersion, 'dictionary.v2');
    assert.equal(health.revisionCount, 50);
  });
});

describe('isSingleWordQuery', () => {
  it('accepts single English tokens including apostrophes and hyphens', () => {
    assert.equal(isSingleWordQuery('running'), true);
    assert.equal(isSingleWordQuery("don't"), true);
    assert.equal(isSingleWordQuery('well-known'), true);
    assert.equal(isSingleWordQuery(' Serendipity '), true);
  });

  it('rejects phrases, punctuation, digits, and empty input', () => {
    assert.equal(isSingleWordQuery('break a leg'), false);
    assert.equal(isSingleWordQuery('hello!'), false);
    assert.equal(isSingleWordQuery('123'), false);
    assert.equal(isSingleWordQuery(''), false);
    assert.equal(isSingleWordQuery(undefined), false);
  });
});

describe('dictionary lookups', () => {
  it('keeps independent headwords instead of guessing unrelated suffix stems', async () => {
    for (const word of ['speed', 'spring', 'string', 'morning', 'politics', 'economics', 'physics', 'naked', 'wicked', 'sacred']) {
      const entry = await lookupDictionaryWord(word);
      assert.equal(entry?.lemma, word, `${word} must keep its own dictionary entry`);
    }
  });

  it('validates regular inflections and normalizes typographic compounds/contractions', async () => {
    for (const [query, lemma] of [['running', 'run'], ['studies', 'study'], ['books', 'book'], ['chasing', 'chase'],
      ['can’t', "can't"], ['well‑known', 'well-known']] as const) {
      assert.equal((await lookupDictionaryWord(query))?.lemma, lemma);
    }
  });

  it('lemmatizes inflected forms and returns core fields', async () => {
    const entry = await lookupDictionaryWord('running');
    assert.ok(entry, 'expected a dictionary hit for "running"');
    assert.equal(entry.lemma, 'run');
    assert.ok(entry.phonetic.startsWith('/'));
    assert.ok(entry.basicMeaningsZh.length > 0);
    assert.ok(entry.partOfSpeech.length > 0);
    if (entry.cefrLevel !== null) {
      assert.match(entry.cefrLevel, /^[ABC][12]$/);
    }
  });

  it('returns null for unknown words without throwing', async () => {
    assert.equal(await lookupDictionaryWord('asdkfjhqwerty'), null);
  });

  it('keeps batch lookup order and nulls for misses', async () => {
    const [hit, miss] = await lookupDictionaryWords(['serendipity', 'asdkfjhqwerty']);
    assert.ok(hit, 'expected "serendipity" to be found');
    assert.equal(miss, null);
  });
});

describe('buildDictionaryExplanation', () => {
  it('maps an entry onto GrammarExplanation with dictionary extras', async () => {
    const entry = await lookupDictionaryWord('studies');
    assert.ok(entry, 'expected "studies" to resolve to its lemma');
    const explanation = buildDictionaryExplanation('studies', entry, 'She studies law at Oxford.');

    assert.equal(explanation.source, 'dictionary');
    assert.equal(explanation.wordOrPhrase, entry.lemma);
    assert.equal(explanation.phonetic, entry.phonetic);
    assert.ok(explanation.definition.trim().length > 0);
    assert.ok((explanation.chineseTranslation ?? '').trim().length > 0);
    assert.deepEqual(explanation.exampleSentences, []);
    assert.equal(explanation.readingOriginalSentence, 'She studies law at Oxford.');
    assert.ok(Array.isArray(explanation.senses) && explanation.senses.length > 0);
    assert.ok(explanation.senses.every((sense) => sense.definition.trim().length > 0));
  });

  it('omits the example list when no context sentence is available', async () => {
    const entry = await lookupDictionaryWord('run');
    assert.ok(entry);
    const explanation = buildDictionaryExplanation('run', entry);
    assert.ok(explanation.exampleSentences.length > 0, 'curated dictionary examples should remain separate from reading context');
    assert.equal(explanation.readingOriginalSentence, undefined);
  });

  it('uses reviewed sample senses for high-value polysemes', async () => {
    const bank = await lookupDictionaryWord('bank');
    assert.ok(bank);
    const bankSenses = bank.partOfSpeechGroups.flatMap((group) => group.senses.map((sense) => sense.definitionZh));
    assert.ok(bankSenses.some((meaning) => meaning?.includes('银行')));
    assert.ok(bankSenses.some((meaning) => meaning?.includes('河岸')));

    const run = await lookupDictionaryWord('run');
    assert.ok(run);
    assert.ok(run.partOfSpeechGroups.flatMap((group) => group.senses).some((sense) => sense.definitionZh?.includes('经营')));

    const better = await lookupDictionaryWord('better');
    assert.ok(better);
    assert.deepEqual(better.partOfSpeechGroups.map((group) => group.partOfSpeech), ['adj.', 'adv.', 'v.']);

    const sanction = await lookupDictionaryWord('sanction');
    assert.ok(sanction);
    const sanctionMeanings = sanction.partOfSpeechGroups.flatMap((group) => group.senses.map((sense) => sense.definitionZh));
    assert.ok(sanctionMeanings.some((meaning) => meaning?.includes('批准')));
    assert.ok(sanctionMeanings.some((meaning) => meaning?.includes('制裁')));
  });

  it('keeps irregular forms linked without presenting went as a noun or flattening saw', async () => {
    const went = await lookupDictionaryWord('went');
    assert.ok(went);
    assert.equal(went.partOfSpeechGroups.length, 0);
    assert.equal(went.partOfSpeech, 'word form');
    assert.equal(went.wordForms.find((form) => form.value === 'go')?.label, '原形');

    const saw = await lookupDictionaryWord('saw');
    assert.ok(saw);
    assert.ok(saw.partOfSpeechGroups.some((group) => group.partOfSpeech === 'n.'));
    assert.ok(saw.partOfSpeechGroups.some((group) => group.partOfSpeech === 'v.'));
    assert.equal(saw.wordForms.find((form) => form.value === 'see')?.label, '原形');
  });

  it('cleans ECDICT phonetic quirks and exchange noise', async () => {
    const entry = await lookupDictionaryWord('serendipity');
    assert.ok(entry);
    const explanation = buildDictionaryExplanation('serendipity', entry);
    assert.ok(explanation.phonetic);
    assert.doesNotMatch(explanation.phonetic, /^\/[,;\s]/, 'phonetic must not keep a leading comma');

    for (const exchange of explanation.exchanges ?? []) {
      assert.ok(exchange.value.trim().length >= 2, `exchange value looks like noise: ${exchange.value}`);
    }
    const keys = (explanation.exchanges ?? []).map((item) => `${item.label}:${item.value.toLowerCase()}`);
    assert.equal(new Set(keys).size, keys.length, 'exchanges must be deduplicated');
  });
});

describe('isDictionaryExplainFirstEnabled', () => {
  it('defaults to enabled and honors explicit opt-out', () => {
    delete process.env.DICTIONARY_EXPLAIN_FIRST;
    assert.equal(isDictionaryExplainFirstEnabled(), true);

    process.env.DICTIONARY_EXPLAIN_FIRST = 'false';
    assert.equal(isDictionaryExplainFirstEnabled(), false);
    process.env.DICTIONARY_EXPLAIN_FIRST = '0';
    assert.equal(isDictionaryExplainFirstEnabled(), false);

    process.env.DICTIONARY_EXPLAIN_FIRST = 'true';
    assert.equal(isDictionaryExplainFirstEnabled(), true);
  });
});
