import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeDictionaryEntry } from '../server/dictionary/model';

function legacy(overrides: Partial<Parameters<typeof canonicalizeDictionaryEntry>[0]> = {}) {
  return {
    query: 'sample', lemma: 'sample', phonetic: '/sample/', phonetics: [], cefrLevel: 'A1',
    partOfSpeech: 'n.', basicMeaningsZh: ['n. 样本', '补充中文'],
    dictionaryTranslations: [{ partOfSpeech: 'n.', meanings: ['样本'] }],
    definitionEn: 'a small part or quantity intended to show what the whole is like',
    definitionsEn: [{ partOfSpeech: 'n.', definition: 'a small part or quantity intended to show what the whole is like', definitionZh: '用于展示整体特征的一小部分或数量' }],
    definitionsZh: [], exchanges: [], relatedWords: [], tags: [], collocations: [], usageNotes: '', register: '', source: 'ECDICT' as const,
    ...overrides,
  };
}

describe('canonical dictionary model', () => {
  it('groups transitive and intransitive uses without losing their labels', () => {
    const entry = canonicalizeDictionaryEntry(legacy({
      definitionsEn: [
        { partOfSpeech: 'vi.', definition: 'move quickly on foot', definitionZh: '快速用脚移动' },
        { partOfSpeech: 'vt.', definition: 'operate or manage', definitionZh: '操作或管理' },
      ],
    }));
    assert.equal(entry.partOfSpeechGroups.length, 1);
    assert.equal(entry.partOfSpeechGroups[0].partOfSpeech, 'v.');
    assert.deepEqual(entry.partOfSpeechGroups[0].usageLabels, ['vi.', 'vt.']);
    assert.equal(entry.partOfSpeechGroups[0].senses.length, 2);
  });

  it('keeps conflicting Chinese candidates instead of silently pairing or deleting them', () => {
    const entry = canonicalizeDictionaryEntry(legacy({
      definitionsEn: [
        { partOfSpeech: 'n.', definition: 'a reserve', definitionZh: '储备' },
        { partOfSpeech: 'n.', definition: 'a reserve', definitionZh: '后备力量' },
      ],
    }));
    const sense = entry.partOfSpeechGroups[0].senses[0];
    assert.equal(sense.reviewStatus, 'needs-review');
    assert.deepEqual(sense.definitionZhCandidates, ['储备', '后备力量']);
  });

  it('keeps unpaired Chinese glosses in supplementaryChinese', () => {
    const entry = canonicalizeDictionaryEntry(legacy({
      basicMeaningsZh: ['n. 样本', '网络补充释义'],
      definitionsEn: [{ partOfSpeech: 'n.', definition: 'a specimen', definitionZh: '样本' }],
    }));
    assert.deepEqual(entry.supplementaryChinese, ['网络补充释义']);
    assert.equal(entry.partOfSpeechGroups[0].senses[0].definitionZh, '样本');
    assert.deepEqual(entry.basicMeaningsZh, ['n. 样本', '网络补充释义']);
  });

  it('does not merge identical English definitions across different parts of speech', () => {
    const entry = canonicalizeDictionaryEntry(legacy({
      definitionsEn: [
        { partOfSpeech: 'n.', definition: 'a change', definitionZh: '变化' },
        { partOfSpeech: 'v.', definition: 'a change', definitionZh: '改变' },
      ],
    }));
    assert.equal(entry.partOfSpeechGroups.length, 2);
    assert.equal(entry.partOfSpeechGroups[0].senses.length, 1);
    assert.equal(entry.partOfSpeechGroups[1].senses.length, 1);
  });
});
