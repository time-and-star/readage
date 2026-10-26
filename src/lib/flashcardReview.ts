import type { Grade } from 'ts-fsrs';
import type { MemoryV2Store } from './memoryV2/memoryStore';
import type { FlashcardRecallEvidence, WordMemoryState } from './memoryV2/types';
import { getLocalDateInTimeZone } from './memoryV2/dateUtils';
import { submitFsrsReview } from './memoryV2/fsrsIntegration';
import { createWordLearningStatusProjector } from './memoryV2/wordProficiency';
import { selectCanonicalMemoryState } from './memoryV2/wordIdentity';
import type { FlashcardStudyPreferences } from './flashcardPreferences';
import { createFlashcardSchedulingPolicy, type FlashcardSchedulingPolicy } from './flashcardScheduling';
import { projectUnratedFlashcardPractice } from './flashcardPractice';

export type FlashcardRating = 'again' | 'hard' | 'good' | 'easy';
const ratings: Record<FlashcardRating, 1 | 2 | 3 | 4> = { again: 1, hard: 2, good: 3, easy: 4 };

export interface FlashcardQueueCard {
  /** Save to the existing memory identity; a display alias never creates a second card. */
  wordId: string;
  canonicalWordId: string;
  state: WordMemoryState;
  kind: 'due' | 'new' | 'learning' | 'relearning';
  contextTexts: string[];
  nextReview: string;
  isPractice: boolean;
}

export interface FlashcardQueue {
  cards: FlashcardQueueCard[];
  /** Total eligible cards, before this session's review limit. */
  dueCount: number;
  newCount: number;
  /** Complete unintroduced word pool, independent of today's new-word allowance. */
  remainingNewCount: number;
  newIntroducedToday: number;
  nextDueAt: string | null;
  /** Active short-term cards, including due cards; each canonical word counts once. */
  learningCount: number;
  /** Short-term cards waiting for their persisted due time, not completed words. */
  pendingLearningCount: number;
  nextLearningDueAt: string | null;
}

const limit = (value: number | undefined, fallback: number) => Number.isFinite(value)
  ? Math.max(0, Math.floor(value!)) : fallback;
const reviewAt = (state: WordMemoryState) => Date.parse(state.fsrsReviews.at(-1)?.review ?? state.lastReview ?? '') || 0;

/** Product answer-exposure boundary; this is not a claim of long-term retention. */
export const FLASHCARD_ANSWER_REHEARSAL_WINDOW_MS = 60_000;

export function classifyFlashcardRecallEvidence({ answerExposedAt, interveningWord, now = new Date() }: {
  answerExposedAt?: string; interveningWord?: string; now?: Date;
}): FlashcardRecallEvidence {
  if (!Number.isFinite(now.getTime())) throw new TypeError('Invalid recall evidence date');
  const exposedAt = Date.parse(answerExposedAt ?? '');
  if (answerExposedAt !== undefined && !Number.isFinite(exposedAt)) throw new TypeError('Invalid answer exposure date');
  const immediate = Number.isFinite(exposedAt) && !interveningWord
    && now.getTime() - exposedAt < FLASHCARD_ANSWER_REHEARSAL_WINDOW_MS;
  return { kind: immediate ? 'answer_rehearsal' : 'independent_recall',
    ...(answerExposedAt ? { answerExposedAt } : {}), ...(interveningWord ? { interveningWord } : {}) };
}

/** Excluded lookups may not yet have a state; their saved aliases still need canonical identities. */
export function getFlashcardIdentityWordIds(states: readonly WordMemoryState[], preferences: FlashcardStudyPreferences): string[] {
  return [...new Set([...states.map(state => state.wordId), ...preferences.importedWordIds,
    ...preferences.pausedWordIds ?? [], ...preferences.excludedWordIds ?? []])];
}

/** The manager shows enrolled/queried/recalled words, rather than every incidental reading exposure. */
export function getManagedFlashcardWordIds(states: readonly WordMemoryState[], preferences: FlashcardStudyPreferences,
  canonicalWordIds: ReadonlyMap<string, string>): string[] {
  const registered = new Set([...preferences.importedWordIds, ...preferences.pausedWordIds ?? [], ...preferences.excludedWordIds ?? []]);
  const projectLearning = createWordLearningStatusProjector(preferences);
  return [...new Set([...registered, ...states.filter(state => {
    const learning = projectLearning(state, canonicalWordIds.get(state.wordId) ?? state.wordId);
    return learning.hasRecall || learning.hasLookup || learning.isEnrolled || projectUnratedFlashcardPractice(state) !== null
      || registered.has(state.wordId) || registered.has(canonicalWordIds.get(state.wordId) ?? state.wordId);
  }).map(state => state.wordId)]
    .map(word => canonicalWordIds.get(word) ?? word))].sort((a, b) => a.localeCompare(b));
}

