import test from 'node:test';
import assert from 'node:assert/strict';
import { Rating, State } from 'ts-fsrs';
import type { ReviewWord, WordProficiency } from '../src/types';
import {
  applyAvoidance,
  applyClickLookup,
  applyExposures,
  applyGrammarQuery,
  applyIncorrectUse,
  applyMastered,
  applyProductionUse,
  findAvoidedTargetWords,
  getDueLemmas,
  getEffectiveProficiency,
  getRetentionStrength,
  isReviewDue,
  migrateProficiencyMap,
  seedFromReviewWords,
  textContainsLemma,
  toLemma,
} from '../src/lib/proficiency';

const DAY = 24 * 60 * 60 * 1000;
const start = new Date('2026-07-23T00:00:00.000Z');

function reviewWord(word: string): ReviewWord {
  return {
    id: `word-${word}`,
    word,
    phonetic: '',
    definition: 'test',
    exampleSentence: 'test',
    mastered: false,
    nextReviewDate: 'Today',
  };
}

test('passive exposure stays L0 until the third exposure, then introduces a due FSRS card without faking recall', () => {
  let map = applyExposures({}, ['ambient'], start);
  assert.equal(map.ambient.level, 0);
  assert.equal(map.ambient.fsrs?.reviews.length, 0);
  assert.deepEqual(getDueLemmas(map, start), []);

  map = applyExposures(map, ['ambient'], new Date(start.getTime() + 1000));
  assert.equal(map.ambient.level, 0);

  map = applyExposures(map, ['ambient'], new Date(start.getTime() + 2000));
  assert.equal(map.ambient.level, 1);
  assert.equal(map.ambient.fsrs?.isIntroduced, true);
  assert.equal(map.ambient.fsrs?.card.reps, 0);
  assert.equal(map.ambient.fsrs?.lastRating, undefined);
  assert.equal(map.ambient.fsrs?.reviews.length, 0);

  const due = Date.parse(map.ambient.fsrs!.card.due);
  assert.equal(due, start.getTime() + 2000);
  assert.deepEqual(getDueLemmas(map, new Date(due - 1)), []);
  assert.deepEqual(getDueLemmas(map, new Date(due)), ['ambient']);
});

test('FSRS retrievability decays after a successful review and controls the due timestamp', () => {
  let map = seedFromReviewWords([reviewWord('ephemeral')], start);
  assert.deepEqual(getDueLemmas(map, start), ['ephemeral']);

  map = applyProductionUse(map, 'ephemeral', 0.2, start);
  const word = map.ephemeral;
  const due = new Date(word.fsrs!.card.due);

  assert.ok(getRetentionStrength(word, due) < getRetentionStrength(word, start));
  assert.equal(isReviewDue(word, new Date(due.getTime() - 1)), false);
  assert.equal(isReviewDue(word, due), true);
});

test('production matching respects word and phrase boundaries', () => {
  let map = seedFromReviewWords([reviewWord('art'), reviewWord('break a leg')], start);
  map = applyProductionUse(map, 'I read an article.', 0.1, start);
  assert.equal(map.art.productionScore, 0.1);

  map = applyProductionUse(map, 'Before the show I said break a leg.', 0.1, start);
  assert.equal(map['break a leg'].productionScore, 0.2);
});

test('negative evidence is translated to canonical FSRS ratings', () => {
  const practiced = applyProductionUse(
    seedFromReviewWords([reviewWord('resilient')], start),
    'resilient',
    0.4,
    start
  ).resilient;
  assert.equal(practiced.fsrs?.lastRating, Rating.Good);
  const due = new Date(practiced.fsrs!.card.due);

  const incorrect = applyIncorrectUse({ resilient: practiced }, ['resilient'], due).resilient;
  const avoided = applyAvoidance({ resilient: practiced }, ['resilient'], due).resilient;
  const queried = applyGrammarQuery({ resilient: practiced }, 'resilient', due).resilient;

  assert.equal(incorrect.fsrs?.lastRating, Rating.Again);
  assert.equal(incorrect.level, 1);
  assert.equal(queried.fsrs?.lastRating, Rating.Again);
  assert.equal(queried.level, 1);
  assert.equal(avoided.fsrs?.lastRating, Rating.Again);
  assert.equal(avoided.level, 1);
  assert.ok(avoided.productionScore > incorrect.productionScore, 'avoidance has a smaller production penalty');
  assert.equal(avoided.fsrs?.card.due, incorrect.fsrs?.card.due);
});

