import assert from 'node:assert/strict';
import test from 'node:test';
import { getSentenceBounds, getReadingWordBoundary } from '../src/lib/readingTouchSelection';

test('mobile word selection uses the same independent boundaries as reading clicks', () => {
  const text = 'financial-advice can’t café';
  assert.equal(getReadingWordBoundary(text, 4, 'start'), 0);
  assert.equal(getReadingWordBoundary(text, 4, 'end'), 9);
  assert.equal(getReadingWordBoundary(text, 12, 'start'), 10);
  assert.equal(getReadingWordBoundary(text, 12, 'end'), 16);
  assert.equal(getReadingWordBoundary(text, 19, 'start'), 17);
  assert.equal(getReadingWordBoundary(text, 19, 'end'), 22);
  assert.equal(getReadingWordBoundary(text, 25, 'start'), 23);
  assert.equal(getReadingWordBoundary(text, 25, 'end'), 27);
});

function selectedSentence(text: string, offset: number): string | null {
  const bounds = getSentenceBounds(text, offset);
  return bounds ? text.slice(bounds.start, bounds.end) : null;
}

test('a press inside a later sentence selects that complete sentence with punctuation', () => {
  const text = 'First sentence. A longer second sentence wraps across several lines. Last sentence.';
  const bounds = getSentenceBounds(text, text.indexOf('wraps') + 2);
  assert.deepEqual(bounds, { start: text.indexOf('A longer'), end: text.indexOf(' Last') });
  assert.equal(selectedSentence(text, text.indexOf('wraps')), 'A longer second sentence wraps across several lines.');
});

test('sentence selection preserves quotation marks and repeated ending punctuation', () => {
  const text = 'She said, “Wait!” What happened?! Everything changed.';
  assert.equal(selectedSentence(text, text.indexOf('Wait')), 'She said, “Wait!”');
  assert.equal(selectedSentence(text, text.indexOf('happened')), 'What happened?!');
});

test('spaces between sentences choose the next sentence, without outer whitespace', () => {
  const text = '  First sentence.   Second sentence.  ';
  assert.equal(selectedSentence(text, 0), 'First sentence.');
  assert.equal(selectedSentence(text, text.indexOf('   ')), 'Second sentence.');
  assert.equal(selectedSentence(text, text.length - 1), 'Second sentence.');
});

test('caret offsets at the paragraph endpoints remain inside the first or last sentence', () => {
  const text = 'Start here. End here.';
  assert.equal(selectedSentence(text, -10), 'Start here.');
  assert.equal(selectedSentence(text, 0), 'Start here.');
  assert.equal(selectedSentence(text, text.length), 'End here.');
  assert.equal(selectedSentence(text, text.length + 10), 'End here.');
});

test('a paragraph without sentence punctuation is still selectable', () => {
  const text = '  A heading or unfinished paragraph with multiple words  ';
  assert.deepEqual(getSentenceBounds(text, text.indexOf('multiple')), { start: 2, end: text.length - 2 });
});

test('article titles retain colon and dash subtitles as one selection', () => {
  const title = 'Reading the world: Why context matters — a practical guide';
  assert.equal(selectedSentence(title, title.indexOf('context')), title);
  assert.equal(selectedSentence(title, title.indexOf('guide')), title);
});

test('short recommendation titles are selectable from their first and final words', () => {
  const title = 'Next article';
  assert.equal(selectedSentence(title, 0), title);
  assert.equal(selectedSentence(title, title.indexOf('article') + 3), title);
});

test('decimals are kept together and non-English punctuation remains selectable', () => {
  const text = 'The value is 3.14 today. 下一句。最后一句！';
  assert.equal(selectedSentence(text, text.indexOf('3.14') + 2), 'The value is 3.14 today.');
  assert.equal(selectedSentence(text, text.indexOf('下一')), '下一句。');
  assert.equal(selectedSentence(text, text.indexOf('最后')), '最后一句！');
});

test('empty text and unusable caret coordinates do not create a selection', () => {
  assert.equal(getSentenceBounds('', 0), null);
  assert.equal(getSentenceBounds(' \n\t ', 1), null);
  assert.equal(getSentenceBounds('A sentence.', Number.NaN), null);
  assert.equal(getSentenceBounds('A sentence.', Number.POSITIVE_INFINITY), null);
});

test('fallback sentence selection works without Intl.Segmenter', t => {
  const descriptor = Object.getOwnPropertyDescriptor(Intl, 'Segmenter');
  Object.defineProperty(Intl, 'Segmenter', { configurable: true, value: undefined });
  t.after(() => {
    if (descriptor) Object.defineProperty(Intl, 'Segmenter', descriptor);
    else Reflect.deleteProperty(Intl, 'Segmenter');
  });

  const text = '  Dr. Park checked 3.14 at example.com.  “Ready?!” A final unfinished sentence  ';
  assert.equal(selectedSentence(text, text.indexOf('Park')), 'Dr. Park checked 3.14 at example.com.');
  assert.equal(selectedSentence(text, text.indexOf('3.14') + 2), 'Dr. Park checked 3.14 at example.com.');
  assert.equal(selectedSentence(text, text.indexOf('  “')), '“Ready?!”');
  assert.equal(selectedSentence(text, text.length), 'A final unfinished sentence');
});
