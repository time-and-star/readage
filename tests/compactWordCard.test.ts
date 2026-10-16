import assert from 'node:assert/strict';
import test from 'node:test';
import type { DictionaryRecord, DictionarySourceView, GrammarExplanation } from '../src/types';
import { getCompactWordCard } from '../src/lib/compactWordCard';
import { toDictionarySourceWordCard } from '../src/lib/dictionaryClient';

function explanation(overrides: Partial<GrammarExplanation> = {}): GrammarExplanation {
  return {
    wordOrPhrase: 'run', type: 'verb', definition: 'move quickly',
    grammarRules: [], exampleSentences: [], source: 'dictionary', ...overrides,
  };
}

function record(groups: Array<{ pos: string; en: string; zh?: string }>): DictionaryRecord {
  return {
    schemaVersion: 'dictionary.v2', query: 'running', lemma: 'run', phonetic: '/rʌn/',
    phonetics: [], wordForms: [], wordFamily: [], cefrLevel: null, tags: [], phrases: [], supplementaryChinese: [],
    edit: { source: [], revisionVersion: 'test', reviewStatus: 'reviewed' },
    partOfSpeechGroups: groups.map((item, index) => ({
      id: String(index), partOfSpeech: item.pos, usageLabels: ['irrelevant usage'], sortOrder: index,
      senses: [{ id: `${index}:1`, definitionEn: item.en, definitionZh: item.zh,
        usageLabels: [], sortOrder: 0, examples: [], collocations: [], grammarNotes: [],
        source: [], reviewStatus: 'reviewed' }],
    })),
  };
}

function authoredSource(coreMeaning = { zh: '跑；经营；运转', en: 'move quickly, manage, or operate' }): DictionarySourceView {
  return {
    dictionaryRef: { protocolVersion: 'dictionary-api.v1', catalogVersion: 'test', dictionaryId: 'native-reviewed',
      entryId: 'run', contentVersion: 'test', fieldSources: {} },
    record: record([{ pos: 'v.', en: 'move faster than walking', zh: '以比步行更快的速度移动' }]),
    readageContent: { id: 'run', lemma: 'run', language: 'en', tier: 'core', coreMeaning,
      senses: [], pronunciations: [], forms: [], family: [] },
  };
}

test('authored core meanings win over first senses and external original content regardless of source order', () => {
  const authored = authoredSource({ zh: '  跑；经营；运转  ', en: '  move quickly, manage, or operate  ' });
  const fallback = { ...authored, readageContent: undefined,
    dictionaryRef: { ...authored.dictionaryRef, dictionaryId: 'fallback' },
    originalContent: { mediaType: 'text/plain', content: 'External definition', plainText: 'External definition' } };
  const primary = toDictionarySourceWordCard(fallback);
  for (const sources of [[fallback, authored], [authored, fallback]]) {
    const result = { ...primary, dictionarySources: sources };
    const before = JSON.stringify(result);
    const preview = getCompactWordCard(result, 'running');
    assert.equal(preview.meaningZh, '跑；经营；运转');
    assert.equal(preview.definitionEn, 'move quickly, manage, or operate');
    assert.equal(preview.originalText, undefined);
    assert.equal(preview.partOfSpeech, 'v.');
    assert.equal(preview.restoredFrom, 'running');
    assert.equal(JSON.stringify(result), before);
  }
});

test('missing authored core fields fall back only to that authored source', () => {
  const fallback = explanation({ definitionChinese: '外部翻译', chineseTranslation: '汇总翻译',
    dictionaryRecord: record([{ pos: 'n.', en: 'an external noun sense', zh: '外部名词义项' }]) });
  for (const coreMeaning of [{ zh: ' ', en: ' ' }, { zh: '跑；经营', en: ' ' }, { zh: ' ', en: 'move or operate' }]) {
    const preview = getCompactWordCard({ ...fallback, dictionarySources: [authoredSource(coreMeaning)] });
    assert.equal(preview.meaningZh, coreMeaning.zh.trim() || '以比步行更快的速度移动');
    assert.equal(preview.definitionEn, coreMeaning.en.trim() || 'move faster than walking');
    assert.equal(preview.partOfSpeech, 'v.');
  }
});