test('avoidance is only detected for substantive explicit-target output', () => {
  assert.deepEqual(findAvoidedTargetWords('Why?', ['ephemeral']), []);
  assert.deepEqual(
    findAvoidedTargetWords('I enjoyed the article and explained the main idea.', ['ephemeral', 'main idea']),
    ['ephemeral']
  );
});

test('a lookup remains L1 until a later positive recall is observed', () => {
  let map = applyExposures({}, ['opaque'], start);
  map = applyExposures(map, ['opaque'], new Date(start.getTime() + 1000));
  map = applyExposures(map, ['opaque'], new Date(start.getTime() + 2000));
  assert.equal(map.opaque.level, 1);

  map = applyClickLookup(map, 'opaque', new Date(start.getTime() + 3000));
  assert.equal(map.opaque.level, 1);
  assert.equal(map.opaque.fsrs?.lastRating, Rating.Again);

  const due = new Date(map.opaque.fsrs!.card.due);
  map = applyExposures(map, ['opaque'], new Date(due.getTime() - 1));
  assert.equal(map.opaque.level, 1);
  assert.equal(map.opaque.fsrs?.lastRating, Rating.Again);

  map = applyExposures(map, ['opaque'], due);
  assert.equal(map.opaque.fsrs?.lastRating, Rating.Again);
  assert.equal(map.opaque.level, 1);

  map = applyProductionUse(map, 'opaque', 0.1, due);
  assert.equal(map.opaque.fsrs?.lastRating, Rating.Good);
  assert.equal(map.opaque.level, 2);
});

test('production thresholds are applied to live FSRS retrievability', () => {
  const base = seedFromReviewWords([reviewWord('threshold')], start);
  const l3 = applyProductionUse(base, 'threshold', 0.2, start).threshold;
  const l4 = applyProductionUse(base, 'threshold', 0.6, start).threshold;
  const belowL3 = applyProductionUse(base, 'threshold', 0.199, start).threshold;

  assert.equal(getEffectiveProficiency(l3, start).level, 3);
  assert.equal(getEffectiveProficiency(l4, start).level, 4);
  assert.equal(getEffectiveProficiency(belowL3, start).level, 2);

  const forgotten = getEffectiveProficiency(
    l4,
    new Date(start.getTime() + 30 * l4.fsrs!.card.stability * DAY)
  );
  assert.ok(forgotten.recognitionScore < 0.6);
  assert.equal(forgotten.level, 2);
});

test('normalizes typographic apostrophes and does not match phrases across punctuation', () => {
  assert.equal(toLemma('can\u2019t'), "can't");
  assert.equal(textContainsLemma('Before the show, I said break a leg.', 'break a leg'), true);
  assert.equal(textContainsLemma('I need a break. A leg hurts.', 'break a leg'), false);
  assert.equal(textContainsLemma('Take a break / a leg stretch.', 'break a leg'), false);
  assert.equal(textContainsLemma('Take a break \u2014 a leg stretch.', 'break a leg'), false);
});

test('canonicalizes a conservative inflected form without changing phrase boundaries', () => {
  assert.equal(toLemma('chasing'), 'chase');
  assert.equal(toLemma('Chased'), 'chase');
  assert.equal(toLemma('chases'), 'chase');
  assert.equal(toLemma('break a leg'), 'break a leg');
  assert.equal(toLemma('well-being'), 'well being');
});

test('manual mastery uses Easy and later becomes due under FSRS', () => {
  const map = seedFromReviewWords([reviewWord('durable')], start);
  const mastered = applyMastered(map, 'durable', start).durable;

  assert.equal(mastered.fsrs?.lastRating, Rating.Easy);
  assert.equal(getEffectiveProficiency(mastered, start).level, 4);
  assert.equal(isReviewDue(mastered, new Date(Date.parse(mastered.fsrs!.card.due) - 1)), false);
  assert.equal(isReviewDue(mastered, new Date(mastered.fsrs!.card.due)), true);
});

