import assert from 'node:assert/strict';
import test from 'node:test';
import { createImportedArticle, getArticleLanguage, isEnglishArticle, withImportedLanguage } from '../src/lib/articleLanguage';
import { tokenizeReadingParagraph } from '../src/lib/readingTokens';
import { getArticleLearningTerms, getArticleReviewWords } from '../src/lib/readingLearningTerms';
import { needsImportEnrichment } from '../src/lib/articleImport';
import { buildRecommendationArticlePool } from '../src/lib/magazineRecommendationPool';
import { getNextImportedArticle, groupUserLibrary } from '../src/lib/userLibrary';
import { selectSpeechVoice } from '../src/lib/speech';

test('French imports retain their declared language and do not enter English enrichment or learning', () => {
  const french = createImportedArticle('Les chevaux mangent des pommes.\n\nL’école est ouverte.', 'Une promenade', 'fr');
  assert.equal(getArticleLanguage(french), 'fr');
  assert.deepEqual(french.content, ['Les chevaux mangent des pommes.', 'L’école est ouverte.']);
  assert.equal(needsImportEnrichment(french), false);
  assert.equal(needsImportEnrichment({ ...french, language: undefined }), true);
  assert.equal(isEnglishArticle({}), true);
  assert.equal(isEnglishArticle({ language: 'fr-FR' }), false);
  assert.equal(isEnglishArticle({ language: 'invalid_language' }), false);
  assert.deepEqual(getArticleLearningTerms({ ...french, keyWords: ['mangent'] }), []);
  assert.deepEqual(getArticleReviewWords(french, ['manger']), []);
  const english = createImportedArticle('The horses eat apples.', 'English');
  assert.deepEqual(buildRecommendationArticlePool([], [], [french, english]).map(article => article.id), [english.id]);
});

test('French reading preserves apostrophes, accents, spaces and independent clickable words', () => {
  const text = 'Aujourd’hui, l’homme regarde les chevaux près de l’école.';
  const tokens = tokenizeReadingParagraph(text, 'fr-FR');
  assert.equal(tokens.map(token => token.value).join(''), text);
  assert.deepEqual(tokens.filter(token => token.type === 'word').map(token => token.value),
    ['Aujourd’hui', 'homme', 'regarde', 'les', 'chevaux', 'près', 'de', 'école']);
  const markdown = tokenizeReadingParagraph('Les [deux chevaux](https://example.com) mangent.', 'fr');
  assert.deepEqual(markdown.filter(token => token.type !== 'text').map(token => token.value), ['Les', 'deux chevaux', 'mangent']);
});

test('declaring a file language preserves chapter order and keeps different language imports on separate shelves', () => {
  const base = createImportedArticle('Bonjour.', 'Chapitre');
  const english = [0, 1, 2].map(index => ({ ...base, id: `file-abc-${index}`, importBatchId: 'file-abc', importBatchFormat: 'text' as const }));
  const french = english.map(article => withImportedLanguage(article, 'fr'));
  assert.equal(french[1].id, 'file-fr-abc-1');
  assert.equal(getNextImportedArticle(french[0], [french[2], french[0], french[1]])?.id, french[1].id);
  assert.equal(groupUserLibrary([...french, ...english]).length, 2);
  assert.equal(withImportedLanguage(english[0], 'en').id, english[0].id);
});

test('voice selection never substitutes an English voice for French', () => {
  const voices = [{ name: 'English', lang: 'en-US', default: true }, { name: 'French', lang: 'fr-FR', default: false }] as SpeechSynthesisVoice[];
  assert.equal(selectSpeechVoice(voices, 'fr-FR')?.name, 'French');
  assert.equal(selectSpeechVoice(voices.slice(0, 1), 'fr-FR'), undefined);
});
