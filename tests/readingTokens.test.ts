import assert from 'node:assert/strict';
import test from 'node:test';
import { tokenizeEnglishText } from '../src/lib/englishTokens';
import { tokenizeReadingParagraph } from '../src/lib/readingTokens';
import { getReadingTermMatches } from '../src/lib/textHighlight';
import { extractLearningUnits, findLearningUnitAtTokenIndex } from '../src/lib/readingExposure';
import { findWordIndexInParagraph, createMemoryOccurrenceId } from '../src/lib/memoryV2Integration';
import { createWordCardRequest } from '../src/lib/wordCard';

test('preserves original prose and offsets while separating punctuation and whitespace', () => {
  const text = ' “can’t,”\twell‑known/co\u00adoperate—practice.\n';
  const tokens = tokenizeEnglishText(text);
  assert.equal(tokens.map(token => token.value).join(''), text);
  for (const token of tokens) assert.equal(text.slice(token.start, token.end), token.value);
  assert.deepEqual(tokens.filter(token => token.type === 'word').map(token => token.value),
    ['can’t', 'well‑known', 'co\u00adoperate', 'practice']);
});

test('each rendered word resolves to its own lookup and memory occurrence', () => {
  const paragraph = '— financial/advice, can’t well‑known words. financial advice.';
  const tokens = tokenizeReadingParagraph(paragraph);
  assert.equal(tokens.map(token => token.value).join(''), paragraph);
  const words = tokens.filter(token => token.type === 'word');
  assert.deepEqual(words.map(token => token.tokenIndex), [0, 1, 2, 3, 4, 5, 6]);
  const exposures = extractLearningUnits(paragraph);
  for (const token of words) {
    const request = createWordCardRequest(token.value)!;
    const click = findLearningUnitAtTokenIndex(paragraph, [request.selectedText], token.tokenIndex);
    const exposure = exposures.find(unit => unit.tokenIndex === token.tokenIndex);
    assert.deepEqual(click, exposure);
    assert.equal(createMemoryOccurrenceId('article', 0, click!), createMemoryOccurrenceId('article', 0, exposure!));
  }
  assert.notEqual(createMemoryOccurrenceId('article', 0, exposures[0]), createMemoryOccurrenceId('article', 0, exposures[5]));
  assert.equal(findWordIndexInParagraph(paragraph, 'advice'), 1);
});

test('phrases stop at punctuation, numbers and links but allow ordinary whitespace', () => {
  for (const paragraph of ['break. A leg', 'break, a leg', 'break/a leg', 'break—a leg', 'break — a leg',
    'break 2 a leg', 'break [a](https://example.com/a) leg']) {
    assert.deepEqual(getReadingTermMatches(tokenizeReadingParagraph(paragraph), ['break a leg']), [], paragraph);
    assert.equal(findWordIndexInParagraph(paragraph, 'break a leg'), -1);
  }
  assert.deepEqual(getReadingTermMatches(tokenizeReadingParagraph('break\t a\u00a0leg!'), ['break a leg']),
    [{ term: 'break a leg', tokenIndex: 0, tokenLength: 3 }]);
});

test('a highlighted hyphenated word never consumes the next word', () => {
  const units = extractLearningUnits('well‑known writers', ['well-known']);
  assert.deepEqual(units, [
    { wordId: 'well known', tokenIndex: 0, tokenLength: 1 },
    { wordId: 'writers', tokenIndex: 1, tokenLength: 1 },
  ]);
  assert.equal(findLearningUnitAtTokenIndex('well‑known writers', ['well-known'], 1)?.wordId, 'writers');
});

test('longer phrases win across overlaps and adjacent repeated phrases remain distinct', () => {
  assert.deepEqual(getReadingTermMatches(tokenizeReadingParagraph('a new phrase over time'), ['a new', 'new phrase over time']), [
    { term: 'new phrase over time', tokenIndex: 1, tokenLength: 4 },
  ]);
  assert.deepEqual(extractLearningUnits('over time over time', ['over time']), [
    { wordId: 'over time', tokenIndex: 0, tokenLength: 2 },
    { wordId: 'over time', tokenIndex: 2, tokenLength: 2 },
  ]);
});

test('links keep navigation behavior and surrounding prose keeps the same click/exposure index', () => {
  const paragraph = 'Read [the source](https://example.com/a), then practice/reflect.';
  const tokens = tokenizeReadingParagraph(paragraph);
  assert.deepEqual(tokens.filter(token => token.type === 'link'), [
    { type: 'link', value: 'the source', href: 'https://example.com/a', tokenIndex: 1 },
  ]);
  assert.deepEqual(extractLearningUnits(paragraph), [
    { wordId: 'read', tokenIndex: 0, tokenLength: 1 },
    { wordId: 'practice', tokenIndex: 3, tokenLength: 1 },
    { wordId: 'reflect', tokenIndex: 4, tokenLength: 1 },
  ]);
  assert.equal(findLearningUnitAtTokenIndex(paragraph, [], 1), null);
  assert.equal(findWordIndexInParagraph(paragraph, 'reflect'), 4);
});