test('legacy records migrate once and preserve their scheduling evidence', () => {
  const legacy: WordProficiency = {
    lemma: 'legacy',
    level: 4,
    recognitionScore: 0.85,
    productionScore: 0.75,
    stabilityDays: 30,
    lastReviewedAt: start.toISOString(),
    nextReviewDue: new Date(start.getTime() + 30 * DAY).toISOString(),
    exposureCount: 10,
  };

  const migrated = migrateProficiencyMap({ legacy }, start);
  assert.ok(migrated.legacy.fsrs);
  assert.equal(migrated.legacy.fsrs?.card.stability, 30);
  assert.equal(migrated.legacy.fsrs?.card.due, legacy.nextReviewDue);
  assert.equal(migrated.legacy.fsrs?.card.reps, 1, 'article exposures are not fabricated as FSRS reviews');
  assert.equal(migrateProficiencyMap(migrated, start), migrated, 'already migrated maps retain identity');
});


test('legacy L0 passive exposures remain a new FSRS card after migration', () => {
  const legacy: WordProficiency = {
    lemma: 'unintroduced',
    level: 0,
    recognitionScore: 0.1,
    productionScore: 0,
    stabilityDays: 0.1,
    lastReviewedAt: start.toISOString(),
    nextReviewDue: '',
    exposureCount: 2,
  };

  const migrated = migrateProficiencyMap({ unintroduced: legacy }, start).unintroduced;
  assert.equal(migrated.fsrs?.card.state, State.New);
  assert.equal(migrated.fsrs?.card.reps, 0);
  assert.equal(migrated.fsrs?.isIntroduced, false);
  assert.equal(getEffectiveProficiency(migrated, start).level, 0);
});


test('deduplicates identical FSRS ratings inside the interaction window', () => {
  const base = seedFromReviewWords([reviewWord('duplicate')], start);
  const first = applyClickLookup(base, 'duplicate', start).duplicate;
  const duplicate = applyClickLookup(
    { duplicate: first },
    'duplicate',
    new Date(start.getTime() + 5_000)
  ).duplicate;
  const later = applyClickLookup(
    { duplicate: duplicate },
    'duplicate',
    new Date(start.getTime() + 10_000)
  ).duplicate;

  assert.equal(first.fsrs?.reviews.length, 1);
  assert.equal(duplicate.fsrs?.reviews.length, 1);
  assert.equal(duplicate.fsrs?.card.reps, first.fsrs?.card.reps);
  assert.equal(later.fsrs?.reviews.length, 2);
});

test('does not deduplicate a different rating in the interaction window', () => {
  const base = seedFromReviewWords([reviewWord('recover')], start);
  const failed = applyClickLookup(base, 'recover', start);
  const recovered = applyProductionUse(
    failed,
    'recover',
    0.1,
    new Date(start.getTime() + 5_000)
  ).recover;

  assert.equal(recovered.fsrs?.reviews.length, 2);
  assert.equal(recovered.fsrs?.lastRating, Rating.Good);
});

test('proficiency migration rejects invalid roots and skips malformed records', () => {
  const fallback = seedFromReviewWords([reviewWord('fallback')], start);
  assert.equal(migrateProficiencyMap(null, start, fallback), fallback);
  assert.equal(migrateProficiencyMap([], start, fallback), fallback);

  const migrated = migrateProficiencyMap({
    bad: {},
    valid: {
      lemma: 'valid',
      level: 0,
      recognitionScore: 0,
      productionScore: 0,
      stabilityDays: 0,
      lastReviewedAt: start.toISOString(),
      nextReviewDue: '',
      exposureCount: 1,
    },
  }, start, fallback);

  assert.deepEqual(Object.keys(migrated), ['valid']);
  assert.equal(migrated.valid.fsrs?.version, 2);
});
