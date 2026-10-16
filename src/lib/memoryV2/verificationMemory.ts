import type { Grade } from 'ts-fsrs';
import type { MemoryStorage } from './storage';
import type { DailyWordEvidence, FlashcardReviewCorrectionInput, FlashcardReviewInput, ReadingVerificationEvidence, ReadingVerificationInput, WordMemoryState } from './types';
import { getLocalDateInTimeZone } from './dateUtils';
import { initializeWordMemory, submitFsrsReview } from './fsrsIntegration';
import { applyReviewOutcome } from '../memoryV4';
import { hasFormalRecallEvidence, projectRmeProfile, rmeProfileForState } from './rmeV4Bridge';
import { readFlashcardStudyPreferences } from '../flashcardPreferences';
import { repairPassiveReadingRecall } from './passiveRecallRepair';

const journalKey = (userId: string) => `reading-verification:${userId}`;
const outcomes = new Set(['recognized', 'incorrect', 'uncertain', 'guessed', 'skipped']);
interface VerificationJournal { version: 1; userId: string; attempts: ReadingVerificationEvidence[] }

export async function readVerificationHistory(storage: MemoryStorage, userId: string): Promise<ReadingVerificationEvidence[]> {
  const journal = await storage.getMeta?.<VerificationJournal>(journalKey(userId));
  return journal?.version === 1 && journal.userId === userId && Array.isArray(journal.attempts)
    ? journal.attempts.map(attempt => ({ ...attempt,
      ...(attempt.flashcardRevisions ? { flashcardRevisions: attempt.flashcardRevisions.map(revision => ({ ...revision })) } : {}) })) : [];
}

/** Write ahead of derived FSRS state. Retry/downgrade never changes encounter identity or time. */
export async function saveVerificationAttempt(storage: MemoryStorage, userId: string,
  input: ReadingVerificationInput | FlashcardReviewInput, timezone: string, now: Date): Promise<ReadingVerificationEvidence[]> {
  if (!storage.getMeta || !storage.setMeta) throw new Error('当前学习存储不支持保存确认记录。');
  for (const field of ['attemptId', 'questionId', 'wordId', 'articleId'] as const) {
    if (typeof input[field] !== 'string' || !input[field].trim() || input[field].length > 500) {
      throw new TypeError(`Invalid verification ${field}`);
    }
  }
  if (!outcomes.has(input.outcome) || !Number.isFinite(now.getTime())) throw new TypeError('Invalid verification outcome or timestamp');
  if (input.selectedOptionId !== undefined && (typeof input.selectedOptionId !== 'string' || !input.selectedOptionId || input.selectedOptionId.length > 100)) {
    throw new TypeError('Invalid selected option');
  }
  if (input.questionSentence !== undefined && (typeof input.questionSentence !== 'string'
    || !input.questionSentence.trim() || input.questionSentence.length > 500)) {
    throw new TypeError('Invalid question sentence');
  }
  if (input.purpose !== undefined && !['delayed_verification', 'immediate_practice', 'flashcard_review'].includes(input.purpose)) {
    throw new TypeError('Invalid verification purpose');
  }
  if (input.purpose === 'flashcard_review' && (![1, 2, 3, 4].includes(input.rating)
    || input.outcome !== (input.rating === 1 ? 'incorrect' : input.rating === 2 ? 'uncertain' : 'recognized'))) {
    throw new TypeError('Invalid flashcard rating');
  }
  const attempts = await readVerificationHistory(storage, userId);
  const index = attempts.findIndex(attempt => attempt.attemptId === input.attemptId);
  if (index < 0 && input.purpose === 'flashcard_review') {
    const storedState = await storage.getMemoryState(userId, input.wordId);
    if (!storedState) throw new Error('这张词卡的学习记录不存在，请刷新后重试。');
    const days = storage.getWordDailyEvidence ? await storage.getWordDailyEvidence(userId, input.wordId)
      : (await Promise.all([...new Set(storedState.fsrsReviews.filter(review => review.localDate || Number.isFinite(Date.parse(review.review)))
        .map(review => review.localDate
        ?? getLocalDateInTimeZone(new Date(review.review), timezone)))]
        .map(date => storage.getDailyEvidence(userId, input.wordId, date)))).filter((day): day is DailyWordEvidence => Boolean(day));
    const state = repairPassiveReadingRecall(storedState, days, timezone, now);
    const hasRecall = hasFormalRecallEvidence(state);
    if (hasRecall && Date.parse(state.nextReview) > now.getTime()) {
      throw new Error('这个词已保存复习结果，下一次复习尚未到期，请刷新词卡。');
    }
    if (state.lastReview && Date.parse(state.lastReview) > now.getTime()) throw new Error('设备时间早于已有学习记录，请校正时间后重试。');
    const enrolled = (await readFlashcardStudyPreferences(storage, userId)).importedWordIds.includes(input.wordId);
    if (!hasRecall && !state.lastAssistedAt && !state.fsrsReviews.some(review => review.source === 'reading_lookup') && !enrolled) {
      throw new Error('这个词还没有查询或回忆记录，请先在阅读中查词。');
    }
  }
  if (index >= 0) {
    const prior = attempts[index];
    if (prior.wordId !== input.wordId || prior.questionId !== input.questionId || prior.articleId !== input.articleId
      || (prior.purpose ?? 'delayed_verification') !== (input.purpose ?? 'delayed_verification')
      || (prior.purpose === 'flashcard_review' && input.purpose === 'flashcard_review' && prior.rating !== input.rating
        && prior.originalFlashcardRating !== input.rating
        && !prior.flashcardRevisions?.some(revision => revision.previousRating === input.rating || revision.rating === input.rating))
      || (prior.questionSentence !== undefined && input.questionSentence !== undefined
        && prior.questionSentence !== input.questionSentence)
      || (input.selectedOptionId !== undefined && prior.selectedOptionId !== input.selectedOptionId)) {
      throw new Error('确认记录标识冲突。');
    }
    // A delayed original submission is only a retry. Explicit corrections are
    // authoritative, including when its derived card still needs recovery.
    if (prior.purpose === 'flashcard_review' && prior.flashcardRevisions?.length) return attempts;
    if (prior.outcome === 'recognized' && input.outcome === 'guessed') attempts[index] = { ...prior, outcome: 'guessed' };
    else if (prior.outcome !== input.outcome && !(prior.outcome === 'guessed' && input.outcome === 'recognized')) {
      throw new Error('已保存的确认结果不能被另一份答案覆盖。');
    }
  } else attempts.push({ ...input, userId, occurredAt: now.toISOString(), localDate: getLocalDateInTimeZone(now, timezone), timezone });
  await storage.setMeta(journalKey(userId), { version: 1, userId, attempts } satisfies VerificationJournal);
  return attempts;
}

