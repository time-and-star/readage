import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import type { Article } from '../src/types';
import type { RecommendedArticleCandidate } from '../src/lib/articleValidation';
import { buildLevelRewriteArticle } from '../src/lib/rewriteArticle';
register('./helpers/style-loader.mjs', import.meta.url);
const { getArticleHighlightTerms } = await import('../src/components/ReadingScreen');

function sourceArticle(): Article {
  return {
    id: 'source-article',
    title: 'Original article',
    description: 'Original description',
    date: 'Jul 25, 2026',
    status: 'In Progress',
    content: ['Original paragraph.'],
    topic: 'Technology',
    embeddedReviewWords: ['old review word'],
  };
}

const candidate: RecommendedArticleCandidate = {
  title: 'A new article',
  description: 'A standalone rewrite.',
  paragraphs: ['The rewritten paragraph.', 'Another rewritten paragraph.'],
  keyWords: ['rewritten'],
};

test('buildLevelRewriteArticle creates an ordinary independent article without rewrite UI metadata', () => {
  const article = buildLevelRewriteArticle({
    sourceArticle: sourceArticle(),
    candidate,
    targetLevel: 'A2',
    levelRating: {
      level: 'A2',
      difficultyScore: 28,
      summary: 'A2 rewrite.',
    },
    id: 'rewrite-article',
    date: 'Jul 25, 2026',
  });

  assert.equal(article.source, 'user_input');
  assert.deepEqual(article.content, candidate.paragraphs);
  assert.equal(article.keyWords, undefined);
  assert.equal(article.embeddedReviewWords, undefined);
  assert.equal(article.parentArticleId, undefined);
  assert.equal(article.parentArticleTitle, undefined);
  assert.equal(article.rewriteTargetLevel, undefined);
  assert.equal(article.generatedFromArticleId, 'source-article');
  assert.equal(article.generatedFromArticleTitle, 'Original article');
});

test('legacy rewrites do not render persisted keywords as highlighted terms', () => {
  const legacyRewrite: Article = {
    ...sourceArticle(),
    source: 'level_rewrite',
    keyWords: ['Silicon Valley'],
  };

  assert.deepEqual(getArticleHighlightTerms(legacyRewrite), []);
});
