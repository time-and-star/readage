import assert from 'node:assert/strict';
import test from 'node:test';
import { createImportedArticle, getArticleLanguage, isEnglishArticle, withImportedLanguage } from '../src/lib/articleLanguage';
import { tokenizeReadingParagraph } from '../src/lib/readingTokens';
import { needsImportEnrichment } from '../src/lib/articleImport';
import { getNextImportedArticle, groupUserLibrary } from '../src/lib/userLibrary';
import { getArticleLearningTerms, getArticleReviewWords } from '../src/lib/readingLearningTerms';

test('Japanese pasted articles retain original prose and skip English enrichment and learning', () => {
  const article = createImportedArticle('今日は図書館で本を読みます。\n\n明日は学校に行きます。', '図書館', 'ja-JP');
  assert.equal(getArticleLanguage(article), 'ja-JP');
  assert.equal(isEnglishArticle(article), false);
  assert.deepEqual(article.content, ['今日は図書館で本を読みます。', '明日は学校に行きます。']);
  assert.equal(article.importEnrichmentStatus, 'ready');
  assert.equal(needsImportEnrichment(article), false);
  assert.deepEqual(getArticleLearningTerms({ ...article, keyWords: ['図書館'] }), []);
  assert.deepEqual(getArticleReviewWords(article, ['図書館']), []);
});

test('Japanese reading produces separate clickable terms and preserves punctuation, whitespace and links', () => {
  const text = ' 今日は図書館で本を読みます。\nカタカナと漢字。📚';
  const tokens = tokenizeReadingParagraph(text, 'ja-JP');
  assert.equal(tokens.map(token => token.value).join(''), text);
  const words = tokens.filter(token => token.type === 'word');
  assert.ok(words.some(token => token.value === '図書館'));
  assert.ok(words.some(token => token.value === '本'));
  assert.ok(words.length > 3);
  assert.deepEqual(words.map(token => token.tokenIndex), words.map((_, index) => index));
  assert.ok(tokens.some(token => token.type === 'text' && token.value.includes('。')));
  const linked = tokenizeReadingParagraph('図書館の[案内ページ](https://example.com)を読む。', 'ja');
  assert.deepEqual(linked.filter(token => token.type === 'link'), [
    { type: 'link', value: '案内ページ', href: 'https://example.com/', tokenIndex: 2 },
  ]);
  assert.equal(linked.map(token => token.value).join(''), '図書館の案内ページを読む。');
});

test('Japanese file imports preserve chapter navigation and have their own library group', () => {
  const base = createImportedArticle('日本語の本文。', '章');
  const english = [0, 1, 2].map(index => ({ ...base, id: `file-abc-${index}`, importBatchId: 'file-abc', importBatchFormat: 'text' as const }));
  const japanese = english.map(article => withImportedLanguage(article, 'ja'));
  assert.equal(japanese[1].id, 'file-ja-abc-1');
  assert.equal(japanese[1].language, 'ja');
  assert.equal(japanese[1].importEnrichmentStatus, 'ready');
  assert.equal(getNextImportedArticle(japanese[0], [japanese[2], japanese[0], japanese[1]])?.id, japanese[1].id);
  assert.equal(groupUserLibrary([...japanese, ...english]).length, 2);
});
