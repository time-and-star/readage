import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateWordTimeline, mapSpokenChunks, speechWords, wordIndexAtTime } from '../src/lib/speech/wordTiming';
import { splitRemoteSpeechText } from '../src/lib/speech';
import { buildReadingSpeech } from '../src/lib/readingSpeech';

test('word ranges preserve contractions, punctuation, numbers and repeated words', () => {
  const text = 'We’re ready—ready for 2026.';
  assert.deepEqual(speechWords(text).map(word => text.slice(word.start, word.end)), ['We’re', 'ready', 'ready', 'for', '2026']);
  const repeated = 'A repeated sentence.\n\nA repeated sentence.';
  const mapped = mapSpokenChunks(repeated, ['A repeated sentence.', 'A repeated sentence.']);
  assert.equal(mapped[0][0].start, 0);
  assert.equal(mapped[1][0].start, 22);
});

test('estimated guide spans the actual audio duration and follows seeking and boundaries', () => {
  const timeline = estimateWordTimeline('First, considerably longer words.', 10);
  assert.equal(timeline[0].start, 0);
  assert.ok(Math.abs(timeline.at(-1)!.end - 10) < 0.00001);
  assert.ok(timeline[1].end - timeline[1].start > timeline[3].end - timeline[3].start);
  assert.equal(wordIndexAtTime(timeline, 0), 0);
  assert.equal(wordIndexAtTime(timeline, timeline[1].start), 1);
  assert.equal(wordIndexAtTime(timeline, 9.99), 3);
  assert.equal(wordIndexAtTime(timeline, 0), 0, 'seeking backwards follows media time');
  assert.equal(wordIndexAtTime(estimateWordTimeline('Ready.', NaN), 1), -1);
});

test('local opening is shorter while every original word remains mapped', () => {
  const text = 'With several clear examples and a comfortable pace, readers can learn the rhythm of English as they follow every word in this longer sentence.';
  const chunks = splitRemoteSpeechText(text, 200, 100);
  assert.ok(chunks[0].length <= 100);
  assert.ok(chunks[0].endsWith(','));
  assert.equal(chunks.join(' '), text);
  assert.deepEqual(mapSpokenChunks(text, chunks).flat(), speechWords(text));
});

test('article speech matches visible prose and link labels, excluding hidden title and navigation', () => {
  const article = { id: 'article', title: 'Article title', content: ['Article title', 'First [useful link](https://example.test).', 'Next Main Menu Previous', 'First useful words.'] };
  const speech = buildReadingSpeech(article);
  assert.equal(speech.text, 'First useful link.\n\nFirst useful words.');
  assert.equal(speech.paragraphs.get(1)?.start, 0);
  assert.equal(speech.paragraphs.get(3)?.start, 20);
  assert.equal(speech.paragraphs.has(0), false);
});
