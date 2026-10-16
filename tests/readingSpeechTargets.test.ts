import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReadingSpeech, createReadingWordSpeechTarget, resolveSpeechHighlightRange } from '../src/lib/readingSpeech';
import { tokenizeReadingParagraph } from '../src/lib/readingTokens';
import { speechWords } from '../src/lib/speech/wordTiming';

type ReadingArticle = Parameters<typeof buildReadingSpeech>[0];

/** The renderer writes these displayed offsets to each clickable word's dataset. */
function clickedWord(article: ReadingArticle, paragraphIndex: number, surface: string, language: string, occurrence = -1) {
  const source = buildReadingSpeech(article);
  const paragraph = source.paragraphs.get(paragraphIndex)!;
  let offset = paragraph.start;
  const occurrences = tokenizeReadingParagraph(article.content[paragraphIndex], language).flatMap(token => {
    const start = offset;
    offset += token.value.length;
    return token.type === 'word' && token.value === surface ? [{ start, end: offset }] : [];
  });
  const clicked = occurrences.at(occurrence)!;
  assert.ok(clicked, `Expected clickable ${surface}`);
  const target = createReadingWordSpeechTarget(article.id, String(clicked.start), String(clicked.end));
  assert.ok(target);
  return { source, target };
}

test('French card speech highlights the clicked elle rather than a substring of belles or an earlier elle', () => {
  const article = { id: 'french', title: 'French', content: ['De belles fleurs, puis elle est rentrée chez elle.'] };
  const { source, target } = clickedWord(article, 0, 'elle', 'fr');
  assert.deepEqual(target, { articleId: 'french', startOffset: 45, endOffset: 49 });
  assert.notEqual(target.startOffset, source.text.indexOf('elle'), 'The first substring is inside belles');
  assert.deepEqual(resolveSpeechHighlightRange(target, speechWords('elle')[0]), { start: 45, end: 49 });
  assert.equal(source.text.slice(target.startOffset, target.endOffset), 'elle');
});

test('English card speech highlights he independently of theme and repeated he occurrences', () => {
  const article = { id: 'english', title: 'English', content: ['The theme is clear; he reads while he listens.'] };
  const { source, target } = clickedWord(article, 0, 'he', 'en');
  assert.deepEqual(target, { articleId: 'english', startOffset: 35, endOffset: 37 });
  assert.deepEqual(resolveSpeechHighlightRange(target, speechWords('he')[0]), { start: 35, end: 37 });
  assert.equal(source.text.slice(target.startOffset, target.endOffset), 'he');
});

test('a click in the second continuous article keeps that article and its own visible source offsets', () => {
  const first = { id: 'first', title: 'First', content: ['elle'] };
  const second = { id: 'second:fr', title: 'Second', content: ['First visible paragraph.', 'Puis elle lit.'] };
  const { source, target } = clickedWord(second, 1, 'elle', 'fr');
  assert.deepEqual(target, { articleId: 'second:fr', startOffset: 31, endOffset: 35 });
  assert.notEqual(target.articleId, first.id);
  const range = resolveSpeechHighlightRange(target, speechWords('elle')[0])!;
  assert.equal(source.text.slice(range.start, range.end), 'elle');
});

test('word targets use visible Markdown labels and paragraph breaks rather than link URL lengths', () => {
  const article = { id: 'links', title: 'Heading', content: ['Heading', 'Elle lit [une source](https://example.test/a-long-path), puis elle écrit.'] };
  const { source, target } = clickedWord(article, 1, 'elle', 'fr');
  assert.equal(source.text, 'Elle lit une source, puis elle écrit.');
  assert.deepEqual(target, { articleId: 'links', startOffset: 26, endOffset: 30 });
  assert.deepEqual(resolveSpeechHighlightRange(target, speechWords('elle')[0]), { start: 26, end: 30 });
  assert.equal(source.paragraphs.has(0), false, 'The hidden title does not shift visible offsets');
});

test('dictionary lemmas keep the original inflected span even when spoken text is shorter or longer', () => {
  const article = { id: 'inflections', title: 'Inflections', content: ['Les chevaux ont faim.'] };
  for (const [surface, lemma, expected] of [
    ['chevaux', 'cheval', { start: 4, end: 11 }],
    ['ont', 'avoir', { start: 12, end: 15 }],
  ] as const) {
    const { source, target } = clickedWord(article, 0, surface, 'fr');
    const range = resolveSpeechHighlightRange(target, speechWords(lemma)[0]);
    assert.deepEqual(range, expected);
    assert.equal(source.text.slice(range!.start, range!.end), surface);
    assert.equal(source.text.includes(lemma), false, 'A lemma need not occur in the article');
  }
});

test('article and selected passage targets continue following each spoken word instead of fixing the whole passage', () => {
  const text = 'Premier paragraphe.\n\nPuis elle lit.';
  const word = speechWords('Puis elle lit.')[1];
  assert.deepEqual(resolveSpeechHighlightRange({ articleId: 'article', startOffset: 21 }, word), { start: 26, end: 30 });
  assert.equal(text.slice(26, 30), 'elle');
  assert.deepEqual(resolveSpeechHighlightRange({ articleId: 'article', startOffset: 0 }, speechWords(text).at(-1)!), { start: 31, end: 34 });
});

test('invalid or absent DOM offsets cannot become a guessed highlight at the beginning of the article', () => {
  assert.deepEqual(createReadingWordSpeechTarget('article', '0', '4'), { articleId: 'article', startOffset: 0, endOffset: 4 });
  for (const [start, end] of [
    [undefined, '4'], [null, '4'], ['', '4'], [' ', '4'], [true, 4], [{}, 4],
    ['NaN', '4'], ['Infinity', '4'], ['-1', '4'], ['1.5', '4'], ['4', '4'], ['5', '4'],
    ['0', undefined], ['0', ''], ['0', 'Infinity'], [0, Number.MAX_SAFE_INTEGER + 1],
  ]) assert.equal(createReadingWordSpeechTarget('article', start, end), undefined);
  assert.equal(createReadingWordSpeechTarget('', '0', '4'), undefined);
  assert.equal(resolveSpeechHighlightRange({ articleId: 'article', startOffset: 3, endOffset: 2 }, { start: 0, end: 4 }), undefined);
  assert.equal(resolveSpeechHighlightRange({ articleId: 'article', startOffset: -1 }, { start: 0, end: 4 }), undefined);
  assert.equal(resolveSpeechHighlightRange({ articleId: 'article', startOffset: 0 }, { start: 0, end: 0 }), undefined);
});
