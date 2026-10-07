import type { Grade } from 'ts-fsrs';
import type { MemoryV2Store } from './memoryV2/memoryStore';
import type { WordMemoryState } from './memoryV2/types';
import { getLocalDateInTimeZone } from './memoryV2/dateUtils';
import { submitFsrsReview } from './memoryV2/fsrsIntegration';
import { hasFormalRecallEvidence } from './memoryV2/rmeV4Bridge';
import type { FlashcardStudyPreferences } from './flashcardPreferences';

export type FlashcardRating = 'again' | 'hard' | 'good' | 'easy';
const ratings: Record<FlashcardRating, 1 | 2 | 3 | 4> = { again: 1, hard: 2, good: 3, easy: 4 };

export interface FlashcardQueueCard {
  /** Save to the existing memory identity; a display alias never creates a second card. */
  wordId: string;
  canonicalWordId: string;
  state: WordMemoryState;
  kind: 'due' | 'new';
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
}

const limit = (value: number | undefined, fallback: number) => Number.isFinite(value)
  ? Math.max(0, Math.floor(value!)) : fallback;
const reviewAt = (state: WordMemoryState) => Date.parse(state.lastReview ?? '') || 0;
const hasRecall = hasFormalRecallEvidence;
const hasLookup = (state: WordMemoryState) => Number.isFinite(Date.parse(state.lastAssistedAt ?? ''))
  || state.fsrsReviews.some(review => review.source === 'reading_lookup');

/** The manager shows enrolled/queried/recalled words, rather than every incidental reading exposure. */
export function getManagedFlashcardWordIds(states: readonly WordMemoryState[], preferences: FlashcardStudyPreferences,
  canonicalWordIds: ReadonlyMap<string, string>): string[] {
  const registered = new Set([...preferences.importedWordIds, ...preferences.pausedWordIds ?? [], ...preferences.excludedWordIds ?? []]);
  return [...new Set([...registered, ...states.filter(state => hasRecall(state) || hasLookup(state)
    || registered.has(state.wordId) || registered.has(canonicalWordIds.get(state.wordId) ?? state.wordId)).map(state => state.wordId)]
    .map(word => canonicalWordIds.get(word) ?? word))].sort((a, b) => a.localeCompare(b));
}

/** Due recalls come first; new cards come from lookups or explicit word-list enrollment. */
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
  const grouped = new Map<string, WordMemoryState[]>();
  for (const state of states) {
    const canonical = canonicalWordIds?.get(state.wordId) ?? state.wordId;
    if (!canonical) continue;
    grouped.set(canonical, [...grouped.get(canonical) ?? [], state]);
  }
  const due: FlashcardQueueCard[] = [];
  const fresh: FlashcardQueueCard[] = [];
  const future: number[] = [];
  let newIntroducedToday = 0;
  for (const [canonicalWordId, group] of grouped) {
    // Match the app's canonical projection; fall back to the newest alias.
    const state = [...group].sort((left, right) => Number(right.wordId === canonicalWordId) - Number(left.wordId === canonicalWordId)
      || reviewAt(right) - reviewAt(left)
      || right.fsrsCard.reps - left.fsrsCard.reps
      || left.wordId.localeCompare(right.wordId))[0];
    const firstRecall = state.fsrsReviews
      .filter(review => review.source !== 'reading_lookup').sort((left, right) => left.review.localeCompare(right.review))[0];
    const hasUnloggedBaseline = state.fsrsCard.reps > state.fsrsReviews.length;
    if (!hasUnloggedBaseline && firstRecall?.source === 'flashcard'
      && (firstRecall.localDate ?? getLocalDateInTimeZone(new Date(firstRecall.review), timezone)) === today) {
      newIntroducedToday += 1;
    }
    if ([canonicalWordId, ...group.map(row => row.wordId)].some(id => pausedWordIds?.has(id) || excludedWordIds?.has(id))) continue;
    const introduced = hasRecall(state);
    if (!introduced && !hasLookup(state) && !enrolledWordIds?.has(state.wordId) && !enrolledWordIds?.has(canonicalWordId)) continue;
    const dueMs = Date.parse(state.nextReview);
    if (introduced && !Number.isFinite(dueMs)) continue;
    const card: FlashcardQueueCard = {
      wordId: state.wordId, canonicalWordId, state, kind: introduced ? 'due' : 'new',
      contextTexts: [...new Set(group.flatMap(row => row.rme?.contextHistory ?? [])
        .map(context => context.contextText?.trim()).filter((context): context is string => Boolean(context)))],
      nextReview: state.nextReview, isPractice: false,
    };
    if (!introduced) fresh.push(card);
    else if (dueMs <= now.getTime()) due.push(card);
    else future.push(dueMs);
  }
  due.sort((left, right) => Date.parse(left.nextReview) - Date.parse(right.nextReview)
    || left.wordId.localeCompare(right.wordId));
  fresh.sort((left, right) => (Date.parse(right.state.lastAssistedAt ?? '') || reviewAt(right.state))
    - (Date.parse(left.state.lastAssistedAt ?? '') || reviewAt(left.state))
    || left.wordId.localeCompare(right.wordId));
  const availableNew = newWordLimit === null ? fresh.length : Math.max(0, limit(newWordLimit, 10) - newIntroducedToday);
  return {
    cards: [...due.slice(0, limit(reviewLimit, due.length)), ...fresh.slice(0, availableNew)],
    dueCount: due.length, newCount: Math.min(fresh.length, availableNew), remainingNewCount: fresh.length, newIntroducedToday,
    nextDueAt: future.length ? new Date(Math.min(...future)).toISOString() : null,
  };
}

export interface FlashcardInterval { nextReview: string; intervalMs: number }

/** Pure preview of the same FSRS scheduler used by durable submission. */
export function previewFlashcardIntervals(state: WordMemoryState, now = new Date()): Record<FlashcardRating, FlashcardInterval> {
  if (!Number.isFinite(now.getTime())) throw new TypeError('Invalid flashcard preview date');
  if (state.lastReview && Date.parse(state.lastReview) > now.getTime()) throw new RangeError('Review time precedes saved memory');
  return Object.fromEntries((Object.keys(ratings) as FlashcardRating[]).map(rating => {
    const updated = submitFsrsReview(state, ratings[rating] as Grade, now);
    return [rating, { nextReview: updated.nextReview, intervalMs: Math.max(0, Date.parse(updated.nextReview) - now.getTime()) }];
  })) as Record<FlashcardRating, FlashcardInterval>;
}

/** Stable attempt IDs make retries safe, even after the journal saved but the derived card did not. */
export async function submitFlashcardRating(store: MemoryV2Store, {
  attemptId, wordId, rating,
}: { attemptId: string; wordId: string; rating: FlashcardRating }): Promise<WordMemoryState> {
  const numeric = ratings[rating];
  if (!numeric) throw new TypeError('Invalid flashcard rating');
  await store.recordVerification({ attemptId, wordId, rating: numeric,
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

/** Same-session rehearsal grants no extra long-term recall credit. */
export function advanceFlashcardSession(cards: readonly FlashcardQueueCard[], wordId: string,
  rating: FlashcardRating): FlashcardQueueCard[] {
  if (!ratings[rating]) throw new TypeError('Invalid flashcard rating');
  const index = cards.findIndex(card => card.wordId === wordId);
  if (index < 0) return [...cards];
  const remaining = cards.filter((_, cardIndex) => cardIndex !== index);
  if (rating === 'again') remaining.splice(Math.min(3, remaining.length), 0, { ...cards[index], isPractice: true });
  return remaining;
}
