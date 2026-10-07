import assert from 'node:assert/strict';
import test from 'node:test';
import { englishLanguageAdapter } from '../packages/dictionary/languages/english';
import { tokenizeEnglishText } from '../src/lib/englishTokens';
import { createWordCardRequest } from '../src/lib/wordCard';
import { canonicalLearningWordId } from '../src/lib/learningWordIds';

const words = (text: string) => tokenizeEnglishText(text).filter(token => token.type === 'word').map(token => token.value);

test('wink reading boundaries separate adjacent words across every visible separator', () => {
  for (const gap of [' ', '\t', '\n', '\r\n', '\u00a0', '\u202f', '-', '\u2010', '\u2011', '—', '–', '/', '\u200b']) {
    assert.deepEqual(words(`financial${gap}advice`), ['financial', 'advice'], JSON.stringify(gap));
  }
  assert.deepEqual(words('New York-based companies'), ['New', 'York', 'based', 'companies']);
});

test('linguistic contractions remain whole clickable surfaces without joining adjacent words', () => {
  for (const word of ["can't", 'can’t', "won't", "don't", "I've", "we're", "isn't", "cannot", 'James’s']) {
    assert.deepEqual(words(`${word} help`), [word, 'help'], word);
    assert.ok(createWordCardRequest(word));
  }
});

test('dictionary lookup preserves accented words, identifiers and dotted abbreviations', () => {
  for (const word of ['naïve', 'café', 'U.S.', 'COVID-19', 'GPT-4']) {
    assert.deepEqual(words(word), [word]);
    assert.equal(createWordCardRequest(word)?.selectedText, word);
  }
  assert.equal(createWordCardRequest('“naïve,”')?.selectedText, 'naïve');
});

test('reading surfaces preserve discretionary soft hyphens and lookup removes only the formatting marker', () => {
  assert.deepEqual(words('co\u00adoperate with well-known writers'), ['co\u00adoperate', 'with', 'well', 'known', 'writers']);
  assert.equal(createWordCardRequest('co\u00adoperate')?.selectedText, 'cooperate');
});

test('all source text and UTF-16 positions survive projection, including spaces omitted by wink output', () => {
  for (const text of ['  “Can’t,”\twell‑known/co\u00adoperate—practice.\n', '\t\n  ', '',
    '😀 café café\r\nnaïve\u00a0U.S.', 'This https://example.com URL and a@example.com remain text.',
    '日语と日本語。 English words.', 'e\u0301lan', 'word'.repeat(100), ' '.repeat(70_000) + 'hello world  ']) {
    const tokens = tokenizeEnglishText(text);
    assert.equal(tokens.map(token => token.value).join(''), text);
    let end = 0;
    for (const token of tokens) {
      assert.equal(token.start, end);
      assert.equal(text.slice(token.start, token.end), token.value);
      assert.ok(token.end > token.start);
      if (token.type === 'word') assert.ok(!/\s/u.test(token.value));
      end = token.end;
    }
    assert.equal(end, text.length);
  }
});

test('cached paragraph tokens cannot be changed by a caller or reused across another paragraph', () => {
  const tokens = tokenizeEnglishText('financial advice');
  tokens[0].value = 'corrupt';
  tokens.length = 1;
  assert.deepEqual(words('financial advice'), ['financial', 'advice']);
  assert.deepEqual(words('financial advisor'), ['financial', 'advisor']);
});

test('language registration exposes the pinned engine version without guessing learning lemmas', () => {
  assert.match(englishLanguageAdapter.adapterVersion, /wink-nlp\.2\.4\.0/);
  assert.equal(englishLanguageAdapter.capabilities.morphology, 'unsupported');
  assert.deepEqual(englishLanguageAdapter.candidates?.('running'), [{ text: 'running', kind: 'normalized' }]);
  assert.deepEqual(englishLanguageAdapter.segment?.('financial-advice').filter(token => token.kind === 'term').map(token => token.text),
    ['financial', 'advice']);
  for (const [surface, confirmed, expected] of [['running', 'run', 'run'], ['books', 'book', 'book'],
    ['well-known', null, 'well known'], ["can't", null, "can't"], ['naïve', null, 'naïve']] as const) {
    assert.equal(canonicalLearningWordId(surface, confirmed), expected);
  }
});