/** Product spacing in completed other-word answers, separate from the persisted FSRS due. */
export function getFlashcardRehearsalGap(state: WordMemoryState): number | null {
  const practice = projectUnratedFlashcardPractice(state);
  if (practice?.phase === 'confirmation') return null;
  if (!practice && state.fsrsCard.state !== 1 && state.fsrsCard.state !== 3) return null;
  const latest = state.fsrsReviews.filter(review => review.source !== 'reading_lookup').at(-1);
  if (!latest?.scheduling || latest.scheduling.version < 4) return null;
  return latest.rating === 1 ? 3 : latest.rating === 2 ? 5 : 8;
}

function rehearsalRound(state: WordMemoryState): number {
  const practice = projectUnratedFlashcardPractice(state);
  if (practice) return practice.phase === 'learning' ? Math.max(1, practice.attemptCount) : 0;
  if (getFlashcardRehearsalGap(state) === null) return 0;
  const attempts = new Set<string>();
  let count = 0;
  for (const [index, review] of state.fsrsReviews.entries()) {
    if (review.source === 'reading_lookup') continue;
    if (review.state === 0 || review.state === 2) { count = 0; attempts.clear(); }
    if (review.source !== 'flashcard' && !review.scheduling) continue;
    const ids = review.verificationAttemptIds?.length ? review.verificationAttemptIds : [`log:${index}`];
    if (ids.some(id => attempts.has(id))) continue;
    ids.forEach(id => attempts.add(id));
    count += 1;
  }
  return Math.max(1, count);
}

/** Promote a ready repetition without making it wait for the whole new-word pool. */
function orderFlashcardRepetitions(cards: FlashcardQueueCard[],
  owners: readonly { canonicalWordId: string; state: WordMemoryState }[], now: Date): FlashcardQueueCard[] {
  if (cards.length < 2) return cards;
  const attempts: { word: string; at: number }[] = [];
  for (const { canonicalWordId, state } of owners) {
    const seen = new Set<string>();
    for (const review of state.fsrsReviews) {
      if (review.source !== 'flashcard') continue;
      const at = Date.parse(review.review);
      if (!Number.isFinite(at) || at > now.getTime()) continue;
      const ids = review.verificationAttemptIds?.length ? review.verificationAttemptIds
        : [`legacy:${review.review}:${review.rating}`];
      if (ids.some(id => seen.has(id))) continue;
      ids.forEach(id => seen.add(id));
      attempts.push({ word: canonicalWordId, at });
    }
  }
  attempts.sort((left, right) => right.at - left.at);
  const ready = new Set<FlashcardQueueCard>();
  for (const card of cards) {
    const gap = getFlashcardRehearsalGap(card.state);
    if (gap === null) continue;
    const last = card.state.fsrsReviews.filter(review => review.source !== 'reading_lookup').at(-1);
    const answeredAt = Date.parse(last?.review ?? '');
    let remaining = Math.min(gap, cards.length - 1);
    for (const attempt of attempts) {
      // Equal timestamps cannot prove an intervening answer; retain the fair round fallback.
      if (attempt.at <= answeredAt || !Number.isFinite(answeredAt)) break;
      if (attempt.word !== card.canonicalWordId && --remaining === 0) { ready.add(card); break; }
    }
  }
  // The existing round order is a fair fallback when the pool is too small,
  // timestamps tie, or every remaining card is still waiting. No timer blocks study.
  return cards.sort((left, right) => Number(ready.has(right)) - Number(ready.has(left))
    || (ready.has(left) && ready.has(right) ? reviewAt(left.state) - reviewAt(right.state) : 0));
}

