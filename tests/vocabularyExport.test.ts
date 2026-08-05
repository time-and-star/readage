import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildVocabularyCsv,
  buildVocabularyExportRows,
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

test('keeps proficiency rows when dictionary details are missing', () => {
  const rows = buildVocabularyExportRows(
    [
      { wordId: 'run', level: 4, memoryScore: 99.6 },
      { wordId: 'unknown', level: 1, memoryScore: 34.5 },
    ],
    [
      {
        phonetic: '/rʌn/',
        basicMeaningsZh: ['跑', '运行', '多余释义'],
      },
      null,
    ],
  );

  assert.deepEqual(rows, [
    {
      word: 'run',
      phonetic: '/rʌn/',
      translation: '跑；运行',
      proficiency: 'L4（100分）',
    },
    {
      word: 'unknown',
      phonetic: '',
      translation: '',
      proficiency: 'L1（35分）',
    },
  ]);
});

test('neutralizes spreadsheet formula-like values before export', () => {
  const csv = buildVocabularyCsv([
    {
      word: '=SUM(1,1)',
      phonetic: '',
      translation: '@mention',
      proficiency: 'L0（0分）',
    },
  ]);

  assert.match(csv, /"'=SUM\(1,1\)"/);
  assert.match(csv, /,'@mention,L0/);
});
