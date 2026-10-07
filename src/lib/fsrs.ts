import {
  createEmptyCard,
  fsrs,
  generatorParameters,
  Rating,
  State,
  type Card,
  type Grade,
  type ReviewLog,
} from 'ts-fsrs';
import type { FsrsMemory, FsrsReviewLog, WordProficiency } from '../types';

export const FSRS_ALGORITHM_VERSION = 'FSRS-6' as const;
export const FSRS_IMPLEMENTATION_VERSION = 'ts-fsrs@5.4.1' as const;
/**
 * SHA-256 of the canonical JSON for every scheduler parameter below, including
 * the 21 FSRS-6 weights supplied by ts-fsrs 5.4.1.
 */
export const FSRS_PARAMETERS_ID =
  'sha256:785b5c8af1c564ff789d975bd226b366a1fdf49380b9fa9f15dd939af126fe87';

/**
 * FSRS-6 parameters used by the app.
 *
 * Short-term scheduler steps are disabled; word cards rehearse forgotten words
 * within the current session without extra long-term review credit. Canonical FSRS
 * scheduler still owns stability, difficulty, due dates, lapses, and review
 * state for every long-term review event.
 */
export const FSRS_PARAMETERS = generatorParameters({
  request_retention: 0.9,
  maximum_interval: 36500,
  enable_fuzz: false,
  enable_short_term: false,
  learning_steps: [],
  relearning_steps: [],
});

const scheduler = fsrs(FSRS_PARAMETERS);
const DAY_MS = 24 * 60 * 60 * 1000;

/** Use the same FSRS-6 curve and weights as review scheduling. */
export function calculateFsrsForgettingCurve(elapsedDays: number, stabilityDays: number): number {
  if (!Number.isFinite(elapsedDays) || !Number.isFinite(stabilityDays) || stabilityDays <= 0) return 0;
  if (elapsedDays <= 0) return 1;
  const retention = scheduler.forgetting_curve(elapsedDays, stabilityDays);
  return Number.isFinite(retention) ? Math.min(1, Math.max(0, retention)) : 0;
}

/** Run the canonical app-wide FSRS scheduler. */
export function scheduleFsrsReview(
  card: Card,
  at: Date,
  rating: Grade,
): { card: Card; log: ReviewLog } {
  return scheduler.next(card, at, rating);
}

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function memoryMetadata(): Pick<
  FsrsMemory,
  'version' | 'algorithm' | 'implementation' | 'parametersId'
> {
  return {
    version: 2,
    algorithm: FSRS_ALGORITHM_VERSION,
    implementation: FSRS_IMPLEMENTATION_VERSION,
    parametersId: FSRS_PARAMETERS_ID,
  };
}

function toPersistedCard(card: Card): FsrsMemory['card'] {
  return {
    due: card.due.toISOString(),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsedDays: card.elapsed_days,
    scheduledDays: card.scheduled_days,
    learningSteps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state,
    ...(card.last_review ? { lastReview: card.last_review.toISOString() } : {}),
  };
}

function toCard(memory: FsrsMemory): Card {
  return {
    due: new Date(memory.card.due),
    stability: finite(memory.card.stability, 0),
    difficulty: finite(memory.card.difficulty, 0),
    elapsed_days: finite(memory.card.elapsedDays, 0),
    scheduled_days: finite(memory.card.scheduledDays, 0),
    learning_steps: finite(memory.card.learningSteps, 0),
    reps: Math.max(0, Math.floor(finite(memory.card.reps, 0))),
    lapses: Math.max(0, Math.floor(finite(memory.card.lapses, 0))),
    state: memory.card.state as State,
    ...(memory.card.lastReview ? { last_review: new Date(memory.card.lastReview) } : {}),
  };
}

function toPersistedLog(log: ReviewLog): FsrsReviewLog {
  return {
    rating: log.rating,
    state: log.state,
    due: log.due.toISOString(),
    stability: log.stability,
    difficulty: log.difficulty,
    elapsedDays: log.elapsed_days,
    lastElapsedDays: log.last_elapsed_days,
    scheduledDays: log.scheduled_days,
    learningSteps: log.learning_steps,
    review: log.review.toISOString(),
  };
}

export function createFsrsMemory(at = new Date()): FsrsMemory {
  if (!Number.isFinite(at.getTime())) throw new TypeError('Cannot create FSRS memory at an invalid date');
  return {
    ...memoryMetadata(),
    historyStartReps: 0,
    card: toPersistedCard(createEmptyCard(at)),
    reviews: [],
    isIntroduced: false,
  };
}