/** Due recalls and enrolled new words rotate with unfinished short-term cards. */
export function buildFlashcardQueue(states: readonly WordMemoryState[], {
  now = new Date(), timezone, newWordLimit, reviewLimit, canonicalWordIds, enrolledWordIds, pausedWordIds, excludedWordIds,
}: {
  now?: Date;
  timezone: string;
  newWordLimit?: number | null;
  reviewLimit?: number;
  canonicalWordIds?: ReadonlyMap<string, string>;
  enrolledWordIds?: ReadonlySet<string>;
  pausedWordIds?: ReadonlySet<string>;
  excludedWordIds?: ReadonlySet<string>;
}): FlashcardQueue {
  if (!Number.isFinite(now.getTime())) throw new TypeError('Invalid flashcard queue date');
  const today = getLocalDateInTimeZone(now, timezone);
  const canonicalPreferences = (ids: ReadonlySet<string> | undefined) => [...ids ?? []]
    .map(id => canonicalWordIds?.get(id) ?? id);
  const projectLearning = createWordLearningStatusProjector({ dailyNewWordLimit: newWordLimit ?? null,
    importedWordIds: canonicalPreferences(enrolledWordIds), pausedWordIds: canonicalPreferences(pausedWordIds),
    excludedWordIds: canonicalPreferences(excludedWordIds) });
  const grouped = new Map<string, WordMemoryState[]>();
  for (const state of states) {
    const canonical = canonicalWordIds?.get(state.wordId) ?? state.wordId;
    if (!canonical) continue;
    grouped.set(canonical, [...grouped.get(canonical) ?? [], state]);
  }
  const due: FlashcardQueueCard[] = [];
  const fresh: FlashcardQueueCard[] = [];
  const future: number[] = [];
  const futureLearning: number[] = [];
  const owners: { canonicalWordId: string; state: WordMemoryState }[] = [];
  let learningCount = 0;
  let newIntroducedToday = 0;
  for (const [canonicalWordId, group] of grouped) {
    // Match the app's canonical projection; fall back to the newest alias.
    const state = selectCanonicalMemoryState(group, canonicalWordId)!;
    owners.push({ canonicalWordId, state });
    const practice = projectUnratedFlashcardPractice(state);
    const firstRecall = state.fsrsReviews
      .filter(review => review.source !== 'reading_lookup').sort((left, right) => left.review.localeCompare(right.review))[0];
    const hasUnloggedBaseline = state.fsrsCard.reps > state.fsrsReviews.length;
    if (!hasUnloggedBaseline && firstRecall?.source === 'flashcard'
      && (firstRecall.localDate ?? getLocalDateInTimeZone(new Date(firstRecall.review), timezone)) === today) {
      newIntroducedToday += 1;
    }
    const learning = projectLearning(state, canonicalWordId);
    if (!learning.isFlashcardEligible) continue;
    const introduced = learning.hasRecall || practice !== null;
    const nextReview = practice?.due ?? state.nextReview;
    const dueMs = Date.parse(nextReview);
    if (introduced && !Number.isFinite(dueMs)) continue;
    const card: FlashcardQueueCard = {
      wordId: state.wordId, canonicalWordId, state, kind: !introduced ? 'new'
        : practice ? practice.phase === 'learning' ? 'learning' : 'due'
          : state.fsrsCard.state === 1 ? 'learning' : state.fsrsCard.state === 3 ? 'relearning' : 'due',
      contextTexts: [...new Set(group.flatMap(row => row.rme?.contextHistory ?? [])
        .map(context => context.contextText?.trim()).filter((context): context is string => Boolean(context)))],
      nextReview, isPractice: false,
    };
    const shortTerm = card.kind === 'learning' || card.kind === 'relearning';
    if (shortTerm) learningCount += 1;
    if (!introduced) fresh.push(card);
    else if (dueMs <= now.getTime()) due.push(card);
    else {
      future.push(dueMs);
      if (shortTerm) futureLearning.push(dueMs);
    }
  }
  const learningPriority = (card: FlashcardQueueCard) => card.kind === 'learning' || card.kind === 'relearning' ? 0 : 1;
  due.sort((left, right) => learningPriority(left) - learningPriority(right)
    || Date.parse(left.nextReview) - Date.parse(right.nextReview)
    || left.wordId.localeCompare(right.wordId));
  fresh.sort((left, right) => (Date.parse(right.state.lastAssistedAt ?? '') || reviewAt(right.state))
    - (Date.parse(left.state.lastAssistedAt ?? '') || reviewAt(left.state))
    || left.wordId.localeCompare(right.wordId));
  const availableNew = newWordLimit === null ? fresh.length : Math.max(0, limit(newWordLimit, 10) - newIntroducedToday);
  const eligible = [...due.slice(0, limit(reviewLimit, due.length)), ...fresh.slice(0, availableNew)];
  // Stable sort retains historical due/new ordering within the initial pass.
  // Times only break ties; repeated attempts at the same instant still rotate.
  eligible.sort((left, right) => {
    const leftRound = rehearsalRound(left.state), rightRound = rehearsalRound(right.state);
    return leftRound - rightRound || (leftRound > 0
      ? reviewAt(left.state) - reviewAt(right.state) || left.wordId.localeCompare(right.wordId) : 0);
  });
  return {
    cards: orderFlashcardRepetitions(eligible, owners, now),
    dueCount: due.length, newCount: Math.min(fresh.length, availableNew), remainingNewCount: fresh.length, newIntroducedToday,
    nextDueAt: future.length ? new Date(Math.min(...future)).toISOString() : null,
    learningCount, pendingLearningCount: futureLearning.length,
    nextLearningDueAt: futureLearning.length ? new Date(Math.min(...futureLearning)).toISOString() : null,
  };
}

