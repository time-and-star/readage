import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractLearningUnits,
  extractUniqueLemmas,
  getMinimumExposureDwellMs,
  getNewLemmas,
  hasSufficientExposureVisibility,
  limitConcurrentExposureCandidates,
  shouldAdvanceRecommendationAtScrollEnd,
} from '../src/lib/readingExposure';

test('extracts unique lemmas in first-seen order and filters punctuation', () => {
  assert.deepEqual(
    extractUniqueLemmas("Reading, reading! WELL-being... can't stop; — reading."),
    ['reading', 'well being', "can't", 'stop']
  );
});

test('returns no lemmas for empty or punctuation-only paragraphs', () => {
  assert.deepEqual(extractUniqueLemmas('   ... , — ! ? '), []);
  assert.deepEqual(extractUniqueLemmas(''), []);
});

test('returns only lemmas not already present in the exposed set', () => {
  const exposed = new Set(['reading', 'well being']);

  // Function words like "and" are stop-words and are not tracked by default.
  assert.deepEqual(
    getNewLemmas('Reading helps learners practice reading and reflect.', exposed),
    ['helps', 'learners', 'practice', 'reflect']
  );
});

test('ignores provenance paragraphs containing download URLs', () => {
  assert.deepEqual(
    extractUniqueLemmas(
      'This article was downloaded by zlibrary from https://www.economist.com/asia/a-real-but-selective-crackdown',
    ),
    [],
  );
});

test('deduplicates repeated words within a paragraph and across calls via the set', () => {
  const exposed = new Set<string>();

  const first = getNewLemmas('Practice makes progress. Practice.', exposed);
  first.forEach((lemma) => exposed.add(lemma));

  const second = getNewLemmas('Progress requires patience; practice continues.', exposed);

  assert.deepEqual(first, ['practice', 'makes', 'progress']);
  assert.deepEqual(second, ['requires', 'patience', 'continues']);
});


test('normalizes typographic apostrophes without merging slash-separated words', () => {
  // "i" / "no" are stop-words; content words remain.
  assert.deepEqual(
    extractUniqueLemmas('I can\u2019t choose yes/no ? either works.'),
    ["can't", 'choose', 'yes', 'either', 'works']
  );
});

test('skips function words unless they appear in highlight terms', () => {
  assert.deepEqual(
    extractLearningUnits('A patient reader notices words and continues with confidence.').map(
      (unit) => unit.wordId
    ),
    ['patient', 'reader', 'notices', 'words', 'continues', 'confidence']
  );

  assert.ok(
    extractLearningUnits('Practice over time.', ['over time']).some(
      (unit) => unit.wordId === 'over time'
    )
  );
});

test('uses viewport coverage for paragraphs taller than the viewport', () => {
  assert.equal(hasSufficientExposureVisibility(480, 2000, 800), true);
  assert.equal(hasSufficientExposureVisibility(479, 2000, 800), false);
  assert.equal(hasSufficientExposureVisibility(300, 500, 800), true);
});

test('requires sustained visibility based on paragraph length', () => {
  assert.equal(getMinimumExposureDwellMs('A short paragraph.'), 1200);
  assert.equal(
    getMinimumExposureDwellMs(Array.from({ length: 20 }, () => 'word').join(' ')),
    3000,
  );
  assert.equal(
    getMinimumExposureDwellMs(Array.from({ length: 100 }, () => 'word').join(' ')),
    6000,
  );
});

test('uses one canonical word id for an inflected article occurrence', () => {
  const units = extractLearningUnits('They were chasing the dog that can chase cars.');

  assert.deepEqual(
    units.filter((unit) => unit.wordId === 'chase').map((unit) => unit.wordId),
    ['chase', 'chase'],
  );
  assert.equal(new Set(units.map((unit) => unit.wordId)).has('chasing'), false);
});

test('limits simultaneous exposure timers to a small visible window', () => {
  assert.deepEqual(
    limitConcurrentExposureCandidates(['first', 'second', 'third'], 0),
    ['first', 'second'],
  );
  assert.deepEqual(
    limitConcurrentExposureCandidates(['first', 'second'], 2),
    [],
  );
});

test('allows desktop recommendation progress at document end when the last paragraph remains visible', () => {
  assert.equal(
    shouldAdvanceRecommendationAtScrollEnd(154, 800, 800, 1_600),
    true,
  );
  assert.equal(
    shouldAdvanceRecommendationAtScrollEnd(154, 797, 800, 1_600),
    false,
  );
  assert.equal(
    shouldAdvanceRecommendationAtScrollEnd(0, 800, 800, 800),
    false,
  );
});