export function reviewFsrsMemory(
  memory: FsrsMemory,
  rating: Grade,
  at = new Date()
): FsrsMemory {
  if (!isValidFsrsMemory(memory)) {
    throw new TypeError('Cannot review malformed FSRS memory');
  }
  if (!isGrade(rating)) {
    throw new TypeError('Cannot review FSRS memory with an invalid rating');
  }
  if (!Number.isFinite(at.getTime())) {
    throw new TypeError('Cannot review FSRS memory at an invalid date');
  }
  if (memory.card.lastReview && at.getTime() < Date.parse(memory.card.lastReview)) {
    throw new RangeError('Cannot review FSRS memory earlier than the previous review');
  }

  const result = scheduleFsrsReview(toCard(memory), at, rating);
  return {
    ...memoryMetadata(),
    historyStartReps: memory.historyStartReps,
    card: toPersistedCard(result.card),
    // Keep every review after the explicit migration baseline. Never truncate
    // this array without moving storage to a reconstructable durable store.
    reviews: [...memory.reviews, toPersistedLog(result.log)],
    isIntroduced: true,
    lastRating: rating,
  };
}

export function getFsrsRetrievability(memory: FsrsMemory, at = new Date()): number {
  if (!isValidFsrsMemory(memory)) {
    throw new TypeError('Cannot calculate retrievability from malformed FSRS memory');
  }
  if (!Number.isFinite(at.getTime())) {
    throw new TypeError('Cannot calculate retrievability at an invalid date');
  }
  return scheduler.get_retrievability(toCard(memory), at, false);
}

export function getFsrsCardDue(memory: FsrsMemory): number {
  if (!isValidFsrsMemory(memory)) {
    throw new TypeError('Cannot read due date from malformed FSRS memory');
  }
  return Date.parse(memory.card.due);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isValidDateString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return isNonNegativeFinite(value) && Number.isInteger(value);
}

function isState(value: unknown): value is State {
  return value === State.New
    || value === State.Learning
    || value === State.Review
    || value === State.Relearning;
}

function isGrade(value: unknown): value is Grade {
  return value === Rating.Again
    || value === Rating.Hard
    || value === Rating.Good
    || value === Rating.Easy;
}

function isValidCard(value: unknown): value is FsrsMemory['card'] {
  if (!isRecord(value)) return false;
  if (!isValidDateString(value.due)
    || !isNonNegativeFinite(value.stability)
    || !isNonNegativeFinite(value.difficulty)
    || !isNonNegativeFinite(value.elapsedDays)
    || !isNonNegativeFinite(value.scheduledDays)
    || !isNonNegativeInteger(value.learningSteps)
    || !isNonNegativeInteger(value.reps)
    || !isNonNegativeInteger(value.lapses)
    || !isState(value.state)) return false;
  if (value.lastReview !== undefined && !isValidDateString(value.lastReview)) return false;
  if (value.difficulty > 10 || value.lapses > value.reps) return false;
  if (value.state === State.New) {
    return value.reps === 0
      && value.lapses === 0
      && value.stability === 0
      && value.difficulty === 0
      && value.elapsedDays === 0
      && value.scheduledDays === 0
      && value.learningSteps === 0
      && value.lastReview === undefined;
  }
  return value.reps > 0
    && value.stability > 0
    && value.difficulty >= 1
    && isValidDateString(value.lastReview);
}

function isValidReviewLog(value: unknown): value is FsrsReviewLog {
  if (!isRecord(value)) return false;
  return isGrade(value.rating)
    && isState(value.state)
    && isValidDateString(value.due)
    && isNonNegativeFinite(value.stability)
    && isNonNegativeFinite(value.difficulty)
    && value.difficulty <= 10
    && isNonNegativeFinite(value.elapsedDays)
    && isNonNegativeFinite(value.lastElapsedDays)
    && isNonNegativeFinite(value.scheduledDays)
    && isNonNegativeInteger(value.learningSteps)
    && isValidDateString(value.review);
}

function hasChronologicalReviews(reviews: FsrsReviewLog[]): boolean {
  for (let index = 1; index < reviews.length; index += 1) {
    if (Date.parse(reviews[index].review) < Date.parse(reviews[index - 1].review)) return false;
  }
  return true;
}

function hasConsistentReviewTail(
  card: FsrsMemory['card'],
  reviews: FsrsReviewLog[],
  lastRating: unknown
): boolean {
  if (card.reps === 0) return reviews.length === 0 && lastRating === undefined;
  if (!isGrade(lastRating)) return false;
  if (reviews.length === 0) return true;
  const latest = reviews[reviews.length - 1];
  return latest.rating === lastRating && latest.review === card.lastReview;
}

function isValidV1FsrsMemory(value: unknown): value is {
  version: 1;
  card: FsrsMemory['card'];
  reviews: FsrsReviewLog[];
  isIntroduced: boolean;
  lastRating?: number;
} {
  if (!isRecord(value)
    || value.version !== 1
    || !isValidCard(value.card)
    || !Array.isArray(value.reviews)
    || !value.reviews.every(isValidReviewLog)
    || typeof value.isIntroduced !== 'boolean'
    || (value.lastRating !== undefined && !isGrade(value.lastRating))) return false;

  const card = value.card;
  const reviews = value.reviews;
  if (card.reps > 0 && !value.isIntroduced) return false;
  if (reviews.length > card.reps || !hasChronologicalReviews(reviews)) return false;
  return hasConsistentReviewTail(card, reviews, value.lastRating);
}

