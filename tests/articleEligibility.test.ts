import assert from 'node:assert/strict';
import test from 'node:test';
import { isNonStoryArticleTitle } from '../src/lib/articleEligibility';
import { extractRecommendationLemmas } from '../src/lib/recommendationLearningUnits';
import { isRecommendationArticleWithinBounds, scoreArticlesForReview, RecommendationEngine } from '../src/lib/memoryV2/recommendation';
import { buildCefrRecommendationProfile } from '../src/lib/userReadingProfile';
import type { Article } from '../src/types';

function article(title: string): Article {
  return { id: title, title, description: '', date: '', status: 'In Progress', source: 'magazine',
    level: 'B1', content: ['A target policy appears in each headline.'], keyWords: ['target'] };
}

test('non-story labels do not reject story titles that contain the same words', () => {
  for (const title of ['Magazine Articles', ' CONTENTS ', 'Table\n of contents', 'COVER', 'Masthead', 'Advertisement', 'Advertisements']) {
    assert.equal(isNonStoryArticleTitle(title), true, title);
  }
  for (const title of ['How magazines cover science', 'The contents of a healthy diet', 'Advertisements change cities', 'Magazine articles about art', '', undefined]) {
    assert.equal(isNonStoryArticleTitle(title), false, title);
  }
});

test('directory bodies cannot contribute targets from their lists of headlines', () => {
  assert.deepEqual(extractRecommendationLemmas(article('Magazine Articles')), []);
  assert.ok(extractRecommendationLemmas(article('How magazines cover science')).includes('target'));
});

test('readable directory rows are rejected in review scoring and fallback eligibility', () => {
  const directory = article('Magazine Articles');
  const story = article('How magazines cover science');
  const profile = buildCefrRecommendationProfile('B1');
  for (const mode of ['normal', 'review'] as const) {
    assert.equal(isRecommendationArticleWithinBounds(directory, profile, { mode, checkCefr: false }), false);
    assert.equal(isRecommendationArticleWithinBounds(story, profile, { mode }), true);
  }
  const ranked = scoreArticlesForReview(
    [{ article: directory, lemmas: ['target', 'policy'] }, { article: story, lemmas: ['target'] }],
    ['target', 'policy'], new Map(), new RecommendationEngine({ cefrProfile: profile }),
  );
  assert.deepEqual(ranked.map(row => row.articleId), [story.id]);
});
