import assert from 'node:assert/strict';
import test from 'node:test';
import type { DictionaryRecord, DictionarySourceView, GrammarExplanation } from '../src/types';
import type { ReadAgeWord } from '../packages/dictionary/readage';
import { getFlashcardStudyContent } from '../src/lib/flashcardStudyContent';

function explanation(overrides: Partial<GrammarExplanation> = {}): GrammarExplanation {
  return { wordOrPhrase: 'adapt', type: 'verb', definition: '', grammarRules: [], exampleSentences: [],
    source: 'dictionary', ...overrides };
}

function record(senses: Array<{ en: string; zh?: string; pos?: string }> = []): DictionaryRecord {
  return { schemaVersion: 'dictionary.v2', query: 'adapt', lemma: 'adapt', phonetic: '/əˈdæpt/',
    phonetics: [], wordForms: [], wordFamily: [], cefrLevel: null, tags: [], phrases: [], supplementaryChinese: [],
    edit: { source: [], revisionVersion: 'test', reviewStatus: 'reviewed' },
    partOfSpeechGroups: senses.map((sense, index) => ({ id: `pos:${index}`, partOfSpeech: sense.pos ?? 'v.',
      usageLabels: [], sortOrder: index, senses: [{ id: `sense:${index}`, definitionEn: sense.en, definitionZh: sense.zh,
        usageLabels: [], sortOrder: 0, examples: [], collocations: [], grammarNotes: [], source: [], reviewStatus: 'reviewed' }] })) };
}

function source(entry: DictionaryRecord, readageContent?: ReadAgeWord): DictionarySourceView {
  return { dictionaryRef: { protocolVersion: 'dictionary-api.v1', catalogVersion: 'test', dictionaryId: 'test-source',
    entryId: entry.lemma, contentVersion: 'test', fieldSources: {} }, record: entry, readageContent };
}

test('study meanings retain every real sense and keep independent source translations paired', () => {
  const primary = record([{ en: 'become suited to new conditions', zh: '适应新环境' },
    { en: 'change something for a purpose', zh: '调整；改造' }]);
  const secondary = record([{ en: 'rewrite for another medium', zh: '改编' }]);
  const card = explanation({ definition: 'unpaired aggregate', definitionChinese: '不应拼接的汇总译文',
    dictionaryRecord: primary, dictionarySources: [source(primary), source(secondary)],
    senses: [{ partOfSpeech: 'n.', definition: 'a separate legacy sense', definitionZh: '保留的旧义项' }] });
  const data = getFlashcardStudyContent(card, 'adapt');
  assert.deepEqual(data.meanings.map(meaning => [meaning.en, meaning.zh]), [
    ['become suited to new conditions', '适应新环境'], ['change something for a purpose', '调整；改造'],
    ['rewrite for another medium', '改编'], ['a separate legacy sense', '保留的旧义项'],
  ]);
  assert.equal(data.meanings[0].primary, true);
  assert.ok(data.meanings.every(meaning => meaning.zh !== '不应拼接的汇总译文'));
});

test('examples obey dictionary visibility, keep translations and never replace reading context with invented examples', () => {
  const entry = record([{ en: 'change to suit', zh: '调整' }]);
  const examples = [
    { id: 'reviewed', en: 'We adapted the design.', zh: '我们调整了设计。', reviewStatus: 'reviewed' as const },
    { id: 'published', en: 'People adapt quickly.', zh: '人们适应得很快。', reviewStatus: 'unreviewed' as const, origin: 'dictionary-source' as const },
    { id: 'draft', en: 'A private editorial draft.', reviewStatus: 'unreviewed' as const },
  ].map(example => ({ ...example, source: { kind: 'manual' as const, status: 'confirmed' as const } }));
  entry.partOfSpeechGroups[0].senses[0].examples = examples;
  entry.phrases.push({ id: 'phrase', phrase: 'adapt to', definitionZh: '适应', examples: [{ ...examples[0],
    id: 'phrase-example', en: 'Children adapt to school.', zh: '孩子们适应学校。' }], source: [], reviewStatus: 'reviewed' });
  const original = 'I found adapt in the article I was reading.';
  const data = getFlashcardStudyContent(explanation({ dictionaryRecord: entry, readingOriginalSentence: original,
    exampleSentences: ['We adapted the design.'] }), 'adapt', [original]);
  assert.deepEqual(data.examples.map(example => [example.en, example.zh]), [
    ['We adapted the design.', '我们调整了设计。'], ['People adapt quickly.', '人们适应得很快。'],
    ['Children adapt to school.', '孩子们适应学校。'],
  ]);
  assert.deepEqual(data.readingContexts, [original]);
  assert.ok(!data.examples.some(example => example.en === original));
});