test('authored pronunciation takes priority and supplementation requires the same headword', () => {
  const authored = authoredSource();
  const primary = explanation({ phonetic: '/external/' });
  assert.equal(getCompactWordCard({ ...primary, dictionarySources: [authored] }).phonetic, '/rʌn/');
  const withoutPronunciation = { ...authored, record: { ...authored.record, phonetic: '' } };
  assert.equal(getCompactWordCard({ ...primary, wordOrPhrase: 'Run', dictionarySources: [withoutPronunciation] }).phonetic, '/external/');
  assert.equal(getCompactWordCard({ ...primary, wordOrPhrase: 'unrelated', dictionarySources: [withoutPronunciation] }).phonetic, undefined);
});

test('cards without an authored entry keep the existing dictionary fallback', () => {
  const fallback = { ...authoredSource(), readageContent: undefined };
  const primary = toDictionarySourceWordCard(fallback);
  assert.deepEqual(getCompactWordCard({ ...primary, dictionarySources: [fallback] }), getCompactWordCard(primary));
});

test('canonical preview selects one bilingual sense and keeps its part of speech and pair together', () => {
  const preview = getCompactWordCard(explanation({
    chineseTranslation: '汇总中文，不应混入', definitionChinese: '其他义项',
    dictionaryRecord: record([{ pos: 'n.', en: 'a period of operation' },
      { pos: 'v.', en: 'move faster than walking', zh: '跑；奔跑' },
      { pos: 'v.', en: 'manage a business', zh: '经营' }]),
    senses: [{ partOfSpeech: 'adj.', definition: 'different legacy sense', definitionZh: '不同旧义项' }],
  }));
  assert.equal(preview.partOfSpeech, 'v.');
  assert.equal(preview.meaningZh, '跑；奔跑');
  assert.equal(preview.definitionEn, 'move faster than walking');
  assert.equal(preview.phonetic, '/rʌn/');
});

test('canonical and old senses remove matching repeated POS prefixes without changing dictionary text', () => {
  const entry = record([{ pos: 'adj.', en: 'easy to carry', zh: 'adj. adj. 可携带的；可搬运的' }]);
  const preview = getCompactWordCard(explanation({ wordOrPhrase: 'portable', dictionaryRecord: entry }));
  assert.equal(preview.partOfSpeech, 'adj.');
  assert.equal(preview.meaningZh, '可携带的；可搬运的');
  assert.equal(entry.partOfSpeechGroups[0].senses[0].definitionZh, 'adj. adj. 可携带的；可搬运的');
  const unknown = getCompactWordCard(explanation({ dictionaryRecord: record([{ pos: 'unknown', en: 'easy to carry', zh: 'a. adj. 可携带的' }]) }));
  assert.equal(unknown.partOfSpeech, 'adj.');
  assert.equal(unknown.meaningZh, '可携带的');
  const old = getCompactWordCard(explanation({ senses: [{ partOfSpeech: 'verb', definition: 'move quickly', definitionZh: 'vt. v. 跑' }] }));
  assert.equal(old.partOfSpeech, 'v.');
  assert.equal(old.meaningZh, '跑');
});

test('canonical previews preserve a Chinese POS prefix that conflicts with the sense group', () => {
  const preview = getCompactWordCard(explanation({ dictionaryRecord: record([{ pos: 'n.', en: 'a portable device', zh: 'adj. 可携带的' }]) }));
  assert.equal(preview.partOfSpeech, 'n.');
  assert.equal(preview.meaningZh, 'adj. 可携带的');
});

