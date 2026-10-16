import assert from 'node:assert/strict';
import test from 'node:test';
import { parseFlashcardWordList } from '../src/lib/flashcardWordList';
import { buildVocabularyCsv } from '../src/lib/vocabularyExport';

test('text lists normalize BOM, case, whitespace and Unicode quotes while preserving terms', () => {
  assert.deepEqual(parseFlashcardWordList('\uFEFF “Apple” \nAPPLE\n‘Don’t’ ; well‑known, look   forward to ; Café\n'), {
    words: ['apple', "don't", 'well-known', 'look forward to', 'café'],
    duplicateCount: 1, invalidCount: 0, inputCount: 6,
  });
  assert.deepEqual(parseFlashcardWordList('alpha, beta; gamma', 'text').words, ['alpha', 'beta', 'gamma']);
  assert.deepEqual(parseFlashcardWordList('word, lemma, term').words, ['word', 'lemma', 'term']);
});

test('phrases stay one card and paragraphs are never split into individual words or comma fragments', () => {
  assert.deepEqual(parseFlashcardWordList('by the way\nto be or not to be\na piece of cake\nyou and me').words,
    ['by the way', 'to be or not to be', 'a piece of cake', 'you and me']);
  for (const paragraph of [
    'This is a sentence', 'I like reading books', 'The cat is sleeping', 'I’m happy',
    'Hello, world!', 'I enjoy reading, apples, bananas',
    'reading many different articles helps us develop a much stronger understanding of English vocabulary',
  ]) {
    const result = parseFlashcardWordList(paragraph, 'text');
    assert.deepEqual(result.words, [], paragraph);
    assert.equal(result.invalidCount, 1);
    assert.equal(result.inputCount, 1);
  }
});

test('invalid entries are counted independently without fabricating or extracting words', () => {
  assert.deepEqual(parseFlashcardWordList('apple\n中文\n123\nhttps://example.com\nfoo@example.com\nrun!\nword / meaning\nwell--known\n-apple\nbanana'), {
    words: ['apple', 'banana'], duplicateCount: 0, invalidCount: 8, inputCount: 10,
  });
  assert.deepEqual(parseFlashcardWordList('["apple", "APPLE", "", 42, null, true, {}, ["nested"]]', 'json'), {
    words: ['apple'], duplicateCount: 1, invalidCount: 6, inputCount: 8,
  });
  assert.deepEqual(parseFlashcardWordList('apple, https://example.com; banana, run!', 'text'), {
    words: ['apple', 'banana'], duplicateCount: 0, invalidCount: 2, inputCount: 4,
  });
});

test('CSV chooses the word header wherever it appears and does not import translations or notes', () => {
  const csv = '\uFEFFtranslation, WORD ,note\r\n苹果,Apple,"say ""hello"", then leave"\r\n梨,Pear,"first line\r\nsecond line"\r\n备注,APPLE,run\r\n';
  assert.deepEqual(parseFlashcardWordList(csv, 'csv'), {
    words: ['apple', 'pear'], duplicateCount: 1, invalidCount: 0, inputCount: 3,
  });
  assert.deepEqual(parseFlashcardWordList(csv), parseFlashcardWordList(csv, 'csv'));
  for (const header of ['word', 'lemma', 'term', '单词', '词汇', '英文']) {
    assert.deepEqual(parseFlashcardWordList(`translation,${header}\n翻译,run`, 'csv').words, ['run']);
  }
  assert.deepEqual(parseFlashcardWordList('lemma,word\nwrong,right', 'csv').words, ['right']);
});

test('CSV uses only its first column without headers, including quoted multiline terms', () => {
  assert.deepEqual(parseFlashcardWordList('"New\nYork",纽约\r\n"don\'t",不要\r\nwell-known,备注', 'csv'), {
    words: ['new york', "don't", 'well-known'], duplicateCount: 0, invalidCount: 0, inputCount: 3,
  });
  assert.deepEqual(parseFlashcardWordList('apple,fruit\npear,fruit').words, ['apple', 'pear']);
  assert.deepEqual(parseFlashcardWordList('apple,banana', 'csv').words, ['apple']);
  assert.deepEqual(parseFlashcardWordList('apple,banana').words, ['apple', 'banana']);
});

test('blank table rows are ignored while missing word cells count as invalid data rows', () => {
  assert.deepEqual(parseFlashcardWordList('word,translation\n,\n,只有翻译\napple,苹果\npear\n', 'csv'), {
    words: ['apple', 'pear'], duplicateCount: 0, invalidCount: 1, inputCount: 3,
  });
});

