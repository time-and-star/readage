import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { RecommendationEntryScreen } from '../src/components/RecommendationEntryScreen';
import { getArticleOnlyRecommendationDefaults } from '../src/lib/recommendationEntry';

test('uses an unassessed cold-start profile for article-only recommendations', () => {
  const defaults = getArticleOnlyRecommendationDefaults();

  assert.equal(defaults.userLevel, 'B1');
  assert.equal(defaults.cefrProfile.useLevelFilter, false);
  assert.equal(defaults.cefrProfile.confidence, 'low');
});

test('keeps comprehension assessment out of the recommendation entry', () => {
  const html = renderToStaticMarkup(React.createElement(RecommendationEntryScreen, {
    isLoading: false,
    phase: null,
    feedEnded: false,
    onStartRecommendation: () => undefined,
    onOpenLibrary: () => undefined,
    onBack: () => undefined,
    navigation: null,
  }));

  assert.doesNotMatch(html, /Check reading level/);
});

test('describes the landing action as starting article reading', () => {
  const source = readFileSync(
    new URL('../src/components/LandingPage.tsx', import.meta.url),
    'utf8',
  );

  assert.match(source, /aria-label="Start article reading"/);
  assert.doesNotMatch(source, /reading level assessment/);
});

test('does not load or persist retired English test results', () => {
  const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /ReadingAssessmentScreen|assessmentResult|readingAssessment|onStartEnglishTest/);
  assert.match(source, /getArticleOnlyRecommendationDefaults\(readingPreference.level\)/);
});
