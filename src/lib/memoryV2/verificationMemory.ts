import type { Grade } from 'ts-fsrs';
import type { MemoryStorage } from './storage';
import type { DailyWordEvidence, FlashcardRecallEvidence, FlashcardReviewCorrectionInput, FlashcardReviewInput, ReadingVerificationEvidence, ReadingVerificationInput, WordMemoryState } from './types';
import { getLocalDateInTimeZone } from './dateUtils';
import { initializeWordMemory, submitFsrsReview } from './fsrsIntegration';
import { applyReviewOutcome } from '../memoryV4';
import { hasFormalRecallEvidence, projectRmeProfile, rmeProfileForState } from './rmeV4Bridge';
import { readFlashcardStudyPreferences } from '../flashcardPreferences';
import { repairPassiveReadingRecall } from './passiveRecallRepair';
import { createFlashcardSchedulingPolicy, isFlashcardSchedulingPolicy, type FlashcardSchedulingPolicy } from '../flashcardScheduling';
import { restoreMemoryBeforeReview } from './reviewSnapshot';
import { recallFailureCount, recallFailureTime } from './evidenceAggregation';
import { classifyFlashcardRecallEvidence } from '../flashcardReview';
import { projectUnratedFlashcardPractice } from '../flashcardPractice';

const journalKey = (userId: string) => `reading-verification:${userId}`;
const outcomes = new Set(['recognized', 'incorrect', 'uncertain', 'guessed', 'skipped']);
interface VerificationJournal { version: 1; userId: string; attempts: ReadingVerificationEvidence[] }

export async function readVerificationHistory(storage: MemoryStorage, userId: string): Promise<ReadingVerificationEvidence[]> {
  const journal = await storage.getMeta?.<VerificationJournal>(journalKey(userId));
  return journal?.version === 1 && journal.userId === userId && Array.isArray(journal.attempts)
    ? journal.attempts.map(attempt => ({ ...attempt,
      ...(attempt.scheduling ? { scheduling: { ...attempt.scheduling } } : {}),
      ...(attempt.readingTask ? { readingTask: { ...attempt.readingTask } } : {}),
      ...(attempt.purpose === 'flashcard_review' && attempt.evidence ? { evidence: { ...attempt.evidence } } : {}),
      ...(attempt.flashcardRevisions ? { flashcardRevisions: attempt.flashcardRevisions.map(revision => ({ ...revision })) } : {}) })) : [];
}