/** Durable, audited replacement. The caller holds the shared memory write lock. */
export async function saveFlashcardReviewCorrection(storage: MemoryStorage, userId: string,
  input: FlashcardReviewCorrectionInput, now: Date): Promise<ReadingVerificationEvidence[]> {
  if (!storage.getMeta || !storage.setMeta) throw new Error('当前学习存储不支持修改评分。');
  for (const field of ['correctionId', 'attemptId', 'wordId'] as const) {
    if (typeof input[field] !== 'string' || !input[field].trim() || input[field].length > 500) {
      throw new TypeError(`Invalid flashcard correction ${field}`);
    }
  }
  if (![1, 2, 3, 4].includes(input.rating) || !Number.isSafeInteger(input.expectedRevision)
    || input.expectedRevision < 0 || !Number.isFinite(now.getTime())) throw new TypeError('Invalid flashcard correction');
  const attempts = await readVerificationHistory(storage, userId);
  const prior = attempts.find(attempt => attempt.attemptId === input.attemptId);
  if (!prior || prior.purpose !== 'flashcard_review' || prior.wordId !== input.wordId || prior.userId !== userId) {
    throw new Error('找不到本次词卡评分，请重新读取学习记录。');
  }
  const existing = attempts.flatMap(attempt => (attempt.flashcardRevisions ?? []).map(revision => ({ attempt, revision })))
    .find(row => row.revision.correctionId === input.correctionId);
  if (existing) {
    if (existing.attempt.attemptId !== input.attemptId || existing.revision.rating !== input.rating
      || existing.revision.revision !== input.expectedRevision + 1) throw new Error('评分修订标识冲突。');
    return attempts;
  }
  const revisions = prior.flashcardRevisions ?? [];
  if (revisions.length !== input.expectedRevision) throw new Error('本次评分已在其他页面修改，请重新读取后再修改。');
  if (prior.rating === input.rating) throw new Error('本次评分已经是这个选项，无需修改。');
  const latestAt = revisions.at(-1)?.correctedAt ?? prior.occurredAt;
  if (!Number.isFinite(Date.parse(latestAt)) || now.getTime() < Date.parse(latestAt)) {
    throw new Error('设备时间早于已有评分记录，请校正时间后重试。');
  }
  const replacement: ReadingVerificationEvidence = { ...prior, rating: input.rating,
    outcome: input.rating === 1 ? 'incorrect' : input.rating === 2 ? 'uncertain' : 'recognized',
    originalFlashcardRating: prior.originalFlashcardRating ?? prior.rating,
    flashcardRevisions: [...revisions, { correctionId: input.correctionId, revision: revisions.length + 1,
      previousRating: prior.rating, rating: input.rating, correctedAt: now.toISOString() }] };
  attempts[attempts.indexOf(prior)] = replacement;
  await storage.setMeta(journalKey(userId), { version: 1, userId, attempts } satisfies VerificationJournal);
  return attempts;
}