test('authored senses expose actual examples, collocations and semantic relations without treating word family as synonyms', () => {
  const authored: ReadAgeWord = { id: 'adapt', lemma: 'adapt', language: 'en', tier: 'core',
    coreMeaning: { en: 'change to suit new conditions', zh: '适应；调整；改编' }, pronunciations: [], forms: [],
    family: [{ word: 'adaptation' }], senses: [{ id: 'adapt:1', partOfSpeech: 'verb', titleZh: '适应',
      definitionEn: 'become suited to a new environment', definitionZhTranslation: '适应新环境', explanationZh: '',
      examples: [{ id: 'a1', english: 'Plants adapt to dry weather.', chinese: '植物适应干燥天气。' }],
      collocations: [{ phrase: 'adapt to change', meaningZh: '适应变化' }],
      synonyms: [{ word: 'adjust', zh: '调整；适应', focus: '较具体的调整' }],
      antonyms: [{ word: 'resist', zh: '抵制', note: '仅为特定语境的语义对照，并非所有义项下的严格反义词。' }],
    }, { id: 'adapt:2', partOfSpeech: 'verb', titleZh: '改编', definitionEn: 'rewrite for another medium',
      definitionZhTranslation: '改编', explanationZh: '', examples: [], collocations: [],
      synonyms: [{ word: 'rewrite', zh: '改写' }], antonyms: [],
    }] };
  const data = getFlashcardStudyContent(explanation({ dictionarySources: [source(record(), authored)],
    relatedWords: ['adaptable'] }), 'adapt');
  assert.equal(data.meanings.length, 3);
  assert.equal(data.meanings[0].zh, '适应；调整；改编');
  assert.deepEqual(data.examples.map(item => item.en), ['Plants adapt to dry weather.']);
  assert.deepEqual(data.collocations.map(item => [item.en, item.zh]), [['adapt to change', '适应变化']]);
  assert.deepEqual(data.synonyms.map(item => item.word), ['adjust', 'rewrite']);
  assert.equal(data.antonyms[0].word, 'resist');
  assert.match(data.antonyms[0].note, /并非所有义项下的严格反义词/);
  assert.ok(!data.synonyms.some(item => ['adaptation', 'adaptable'].includes(item.word)));
});

test('missing fields produce no filler sections and context stays complete for the expandable excerpt renderer', () => {
  const longContext = `${Array.from({ length: 35 }, (_, index) => `before${index}`).join(' ')} adapt ${Array.from({ length: 35 }, (_, index) => `after${index}`).join(' ')}`;
  const data = getFlashcardStudyContent(null, 'adapt', ['', longContext, longContext]);
  assert.deepEqual(data, { meanings: [], examples: [], collocations: [], synonyms: [], antonyms: [], readingContexts: [longContext] });
  const empty = getFlashcardStudyContent(explanation({ relatedWords: ['adaptation'] }), 'adapt');
  assert.deepEqual(empty, { meanings: [], examples: [], collocations: [], synonyms: [], antonyms: [], readingContexts: [] });
});

test('authored formatting is projected as inert readable text without changing the dictionary object', () => {
  const entry = record([{ en: 'change &amp; adjust<script>bad()</script>', zh: '<b>适应</b>新环境' }]);
  entry.partOfSpeechGroups[0].senses[0].collocations = [{ en: '<b>adapt</b> to change', zh: '适应变化',
    source: { kind: 'manual', status: 'confirmed' }, reviewStatus: 'reviewed' }];
  const card = explanation({ dictionaryRecord: entry });
  const before = JSON.stringify(card);
  const data = getFlashcardStudyContent(card, 'adapt');
  assert.equal(data.meanings[0].en, 'change & adjust');
  assert.equal(data.meanings[0].zh, '适应新环境');
  assert.equal(data.collocations[0].en, 'adapt to change');
  assert.equal(JSON.stringify(card), before);
  assert.doesNotMatch(JSON.stringify(data), /<b>|<script>|bad\(\)/);
});

test('legacy collocations and example text remain available without semantic relation fields', () => {
  const data = getFlashcardStudyContent(explanation({ definition: 'change to suit a purpose', definitionChinese: '调整以适应目的',
    exampleSentences: ['We adapt as we learn.'], collocations: [{ en: 'adapt a plan', zh: '调整计划' }],
    relatedWords: ['adaptation'] }), 'adapt');
  assert.equal(data.meanings[0].zh, '调整以适应目的');
  assert.deepEqual(data.examples.map(item => item.en), ['We adapt as we learn.']);
  assert.deepEqual(data.collocations.map(item => item.en), ['adapt a plan']);
  assert.deepEqual(data.synonyms, []);
  assert.deepEqual(data.antonyms, []);
});