/** The answer shown by an earlier card is an exposure even if that card was practice. */
function flashcardEvidenceFor(input: FlashcardReviewInput, attempts: readonly ReadingVerificationEvidence[],
  state: WordMemoryState, now: Date): FlashcardRecallEvidence {
  const completed = attempts.flatMap((attempt, index) => attempt.purpose === 'flashcard_review'
    && Date.parse(attempt.occurredAt) <= now.getTime() ? [{ attempt, index }] : []);
  const prior = completed.filter(({ attempt }) => attempt.wordId === input.wordId)
    .sort((left, right) => Date.parse(left.attempt.occurredAt) - Date.parse(right.attempt.occurredAt) || left.index - right.index).at(-1);
  const imported = state.fsrsReviews.filter(review => review.source === 'flashcard'
    && Date.parse(review.review) <= now.getTime()).map(review => review.review)
    .sort((left, right) => Date.parse(left) - Date.parse(right)).at(-1);
  const answerExposedAt = [prior?.attempt.occurredAt, imported, state.lastAssistedAt, input.evidence?.answerExposedAt]
    .filter((at): at is string => Boolean(at)).sort((left, right) => Date.parse(left) - Date.parse(right)).at(-1);
  const exposedMs = Date.parse(answerExposedAt ?? '');
  const intervening = completed.filter(({ attempt, index }) => attempt.wordId !== input.wordId
    && (Date.parse(attempt.occurredAt) > exposedMs || (Date.parse(attempt.occurredAt) === exposedMs
      && prior !== undefined && prior.attempt.occurredAt === answerExposedAt && index > prior.index)))
    .sort((left, right) => Date.parse(left.attempt.occurredAt) - Date.parse(right.attempt.occurredAt) || left.index - right.index).at(-1);
  // A caller can report a newer answer exposure, but cannot claim an
  // intervening task to turn an immediate rehearsal into a formal recall.
  const interveningWord = intervening?.attempt.wordId;
  return classifyFlashcardRecallEvidence({ answerExposedAt, interveningWord, now });
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
  if (input.readingTask !== undefined && (!input.readingTask || input.readingTask.type !== 'context_choice'
    || input.readingTask.contextVisible !== true || typeof input.readingTask.answerExposed !== 'boolean'
    || !['hard_on_correct', 'practice_only'].includes(input.readingTask.mapping))) {
    throw new TypeError('Invalid reading task evidence');
  }
  if (input.purpose !== undefined && !['delayed_verification', 'immediate_practice', 'flashcard_review'].includes(input.purpose)) {
    throw new TypeError('Invalid verification purpose');
  }
  if (input.purpose === 'flashcard_review' && (![1, 2, 3, 4].includes(input.rating)
    || input.outcome !== (input.rating === 1 ? 'incorrect' : input.rating === 2 ? 'uncertain' : 'recognized'))) {
    throw new TypeError('Invalid flashcard rating');
  }
  if (input.purpose === 'flashcard_review' && input.evidence !== undefined) {
    const evidence = input.evidence;
    if (!evidence || typeof evidence !== 'object' || !['independent_recall', 'answer_rehearsal'].includes(evidence.kind)
      || (evidence.answerExposedAt !== undefined && (typeof evidence.answerExposedAt !== 'string'
        || !Number.isFinite(Date.parse(evidence.answerExposedAt)) || Date.parse(evidence.answerExposedAt) > now.getTime()))
      || (evidence.interveningWord !== undefined && (typeof evidence.interveningWord !== 'string'
        || !evidence.interveningWord.trim() || evidence.interveningWord.length > 500 || evidence.interveningWord === input.wordId))) {
      throw new TypeError('Invalid flashcard recall evidence');
    }
  }
  if (input.scheduling !== undefined && !isFlashcardSchedulingPolicy(input.scheduling)) {
    throw new TypeError('Invalid recall scheduling policy');
  }
  const attempts = await readVerificationHistory(storage, userId);
  const index = attempts.findIndex(attempt => attempt.attemptId === input.attemptId);
  let flashcardState: WordMemoryState | null = null;
  if (index < 0 && input.purpose !== 'flashcard_review' && input.purpose !== 'immediate_practice'
    && ['recognized', 'incorrect', 'uncertain'].includes(input.outcome)) {
    const state = await storage.getMemoryState(userId, input.wordId);
    // Reject a backwards device clock before its write-ahead entry can make
    // an opaque imported baseline impossible to replay. Include pending
    // durable recalls whose derived card write has not completed yet.
    if ((state?.lastReview && Date.parse(state.lastReview) > now.getTime())
      || attempts.some(attempt => attempt.wordId === input.wordId && attempt.purpose !== 'immediate_practice'
        && ['recognized', 'incorrect', 'uncertain'].includes(attempt.outcome)
        && Date.parse(attempt.occurredAt) > now.getTime())) {
      throw new Error('设备时间早于已有学习记录，请校正时间后重试。');
    }
  }
  if (index < 0 && input.purpose === 'flashcard_review') {
    const guarded = input.scheduling !== undefined && input.scheduling.version >= 4;
    if (guarded && (!Number.isSafeInteger(input.expectedReps) || input.expectedReps! < 0)) {
      throw new TypeError('词卡回忆版本无效，请刷新词卡。');
    }
    const storedState = await storage.getMemoryState(userId, input.wordId);
    if (!storedState) throw new Error('这张词卡的学习记录不存在，请刷新后重试。');
    const days = storage.getWordDailyEvidence ? await storage.getWordDailyEvidence(userId, input.wordId)
      : (await Promise.all([...new Set(storedState.fsrsReviews.filter(review => review.localDate || Number.isFinite(Date.parse(review.review)))
        .map(review => review.localDate
        ?? getLocalDateInTimeZone(new Date(review.review), timezone)))]
        .map(date => storage.getDailyEvidence(userId, input.wordId, date)))).filter((day): day is DailyWordEvidence => Boolean(day));
    let state = repairPassiveReadingRecall(storedState, days, timezone, now);
    if (guarded) {
      // The caller holds the shared writer lock. A prior writer may have saved
      // its journal before a derived-card failure, so include that durable
      // recall when checking the displayed card's optimistic version.
      state = replayVerificationEvidence(state, attempts, timezone, days, now) ?? state;
      if (input.expectedReps !== state.fsrsCard.reps) {
        throw new Error('这张词卡已在其他页面更新，请刷新词卡后再回忆。');
      }
    }
    if ((state.lastReview && Date.parse(state.lastReview) > now.getTime())
      || attempts.some(attempt => attempt.wordId === input.wordId && attempt.purpose === 'flashcard_review'
        && Date.parse(attempt.occurredAt) > now.getTime())) throw new Error('设备时间早于已有学习记录，请校正时间后重试。');
    const hasRecall = hasFormalRecallEvidence(state);
    const unratedPractice = projectUnratedFlashcardPractice(state);
    if ((hasRecall || unratedPractice) && Date.parse(unratedPractice?.due ?? state.nextReview) > now.getTime()) {
      throw new Error('这个词已保存复习结果，下一次复习尚未到期，请刷新词卡。');
    }
    const enrolled = (await readFlashcardStudyPreferences(storage, userId)).importedWordIds.includes(input.wordId);
    if (!hasRecall && !state.lastAssistedAt && !state.fsrsReviews.some(review => review.source === 'reading_lookup') && !enrolled) {
      throw new Error('这个词还没有查询或回忆记录，请先在阅读中查词。');
    }
    flashcardState = state;
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
  } else {
    const durableInput = { ...input, ...(input.scheduling ? { scheduling: { ...input.scheduling } } : {}),
      ...(input.readingTask ? { readingTask: { ...input.readingTask } } : {}) };
    if (durableInput.purpose === 'flashcard_review') {
      delete durableInput.expectedReps;
      if (durableInput.scheduling && durableInput.scheduling.version >= 6) {
        durableInput.evidence = flashcardEvidenceFor(durableInput, attempts, flashcardState!, now);
      } else if (durableInput.evidence) durableInput.evidence = { ...durableInput.evidence };
    }
    else if (durableInput.purpose !== 'immediate_practice' && ['recognized', 'incorrect', 'uncertain'].includes(durableInput.outcome)) {
      // Freeze new reading recalls alongside word-card recalls. Replays and
      // retries never consult today's preference or upgrade historical logs.
      durableInput.scheduling ??= createFlashcardSchedulingPolicy(
        (await readFlashcardStudyPreferences(storage, userId)).desiredRetention);
    }
    attempts.push({ ...durableInput, userId, occurredAt: now.toISOString(), localDate: getLocalDateInTimeZone(now, timezone), timezone });
  }
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
  scheduling?: FlashcardSchedulingPolicy;
  evidence?: FlashcardRecallEvidence;
  originalFlashcardRating?: Review['originalFlashcardRating']; flashcardRevisions?: Review['flashcardRevisions'] }
