import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildVocabularyCsv,
  formatVocabularyProficiency,
} from '../src/lib/vocabularyExport';

test('formats proficiency as a level and rounded memory score', () => {
  assert.equal(formatVocabularyProficiency(3, 72.4), 'L3（72分）');
  assert.equal(formatVocabularyProficiency(0, Number.NaN), 'L0（0分）');
});

test('builds an Excel-friendly UTF-8 CSV and escapes cells', () => {
  const csv = buildVocabularyCsv([
    {
      word: 'well-known',
      phonetic: '/wel, nəʊn/',
      translation: '熟悉, "已知"',
      proficiency: 'L3（72分）',
    },
    {
      word: 'say "hi"',
      phonetic: '',
      translation: '第一行\n第二行',
      proficiency: 'L1（35分）',
    },
  ]);

  assert.equal(
    csv,
    '\uFEFF词汇,英标,翻译,熟练度\r\n'
      + 'well-known,"/wel, nəʊn/","熟悉, ""已知""",L3（72分）\r\n'
      + '"say ""hi""",,"第一行\n第二行",L1（35分）\r\n'
  );
});

test('exports the header when there are no vocabulary rows', () => {
  assert.equal(buildVocabularyCsv([]), '\uFEFF词汇,英标,翻译,熟练度\r\n');
});