type Review = WordMemoryState['fsrsReviews'][number];
interface ReviewPlan { at: string; rating: number; source?: Review['source']; localDate?: string; verificationAttemptIds?: string[];
  originalFlashcardRating?: Review['originalFlashcardRating']; flashcardRevisions?: Review['flashcardRevisions'] }
const planFor = (review: Review): ReviewPlan => ({ at: review.review, rating: review.rating,
  ...(review.source ? { source: review.source } : {}), ...(review.localDate ? { localDate: review.localDate } : {}),
  ...(review.verificationAttemptIds ? { verificationAttemptIds: review.verificationAttemptIds } : {}),
  ...(review.originalFlashcardRating !== undefined ? { originalFlashcardRating: review.originalFlashcardRating } : {}),
  ...(review.flashcardRevisions ? { flashcardRevisions: review.flashcardRevisions } : {}) });

/** Remove only this source's prior decisions, then merge attempts with independent history. */
export function replayVerificationEvidence(state: WordMemoryState | null,
  attempts: readonly ReadingVerificationEvidence[], timezone: string,
  lookupDays: readonly DailyWordEvidence[] = [], now = new Date()): WordMemoryState | null {
  if (state) state = repairPassiveReadingRecall(state, lookupDays, timezone, now);
  const wordAttempts = attempts.filter(attempt => !state || attempt.wordId === state.wordId);
  if (wordAttempts.length && wordAttempts.every(attempt => attempt.purpose === 'immediate_practice')) return state;
  const relevant = attempts.filter(attempt => (!state || attempt.wordId === state.wordId)
    && attempt.purpose !== 'immediate_practice'
    && Date.parse(attempt.occurredAt) <= now.getTime());
  if (!state && !relevant.some(attempt => ['recognized', 'incorrect', 'uncertain'].includes(attempt.outcome))) return null;
  if (!state) state = initializeWordMemory(relevant[0].userId, relevant[0].wordId);
  const oldReviews = state.fsrsReviews;
  const flashcards = relevant.filter((attempt): attempt is ReadingVerificationEvidence & FlashcardReviewInput => attempt.purpose === 'flashcard_review');
  const flashcardIds = new Set(flashcards.map(attempt => attempt.attemptId));
  const verificationIds = new Set(relevant.filter(attempt => attempt.purpose !== 'flashcard_review').map(attempt => attempt.attemptId));
  const plans = oldReviews.filter(review => !(review.source === 'verification'
      && review.verificationAttemptIds?.some(id => verificationIds.has(id)))
    && !(review.source === 'flashcard' && review.verificationAttemptIds?.some(id => flashcardIds.has(id)))).map(planFor);
  for (const attempt of flashcards) plans.push({ at: attempt.occurredAt, rating: attempt.rating,
    source: 'flashcard', localDate: attempt.localDate, verificationAttemptIds: [attempt.attemptId],
    ...(attempt.originalFlashcardRating !== undefined ? { originalFlashcardRating: attempt.originalFlashcardRating } : {}),
    ...(attempt.flashcardRevisions ? { flashcardRevisions: attempt.flashcardRevisions } : {}) });
  const groups = new Map<string, ReadingVerificationEvidence[]>();
  for (const attempt of relevant.filter(attempt => attempt.purpose !== 'flashcard_review')) {
    groups.set(attempt.localDate, [...groups.get(attempt.localDate) ?? [], attempt]);
  }
  for (const [date, rows] of groups) {
    const graded = rows.filter(row => ['recognized', 'incorrect', 'uncertain'].includes(row.outcome));
    const lookup = lookupDays.find(day => day.localDate === date && day.clickedOccurrenceCount > 0);
    if (!graded.length && !lookup) continue;
    const failed = graded.some(row => row.outcome !== 'recognized') || Boolean(lookup);
    const existing = plans.findIndex(plan => plan.source !== 'flashcard'
      && (plan.localDate ?? getLocalDateInTimeZone(new Date(plan.at), timezone)) === date);
    if (existing >= 0 && (plans[existing].rating === 1 || !failed)) continue;
    const times = [...graded.map(row => row.occurredAt), ...(lookup?.articleEvidence.map(row => row.lastSeenAt) ?? [])]
      .filter(time => Number.isFinite(Date.parse(time))).sort();
    if (existing >= 0) times.push(plans[existing].at);
    const plan: ReviewPlan = { at: times.sort().at(-1)!, rating: failed ? 1 : 2,
      source: lookup ? 'reading_lookup' : 'verification', localDate: date,
      ...(lookup ? {} : { verificationAttemptIds: graded.map(row => row.attemptId).sort() }) };
    if (existing >= 0) plans[existing] = plan;
    else plans.push(plan);
  }
  plans.sort((left, right) => left.at.localeCompare(right.at));
  if (JSON.stringify(plans) === JSON.stringify(oldReviews.map(planFor))) return state;

  let current = { ...state };
  if (oldReviews.length) {
    const first = oldReviews[0];
    const previousReview = first.state === 0 ? null : first.due;
    const due = previousReview
      ? new Date(Date.parse(previousReview) + first.scheduledDays * 86_400_000).toISOString() : first.due;
    current = { ...state, stability: first.stability, difficulty: first.difficulty, lastReview: previousReview,
      nextReview: due, fsrsReviews: [], fsrsCard: { due, stability: first.stability, difficulty: first.difficulty,
        elapsedDays: first.lastElapsedDays, scheduledDays: first.scheduledDays, learningSteps: first.learningSteps,
        reps: Math.max(0, state.fsrsCard.reps - oldReviews.length),
        lapses: Math.max(0, state.fsrsCard.lapses - oldReviews.filter(review => review.rating === 1 && review.state !== 0).length),
        state: first.state, ...(previousReview ? { lastReview: previousReview } : {}) } };
  }
  let profile = { ...rmeProfileForState(state), consecutiveAgain: 0, recoveryStreak: 0,
    forcedExposure: false, lastReviewGrade: null } as ReturnType<typeof rmeProfileForState>;
  for (const plan of plans) {
    const priorReviewAt = current.lastReview ? Date.parse(current.lastReview) : NaN;
    const recallQuality = plan.rating === 2 || (plan.source === 'flashcard'
      && (!Number.isFinite(priorReviewAt) || Date.parse(plan.at) - priorReviewAt < 86_400_000)) ? 0.6 : 1;
    current = submitFsrsReview(current, plan.rating as Grade, new Date(plan.at));
    const index = current.fsrsReviews.length - 1;
    current.fsrsReviews[index] = { ...current.fsrsReviews[index], ...(plan.source ? { source: plan.source } : {}),
      ...(plan.localDate ? { localDate: plan.localDate } : {}),
      ...(plan.verificationAttemptIds ? { verificationAttemptIds: plan.verificationAttemptIds } : {}),
      ...(plan.originalFlashcardRating !== undefined ? { originalFlashcardRating: plan.originalFlashcardRating } : {}),
      ...(plan.flashcardRevisions ? { flashcardRevisions: plan.flashcardRevisions } : {}) };
    profile = applyReviewOutcome(profile, plan.rating === 1 ? 'Again' : 'Good', new Date(plan.at), recallQuality);
  }
  return { ...current, rme: projectRmeProfile(profile, current, now) };
}