test('TSV uses its term column and supports quoted tabs/newlines in other columns', () => {
  const tsv = '备注\t英文\t翻译\n"first\tsecond\nthird"\tLook forward to\t期待\nignored\tLOOK FORWARD TO\t备注';
  assert.deepEqual(parseFlashcardWordList(tsv, 'tsv'), {
    words: ['look forward to'], duplicateCount: 1, invalidCount: 0, inputCount: 2,
  });
  assert.deepEqual(parseFlashcardWordList(tsv), parseFlashcardWordList(tsv, 'tsv'));
  assert.deepEqual(parseFlashcardWordList('apple\tfruit\npear\tfruit', 'tsv').words, ['apple', 'pear']);
});

test('JSON supports string arrays, independent object fields and wrapped words arrays', () => {
  assert.deepEqual(parseFlashcardWordList('["run", "well-known", "break the ice"]'), {
    words: ['run', 'well-known', 'break the ice'], duplicateCount: 0, invalidCount: 0, inputCount: 3,
  });
  const items = [{ word: 'Apple', translation: '苹果' }, { lemma: 'pear', note: 'not imported' },
    { term: 'ice cream' }, { word: '', lemma: 'run' }, { Word: 'APPLE' }, { note: 'banana' }];
  assert.deepEqual(parseFlashcardWordList(JSON.stringify({ words: items })), {
    words: ['apple', 'pear', 'ice cream', 'run'], duplicateCount: 1, invalidCount: 1, inputCount: 6,
  });
});

test('empty and malformed JSON, unsupported shapes and unclosed CSV quotes have useful errors', () => {
  for (const value of ['', ' \uFEFF\n']) assert.throws(() => parseFlashcardWordList(value), /词表为空/);
  assert.throws(() => parseFlashcardWordList('[]', 'json'), /JSON 词表为空/);
  assert.throws(() => parseFlashcardWordList('{"words": []}'), /JSON 词表为空/);
  assert.throws(() => parseFlashcardWordList('["apple",]'), /JSON 词表格式不正确/);
  assert.throws(() => parseFlashcardWordList('{"words": "apple"}'), /JSON 词表需要数组/);
  assert.throws(() => parseFlashcardWordList('{"word": "apple"}'), /JSON 词表需要数组/);
  assert.throws(() => parseFlashcardWordList('word,note\n"apple,bad', 'csv'), /引号格式不正确/);
  assert.throws(() => parseFlashcardWordList('word,note\n"apple"bad,note', 'csv'), /引号格式不正确/);
  assert.throws(() => parseFlashcardWordList('word\n', 'csv'), /词表为空/);
});

test('the app vocabulary CSV round-trips word identities without importing exported metadata', () => {
  const csv = buildVocabularyCsv([
    { word: 'well-known', phonetic: '/wel, nəʊn/', translation: '熟悉，已知', proficiency: 'L3（72分）' },
    { word: "don't", phonetic: '', translation: '不要\n第二行', proficiency: 'L1（35分）' },
  ]);
  assert.deepEqual(parseFlashcardWordList(csv, 'csv'), {
    words: ['well-known', "don't"], duplicateCount: 0, invalidCount: 0, inputCount: 2,
  });
});

test('limits apply to input records including duplicates and UTF-8 bytes, without off-by-one failures', () => {
  const tenThousand = Array.from({ length: 10_000 }, () => 'apple');
  const result = parseFlashcardWordList(tenThousand.join('\n'), 'text');
  assert.equal(result.inputCount, 10_000);
  assert.equal(result.duplicateCount, 9_999);
  assert.throws(() => parseFlashcardWordList([...tenThousand, 'pear'].join('\n'), 'text'), /10000/);
  assert.throws(() => parseFlashcardWordList(JSON.stringify([...tenThousand, 'pear']), 'json'), /10000/);
  assert.throws(() => parseFlashcardWordList(`word,translation\n${[...tenThousand, 'pear'].map(word => `${word},翻译`).join('\n')}`, 'csv'), /10000/);
  assert.throws(() => parseFlashcardWordList('a'.repeat(2 * 1024 * 1024 + 1)), /2 MiB/);
  assert.throws(() => parseFlashcardWordList('中'.repeat(Math.floor(2 * 1024 * 1024 / 3) + 1)), /2 MiB/);
  assert.equal(parseFlashcardWordList('a'.repeat(2 * 1024 * 1024)).invalidCount, 1);
});