test('legacy senses preserve a paired meaning and normalize known part-of-speech labels', () => {
  const preview = getCompactWordCard(explanation({ senses: [
    { partOfSpeech: 'noun', definition: 'a period of operation' },
    { partOfSpeech: 'vt.', definition: 'manage a business', definitionZh: '经营' },
  ] }));
  assert.equal(preview.partOfSpeech, 'v.');
  assert.equal(preview.meaningZh, '经营');
  assert.equal(preview.definitionEn, 'manage a business');
});

test('a sense without Chinese keeps its English instead of borrowing aggregate Chinese', () => {
  const preview = getCompactWordCard(explanation({
    chineseTranslation: '不相关翻译', dictionaryRecord: record([{ pos: 'unknown', en: 'move quickly' }]),
  }));
  assert.equal(preview.partOfSpeech, undefined);
  assert.equal(preview.meaningZh, undefined);
  assert.equal(preview.definitionEn, 'move quickly');
});

test('old cards recover a clear Chinese part-of-speech prefix and avoid Chinese English definitions', () => {
  const preview = getCompactWordCard(explanation({ type: 'unknown', definitionChinese: 'adj. adj. 一些；若干', definition: '一些；若干' }));
  assert.equal(preview.partOfSpeech, 'adj.');
  assert.equal(preview.meaningZh, '一些；若干');
  assert.equal(preview.definitionEn, undefined);
  assert.equal(getCompactWordCard(explanation({ definitionChinese: 'adj. 一些', definition: 'adj. 一些' })).definitionEn, undefined);
  const chineseFallback = getCompactWordCard(explanation({ type: 'unknown', definition: 'v. 跑；奔跑' }));
  assert.equal(chineseFallback.partOfSpeech, 'v.');
  assert.equal(chineseFallback.meaningZh, '跑；奔跑');
  assert.equal(chineseFallback.definitionEn, undefined);
  const duplicate = getCompactWordCard(explanation({ type: 'phrase', definitionChinese: 'a small amount', definition: 'a small amount' }));
  assert.equal(duplicate.partOfSpeech, undefined);
  assert.equal(duplicate.definitionEn, undefined);
});

test('dictionary restoration uses selected text or canonical query and ignores case-only differences', () => {
  const value = explanation({ dictionaryRecord: record([{ pos: 'v.', en: 'move quickly', zh: '跑' }]) });
  assert.equal(getCompactWordCard(value, ' running ').restoredFrom, 'running');
  assert.equal(getCompactWordCard(value).restoredFrom, 'running');
  assert.equal(getCompactWordCard(value, 'Run').restoredFrom, undefined);
  assert.equal(getCompactWordCard({ ...value, phonetic: '/custom/' }).phonetic, '/custom/');
});

test('AI phrases do not claim dictionary restoration or display non-part-of-speech types', () => {
  const preview = getCompactWordCard(explanation({ wordOrPhrase: 'break a leg', type: 'phrase', source: 'ai',
    definitionChinese: '祝你好运', definition: 'used to wish someone luck' }), 'break a leg!');
  assert.equal(preview.restoredFrom, undefined);
  assert.equal(preview.partOfSpeech, undefined);
  assert.equal(preview.meaningZh, '祝你好运');
  assert.equal(preview.definitionEn, 'used to wish someone luck');
});

test('Chinese-only senses remain usable and empty old canonical fields allow the legacy fallback', () => {
  const chinese = getCompactWordCard(explanation({ senses: [{ partOfSpeech: 'pron.', definition: '', definitionZh: '你；您' }] }));
  assert.equal(chinese.meaningZh, '你；您');
  assert.equal(chinese.definitionEn, undefined);
  const old = getCompactWordCard(explanation({ dictionaryRecord: { lemma: 'run' } as DictionaryRecord,
    senses: [{ partOfSpeech: 'verb', definition: 'move quickly', definitionZh: '跑' }] }));
  assert.equal(old.partOfSpeech, 'v.');
  assert.equal(old.meaningZh, '跑');
});