export function isValidFsrsMemory(value: unknown): value is FsrsMemory {
  if (!isRecord(value)
    || value.version !== 2
    || value.algorithm !== FSRS_ALGORITHM_VERSION
    || value.implementation !== FSRS_IMPLEMENTATION_VERSION
    || value.parametersId !== FSRS_PARAMETERS_ID
    || !isNonNegativeInteger(value.historyStartReps)
    || !isValidCard(value.card)
    || !Array.isArray(value.reviews)
    || !value.reviews.every(isValidReviewLog)
    || typeof value.isIntroduced !== 'boolean'
    || (value.lastRating !== undefined && !isGrade(value.lastRating))) return false;

  const card = value.card;
  const reviews = value.reviews;
  if (card.reps > 0 && !value.isIntroduced) return false;
  if (value.historyStartReps + reviews.length !== card.reps) return false;
  if (card.reps === 0 && value.historyStartReps !== 0) return false;
  if (!hasChronologicalReviews(reviews)) return false;
  return hasConsistentReviewTail(card, reviews, value.lastRating);
}

/** Upgrade the previous schema while preserving its known/unknown history boundary. */
export function upgradeFsrsMemory(value: unknown): FsrsMemory | null {
  if (isValidFsrsMemory(value)) return value;
  if (!isValidV1FsrsMemory(value)) return null;

  const upgraded: FsrsMemory = {
    ...memoryMetadata(),
    historyStartReps: value.card.reps - value.reviews.length,
    card: value.card,
    reviews: value.reviews,
    isIntroduced: value.isIntroduced,
    ...(value.lastRating !== undefined ? { lastRating: value.lastRating } : {}),
  };
  return isValidFsrsMemory(upgraded) ? upgraded : null;
}

/**
 * Convert the former proficiency record into a valid FSRS card without
 * throwing away its existing due date or stability estimate. Passive article
 * exposures are intentionally not represented as FSRS repetitions.
 */
export function migrateLegacyFsrsMemory(
  proficiency: Pick<WordProficiency, 'level' | 'stabilityDays' | 'lastReviewedAt' | 'nextReviewDue' | 'exposureCount'>,
  at = new Date()
): FsrsMemory {
  if (!Number.isFinite(at.getTime())) {
    throw new TypeError('Cannot migrate FSRS memory at an invalid date');
  }
  // L0 only contains passive exposure evidence. It has never had an FSRS review,
  // so reconstruct the canonical empty card instead of fabricating repetitions.
  if (proficiency.level <= 0) return createFsrsMemory(at);

  const lastReview = Date.parse(proficiency.lastReviewedAt);
  const due = Date.parse(proficiency.nextReviewDue);
  const stability = Math.max(0.1, finite(proficiency.stabilityDays, 0.1));
  const lastReviewAt = Number.isFinite(lastReview) ? new Date(lastReview) : at;
  const dueAt = Number.isFinite(due) ? new Date(due) : at;
  const elapsedDays = Math.max(0, (at.getTime() - lastReviewAt.getTime()) / DAY_MS);
  const scheduledDays = Math.max(0, (dueAt.getTime() - lastReviewAt.getTime()) / DAY_MS);
  const difficulty = proficiency.level >= 4
    ? 2.5
    : proficiency.level >= 3
      ? 4
      : proficiency.level >= 2
        ? 6
        : 7;

  return {
    ...memoryMetadata(),
    // The old record proves one aggregate review state but contains no log for
    // it. Mark that boundary explicitly instead of pretending history is absent.
    historyStartReps: 1,
    card: {
      due: dueAt.toISOString(),
      stability,
      difficulty,
      elapsedDays,
      scheduledDays,
      learningSteps: 0,
      reps: 1,
      lapses: 0,
      state: State.Review,
      lastReview: lastReviewAt.toISOString(),
    },
    reviews: [],
    isIntroduced: true,
    lastRating: proficiency.level <= 1
      ? Rating.Again
      : proficiency.level >= 4
        ? Rating.Easy
        : Rating.Good,
  };
}

export function ensureFsrsMemory(
  proficiency: Pick<WordProficiency, 'fsrs' | 'level' | 'stabilityDays' | 'lastReviewedAt' | 'nextReviewDue' | 'exposureCount'>,
  at = new Date()
): FsrsMemory {
  return upgradeFsrsMemory(proficiency.fsrs)
    ?? migrateLegacyFsrsMemory(proficiency, at);
}