const planFor = (review: Review): ReviewPlan => ({ at: review.review, rating: review.rating,
  ...(review.scheduling ? { scheduling: review.scheduling } : {}),
  ...(review.evidence ? { evidence: { ...review.evidence } } : {}),
  ...(review.source ? { source: review.source } : {}), ...(review.localDate ? { localDate: review.localDate } : {}),
  ...(review.verificationAttemptIds ? { verificationAttemptIds: review.verificationAttemptIds } : {}),
  ...(review.originalFlashcardRating !== undefined ? { originalFlashcardRating: review.originalFlashcardRating } : {}),
  ...(review.flashcardRevisions ? { flashcardRevisions: review.flashcardRevisions } : {}) });

/** New unified recalls preserve observed same-instant order across both sources. */
function orderUnifiedReviewPlans(plans: ReviewPlan[], oldReviews: readonly Review[], attempts: readonly ReadingVerificationEvidence[]) {
  plans.sort((left, right) => left.at.localeCompare(right.at));
  const unifiedTimes = new Set(attempts.filter(attempt => attempt.purpose !== 'flashcard_review'
    && attempt.purpose !== 'immediate_practice' && attempt.scheduling !== undefined && attempt.scheduling.version >= 4).map(attempt => attempt.occurredAt));
  for (let start = 0; start < plans.length;) {
    let end = start + 1;
    while (end < plans.length && plans[end].at === plans[start].at) end++;
    const bucket = plans.slice(start, end);
    if (bucket.length > 1 && unifiedTimes.has(bucket[0].at)) {
      const edges = bucket.map(() => new Set<number>());
      const degrees = bucket.map(() => 0);
      const link = (order: number[]) => {
        for (let index = 1; index < order.length; index++) {
          const previous = order[index - 1], next = order[index];
          if (previous !== next && !edges[previous].has(next)) { edges[previous].add(next); degrees[next]++; }
        }
      };
      // Preserve the order of unchanged saved decisions. A daily aggregate is
      // positioned at its last contributing journal entry, excluding outcomes
      // that did not determine the representative rating.
      const priorOrder = oldReviews.filter(review => review.review === bucket[0].at).map(review => bucket.findIndex(plan =>
        plan.source === review.source && plan.localDate === review.localDate
        && JSON.stringify(plan.verificationAttemptIds ?? []) === JSON.stringify(review.verificationAttemptIds ?? [])))
        .filter(index => index >= 0);
      link([...new Set(priorOrder)]);
      const latestJournalPosition = new Map<number, number>();
      attempts.forEach((attempt, index) => {
        if (attempt.occurredAt !== bucket[0].at) return;
        const planIndex = bucket.findIndex(plan => plan.verificationAttemptIds?.includes(attempt.attemptId));
        if (planIndex >= 0) latestJournalPosition.set(planIndex, index);
      });
      link([...latestJournalPosition].sort((left, right) => left[1] - right[1]).map(([index]) => index));
      const ready = degrees.flatMap((degree, index) => degree === 0 ? [index] : []);
      const ordered: ReviewPlan[] = [];
      while (ready.length) {
        const index = ready.shift()!;
        ordered.push(bucket[index]);
        for (const next of edges[index]) {
          if (--degrees[next] === 0) { ready.push(next); ready.sort((left, right) => left - right); }
        }
      }
      if (ordered.length !== bucket.length) throw new Error('同一时间的回忆记录顺序冲突，请检查导入的学习记录。');
      plans.splice(start, bucket.length, ...ordered);
    }
    start = end;
  }
}

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
    ...(attempt.scheduling ? { scheduling: attempt.scheduling } : {}),
    ...(attempt.evidence ? { evidence: { ...attempt.evidence } } : {}),
    source: 'flashcard', localDate: attempt.localDate, verificationAttemptIds: [attempt.attemptId],
    ...(attempt.originalFlashcardRating !== undefined ? { originalFlashcardRating: attempt.originalFlashcardRating } : {}),
    ...(attempt.flashcardRevisions ? { flashcardRevisions: attempt.flashcardRevisions } : {}) });
  const groups = new Map<string, ReadingVerificationEvidence[]>();
  for (const attempt of relevant.filter(attempt => attempt.purpose !== 'flashcard_review')) {
    groups.set(attempt.localDate, [...groups.get(attempt.localDate) ?? [], attempt]);
  }
  for (const [date, rows] of groups) {
    const graded = rows.filter(row => ['recognized', 'incorrect', 'uncertain'].includes(row.outcome));
    const lookup = lookupDays.find(day => day.localDate === date && recallFailureCount(day) > 0);
    if (!graded.length && !lookup) continue;
    const failures = graded.filter(row => row.outcome !== 'recognized');
    const failed = failures.length > 0 || Boolean(lookup);
    // Failure wins the daily rating, but a later success is not a later failure.
    // Keep the representative's timestamp, policy and same-instant journal
    // position attached to the evidence that actually supplied that outcome.
    const contributing = failed ? failures : graded;
    const existing = plans.findIndex(plan => plan.source !== 'flashcard'
      && (plan.localDate ?? getLocalDateInTimeZone(new Date(plan.at), timezone)) === date);
    if (existing >= 0 && (plans[existing].rating === 1 || !failed)) continue;
    const times = [...contributing.map(row => row.occurredAt), ...(lookup?.articleEvidence
      .map(recallFailureTime).filter((time): time is string => Boolean(time)) ?? [])]
      .filter(time => Number.isFinite(Date.parse(time))).sort();
    // A legacy day summary alone cannot locate a failure within that day.
    // Preserve any saved decision rather than borrowing a success timestamp.
    if (!times.length) continue;
    const latestGraded = [...contributing].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt)).at(-1);
    // A revision of an independent daily decision retains its historical
    // policy, including the absence of one on legacy decisions.
    const scheduling = existing >= 0 ? plans[existing].scheduling : latestGraded?.scheduling;
    const plan: ReviewPlan = { at: times.sort().at(-1)!, rating: failed ? 1 : 2,
      ...(scheduling ? { scheduling: { ...scheduling } } : {}),
      source: lookup ? 'reading_lookup' : 'verification', localDate: date,
      ...(lookup ? {} : { verificationAttemptIds: contributing.map(row => row.attemptId).sort() }) };
    if (existing >= 0) plans[existing] = plan;
    else plans.push(plan);
  }
  orderUnifiedReviewPlans(plans, oldReviews, relevant);
  if (JSON.stringify(plans) === JSON.stringify(oldReviews.map(planFor))) return state;

  let current = { ...state };
  if (oldReviews.length) {
    current = restoreMemoryBeforeReview(state, 0);
  }
  let profile = { ...rmeProfileForState(state), consecutiveAgain: 0, recoveryStreak: 0,
    forcedExposure: false, lastReviewGrade: null } as ReturnType<typeof rmeProfileForState>;
  for (const plan of plans) {
    const priorReviewAt = current.lastReview ? Date.parse(current.lastReview) : NaN;
    const recallQuality = plan.rating === 2 || (plan.source === 'flashcard'
      && (!Number.isFinite(priorReviewAt) || Date.parse(plan.at) - priorReviewAt < 86_400_000)) ? 0.6 : 1;
    current = submitFsrsReview(current, plan.rating as Grade, new Date(plan.at), plan.scheduling, plan.evidence);
    const index = current.fsrsReviews.length - 1;
    current.fsrsReviews[index] = { ...current.fsrsReviews[index], ...(plan.source ? { source: plan.source } : {}),
      ...(plan.localDate ? { localDate: plan.localDate } : {}),
      ...(plan.verificationAttemptIds ? { verificationAttemptIds: plan.verificationAttemptIds } : {}),
      ...(plan.originalFlashcardRating !== undefined ? { originalFlashcardRating: plan.originalFlashcardRating } : {}),
      ...(plan.flashcardRevisions ? { flashcardRevisions: plan.flashcardRevisions } : {}) };
    if (current.fsrsReviews[index].modelApplied !== false) {
      profile = applyReviewOutcome(profile, plan.rating === 1 ? 'Again' : 'Good', new Date(plan.at), recallQuality);
    }
  }
  return { ...current, rme: projectRmeProfile(profile, current, now) };
}
