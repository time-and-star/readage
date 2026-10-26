import assert from 'node:assert/strict';
import test from 'node:test';
import { getReadingContextExcerpt, READING_CONTEXT_MAX_CHARACTERS, READING_CONTEXT_MAX_WORDS } from '../src/lib/readingContextExcerpt';

test('a short source sentence remains complete and does not need expansion', () => {
  const text = 'Small parks make cities resilient to heat.';
  assert.deepEqual(getReadingContextExcerpt(text, 'resilient'), {
    fullText: text, sentence: text, text, matchedWord: 'resilient',
    isExcerpt: false, omittedBefore: false, omittedAfter: false,
  });
});

test('paragraph context selects the target sentence and retains the whole original for expansion', () => {
  const text = 'An earlier topic has no bearing on the word. Small parks make cities resilient to heat. The next paragraph discusses cost.';
  const result = getReadingContextExcerpt(text, 'resilient');
  assert.equal(result.text, 'Small parks make cities resilient to heat.');
  assert.equal(result.sentence, result.text, 'reading aloud uses the complete matching sentence');
  assert.equal(result.fullText, text);
  assert.ok(result.omittedBefore && result.omittedAfter);
});

test('a long sentence keeps complete target phrases near its start, middle and end', () => {
  const padding = Array.from({ length: 65 }, (_, index) => `part${index}`);
  for (const position of [0, 30, padding.length]) {
    const parts = [...padding];
    parts.splice(position, 0, 'take', 'great', 'care');
    const text = parts.join(' ') + '.';
    const result = getReadingContextExcerpt(text, 'take great care');
    assert.ok(result.isExcerpt);
    assert.match(result.text, /take great care/);
    assert.ok(result.text.split(/\s+/u).length <= READING_CONTEXT_MAX_WORDS);
    assert.ok(result.text.length <= READING_CONTEXT_MAX_CHARACTERS);
    assert.ok(text.includes(result.text), 'the displayed words are one continuous, unrewritten source slice');
    assert.equal(result.sentence, text, 'long-sentence speech has neither an arbitrary cut nor added ellipses');
    assert.equal(result.fullText, text);
    if (position === 0) assert.equal(result.omittedBefore, false);
    if (position === padding.length) assert.equal(result.omittedAfter, false);
  }
});

test('known word forms and typography find the source without matching inside another word', () => {
  assert.equal(getReadingContextExcerpt('They were silent. He returned.', 'he').text, 'He returned.');
  assert.equal(getReadingContextExcerpt('The runners ran home. Nobody stayed.', ['run', 'ran']).matchedWord, 'ran');
  const text = 'It was well‑known. They said, “We can’t take\n  great care of everyone.”';
  assert.equal(getReadingContextExcerpt(text, 'well-known').sentence, 'It was well‑known.');
  assert.equal(getReadingContextExcerpt(text, "can't").matchedWord, 'can’t');
  assert.equal(getReadingContextExcerpt(text, 'take great care').matchedWord, 'take\n  great care');
});

test('unknown historical word forms still offer a bounded preview and lossless expansion', () => {
  const text = Array.from({ length: 70 }, (_, index) => `item${index}`).join(' ');
  const result = getReadingContextExcerpt(text, 'absent');
  assert.equal(result.matchedWord, undefined);
  assert.ok(result.isExcerpt && result.omittedAfter);
  assert.equal(result.fullText, text);
  assert.ok(result.text.length <= READING_CONTEXT_MAX_CHARACTERS);
});

test('CJK context without spaces stays bounded around the complete target', () => {
  const text = '前面的背景内容'.repeat(12) + '恢复能力' + '后面的进一步说明'.repeat(12) + '。';
  const result = getReadingContextExcerpt(text, '恢复能力');
  assert.match(result.text, /恢复能力/);
  assert.ok(result.text.length <= READING_CONTEXT_MAX_CHARACTERS);
  assert.ok(result.omittedBefore && result.omittedAfter);
  assert.equal(result.fullText, text);
});

test('an unusually long selected phrase is never cut merely to meet preview limits', () => {
  const phrase = Array.from({ length: 30 }, (_, index) => `target${index}`).join(' ');
  const result = getReadingContextExcerpt('Before. ' + phrase + '. After.', phrase);
  assert.ok(result.text.includes(phrase));
  assert.equal(result.matchedWord, phrase);
});

test('source extraction remains available in WebViews without Intl.Segmenter', t => {
  const descriptor = Object.getOwnPropertyDescriptor(Intl, 'Segmenter');
  Object.defineProperty(Intl, 'Segmenter', { configurable: true, value: undefined });
  t.after(() => { if (descriptor) Object.defineProperty(Intl, 'Segmenter', descriptor); });
  const text = 'Other news. Dr. Smith paid 3.14 dollars for a resilient plant. Later it grew.';
  assert.equal(getReadingContextExcerpt(text, 'resilient').sentence, 'Dr. Smith paid 3.14 dollars for a resilient plant.');
});

test('empty context stays empty without adding invented wording', () => {
  const result = getReadingContextExcerpt(' \n ', 'word');
  assert.equal(result.text, '');
  assert.equal(result.fullText, '');
  assert.equal(result.isExcerpt, false);
});