/** Current study steps; older saved states enter the latest policy on their next rating. */
export function getFlashcardLearningProgress(state: WordMemoryState, isNew = false): number | null {
  const practice = projectUnratedFlashcardPractice(state);
  if (practice) return practice.phase === 'learning' ? Math.min(2, Math.max(0, practice.steps)) : null;
  if (!isNew && state.fsrsCard.state !== 1 && state.fsrsCard.state !== 3) return null;
  return isNew ? 0 : Math.min(2, Math.max(0, Math.floor(state.fsrsCard.learningSteps ?? 0)));
}

export interface FlashcardInterval { nextReview: string; intervalMs: number; rehearsalGap: number | null }

/** Pure preview of the same FSRS scheduler used by durable submission. */
export function previewFlashcardIntervals(state: WordMemoryState, now = new Date(),
  scheduling = createFlashcardSchedulingPolicy()): Record<FlashcardRating, FlashcardInterval> {
  if (!Number.isFinite(now.getTime())) throw new TypeError('Invalid flashcard preview date');
  if (state.lastReview && Date.parse(state.lastReview) > now.getTime()) throw new RangeError('Review time precedes saved memory');
  return Object.fromEntries((Object.keys(ratings) as FlashcardRating[]).map(rating => {
    const updated = submitFsrsReview(state, ratings[rating] as Grade, now, scheduling);
    return [rating, { nextReview: updated.nextReview, intervalMs: Math.max(0, Date.parse(updated.nextReview) - now.getTime()),
      rehearsalGap: getFlashcardRehearsalGap(updated) }];
  })) as Record<FlashcardRating, FlashcardInterval>;
}

/** Stable attempt IDs make retries safe, even after the journal saved but the derived card did not. */
export async function submitFlashcardRating(store: MemoryV2Store, {
  attemptId, wordId, rating, scheduling, expectedReps, evidence,
}: { attemptId: string; wordId: string; rating: FlashcardRating; scheduling?: FlashcardSchedulingPolicy;
  expectedReps?: number; evidence?: FlashcardRecallEvidence }): Promise<WordMemoryState> {
  const numeric = ratings[rating];
  if (!numeric) throw new TypeError('Invalid flashcard rating');
  await store.ensureReady();
  const policy = scheduling ?? createFlashcardSchedulingPolicy((await store.system.getFlashcardStudyPreferences(store.userId)).desiredRetention);
  const shownReps = expectedReps ?? (policy.version >= 4
    ? (await store.system.getReadingVerificationMemoryStates(store.userId)).find(state => state.wordId === wordId)?.fsrsCard.reps ?? 0
    : undefined);
  await store.recordVerification({ attemptId, wordId, rating: numeric, scheduling: policy,
    ...(evidence ? { evidence: { ...evidence } } : {}),
    ...(shownReps !== undefined ? { expectedReps: shownReps } : {}),
    questionId: `flashcard:v1:${wordId}`, articleId: 'flashcard-review', purpose: 'flashcard_review',
    outcome: numeric === 1 ? 'incorrect' : numeric === 2 ? 'uncertain' : 'recognized' });
  const saved = (await store.system.getReadingVerificationMemoryStates(store.userId)).find(state => state.wordId === wordId);
  if (!saved) throw new Error('词卡记录已提交，但暂时无法读取复习安排，请重试。');
  return saved;
}

/** Correct this same recall at its original timestamp; retries keep the latest revision. */
export async function correctFlashcardRating(store: MemoryV2Store, {
  correctionId, attemptId, wordId, rating, expectedRevision,
}: { correctionId: string; attemptId: string; wordId: string; rating: FlashcardRating; expectedRevision: number }): Promise<WordMemoryState> {
  const numeric = ratings[rating];
  if (!numeric) throw new TypeError('Invalid flashcard rating');
  await store.correctFlashcardReview({ correctionId, attemptId, wordId, rating: numeric, expectedRevision });
  const saved = (await store.system.getReadingVerificationMemoryStates(store.userId)).find(state => state.wordId === wordId);
  if (!saved) throw new Error('评分修订已保存，但暂时无法读取复习安排，请重试。');
  return saved;
}

/** The persisted scheduler owns relearning; never insert an immediate temporary copy. */
export function advanceFlashcardSession(cards: readonly FlashcardQueueCard[], wordId: string,
  rating: FlashcardRating): FlashcardQueueCard[] {
  if (!ratings[rating]) throw new TypeError('Invalid flashcard rating');
  const index = cards.findIndex(card => card.wordId === wordId);
  if (index < 0) return [...cards];
  const remaining = cards.filter((_, cardIndex) => cardIndex !== index);
  return remaining;
}
