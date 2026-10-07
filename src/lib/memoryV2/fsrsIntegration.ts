/**
 * FSRS 集成模块
 * 负责将每日评级提交到 FSRS 并更新记忆状态
 */

import {
  createEmptyCard,
  Rating,
  type Card,
  type RecordLog,
  type Grade,
} from 'ts-fsrs';
import { scheduleFsrsReview } from '../fsrs';
import { applyReviewOutcome } from '../memoryV4';
import type { RmeMemoryProfile } from '../memoryV4/types';
import { WordMemoryState, DailyWordEvidence, FsrsGrade } from './types';
import {
  getLocalDateInTimeZone,
  getSystemTimeZone,
  getUtcInstantForLocalDayEnd,
} from './dateUtils';
import { applyRmeReview, projectRmeProfile, rmeProfileForState } from './rmeV4Bridge';

const MIN_PASSIVE_RECALL_DAYS = 2;

/** Compatibility helper for repeated reading evidence, not a verified recall grade. */
export function hasSufficientPassiveRecallEvidence(
  memoryState: WordMemoryState | null,
  asOf?: Date,
): boolean {
  const lastReviewAt = memoryState?.lastReview
    ? Date.parse(memoryState.lastReview)
    : Number.NEGATIVE_INFINITY;
  const eligible = (memoryState?.rme?.exposureHistory ?? []).filter((exposure) => {
    const occurredAt = Date.parse(exposure.occurredAt);
    return exposure.isValid
      && exposure.quality >= 0.8
      && Number.isFinite(occurredAt)
      && occurredAt > lastReviewAt
      && (!asOf || occurredAt <= asOf.getTime());
  });
  const localDates = new Set(eligible.map((exposure) => exposure.localDate));

  return localDates.size >= MIN_PASSIVE_RECALL_DAYS;
}

function actualDailyReviewTime(evidence: DailyWordEvidence, userTimezone: string): Date | null {
  if (evidence.articleEvidence.length > 0) {
    const timestamps = evidence.articleEvidence.map((article) => Date.parse(article.lastSeenAt));
    const complete = timestamps.every((timestamp, index) => Number.isFinite(timestamp)
      && evidence.articleEvidence[index].localDate === evidence.localDate
      && getLocalDateInTimeZone(new Date(timestamp), userTimezone) === evidence.localDate);
    if (complete) return new Date(Math.max(...timestamps));
  }
  return null;
}

/**
 * 将我们的评级映射到 FSRS Rating
 */
function gradeToRating(grade: FsrsGrade): Grade {
  switch (grade) {
    case 'Again':
      return Rating.Again as Grade; // 1
    case 'Good':
      return Rating.Good as Grade; // 3
  }
}

/**
 * 初始化新单词的记忆状态
 */
export function initializeWordMemory(userId: string, wordId: string): WordMemoryState {
  const card = createEmptyCard();
  const now = new Date().toISOString();

  return {
    userId,
    wordId,
    stability: 0,
    difficulty: 0,
    lastReview: null,
    nextReview: now,
    fsrsCard: {
      due: card.due.toISOString(),
      stability: card.stability,
      difficulty: card.difficulty,
      elapsedDays: card.elapsed_days,
      scheduledDays: card.scheduled_days,
      learningSteps: card.learning_steps,
      reps: card.reps,
      lapses: card.lapses,
      state: card.state,
      lastReview: card.last_review?.toISOString(),
    },
    fsrsReviews: [],
  };
}

/**
 * 提交一次 FSRS 复习
 *
 * @param memoryState - 当前记忆状态
 * @param grade - 评级（Again 或 Good）
 * @param reviewTime - 复习时间（默认当前时间）
 * @returns 更新后的记忆状态
 */
export function submitFsrsReview(
  memoryState: WordMemoryState,
  grade: FsrsGrade | Grade,
  reviewTime: Date = new Date()
): WordMemoryState {
  const rating = typeof grade === 'number' ? grade : gradeToRating(grade);

  // 重建 FSRS Card
  const card = createEmptyCard();
  Object.assign(card, {
    due: new Date(memoryState.fsrsCard.due),
    stability: memoryState.fsrsCard.stability,
    difficulty: memoryState.fsrsCard.difficulty,
    elapsed_days: memoryState.fsrsCard.elapsedDays,
    scheduled_days: memoryState.fsrsCard.scheduledDays,
    learning_steps: memoryState.fsrsCard.learningSteps,
    reps: memoryState.fsrsCard.reps,
    lapses: memoryState.fsrsCard.lapses,
    state: memoryState.fsrsCard.state,
    last_review: memoryState.fsrsCard.lastReview
      ? new Date(memoryState.fsrsCard.lastReview)
      : undefined,
  });

  // 执行 FSRS 复习
  const result = scheduleFsrsReview(card, reviewTime, rating);
  const newCard = result.card;
  const log = result.log;

  // 更新记忆状态
  const newState: WordMemoryState = {
    ...memoryState,
    stability: newCard.stability,
    difficulty: newCard.difficulty,
    lastReview: reviewTime.toISOString(),
    nextReview: newCard.due.toISOString(),
    fsrsCard: {
      due: newCard.due.toISOString(),
      stability: newCard.stability,
      difficulty: newCard.difficulty,
      elapsedDays: newCard.elapsed_days,
      scheduledDays: newCard.scheduled_days,
      learningSteps: newCard.learning_steps,
      reps: newCard.reps,
      lapses: newCard.lapses,
      state: newCard.state,
      lastReview: newCard.last_review?.toISOString(),
    },
    fsrsReviews: [
      ...memoryState.fsrsReviews,
      {
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
      },
    ],
  };

  return newState;
}

/** Revise a saved success and replay its tail without granting duplicate recall credit. */
function reviseHistoricalSuccess(
  state: WordMemoryState,
  index: number,
  evidence: DailyWordEvidence,
  reviewTime: Date,
  userTimezone: string,
  replacement: 'Again' | null,
): WordMemoryState {
  const target = state.fsrsReviews[index];
  const tail = state.fsrsReviews.slice(index);
  const prefix = state.fsrsReviews.slice(0, index);
  const isNew = target.state === 0;
  const previousReview = isNew ? null : target.due;
  const previousDue = isNew ? target.due
    : new Date(Date.parse(target.due) + target.scheduledDays * 24 * 60 * 60 * 1000).toISOString();
  let current: WordMemoryState = { ...state,
    stability: target.stability,
    difficulty: target.difficulty,
    lastReview: previousReview,
    nextReview: previousDue,
    fsrsReviews: prefix,
    fsrsCard: { due: previousDue, stability: target.stability, difficulty: target.difficulty,
      elapsedDays: target.lastElapsedDays, scheduledDays: target.scheduledDays, learningSteps: target.learningSteps,
      reps: Math.max(0, state.fsrsCard.reps - tail.length),
      lapses: Math.max(0, state.fsrsCard.lapses - tail.filter(review => review.rating === 1 && review.state !== 0).length),
      state: target.state, ...(previousReview ? { lastReview: previousReview } : {}) },
  };
  if (replacement) {
    current = submitFsrsReview(current, replacement, reviewTime);
    current.fsrsReviews[current.fsrsReviews.length - 1] = { ...current.fsrsReviews.at(-1)!,
      ...(target.source ? { source: 'reading_lookup' as const, localDate: evidence.localDate } : {}) };
  }
  for (const review of tail.slice(1)) {
    current = submitFsrsReview(current, review.rating as Grade, new Date(review.review));
    current.fsrsReviews[current.fsrsReviews.length - 1] = { ...current.fsrsReviews.at(-1)!,
      ...(review.source ? { source: review.source } : {}),
      ...(review.localDate ? { localDate: review.localDate } : {}),
      ...(review.verificationAttemptIds ? { verificationAttemptIds: review.verificationAttemptIds } : {}),
      ...(review.originalFlashcardRating !== undefined ? { originalFlashcardRating: review.originalFlashcardRating } : {}),
      ...(review.flashcardRevisions ? { flashcardRevisions: review.flashcardRevisions.map(revision => ({ ...revision })) } : {}) };
  }

  // Exposure counters/context remain intact. Recompute only the review-outcome
  // recovery state so the replaced Good cannot keep an earned recovery streak.
  let profile: RmeMemoryProfile = { ...rmeProfileForState(state), consecutiveAgain: 0, recoveryStreak: 0,
    forcedExposure: false, lastReviewGrade: null };
  let previousReviewedAt: number | null = null;
  for (const review of current.fsrsReviews) {
    const grade = review.rating <= 1 ? 'Again' : 'Good';
    const reviewedAt = new Date(review.review);
    const date = getLocalDateInTimeZone(reviewedAt, userTimezone);
    const exposures = profile.exposureHistory.filter(item => item.isValid && item.localDate === date);
    const recentFlashcard = review.source === 'flashcard'
      && (previousReviewedAt === null || reviewedAt.getTime() - previousReviewedAt < 86_400_000);
    const quality = ((review.source === 'verification' || review.source === 'flashcard') && review.rating === 2)
      || recentFlashcard ? 0.6
      : date === evidence.localDate ? evidence.averageRmeQuality ?? 1
      : exposures.length > 0 ? exposures.reduce((sum, item) => sum + item.quality, 0) / exposures.length : 1;
    profile = applyReviewOutcome(profile, grade, reviewedAt, quality);
    previousReviewedAt = reviewedAt.getTime();
  }
  return { ...current, rme: projectRmeProfile(profile, current,
    current.lastReview ? new Date(current.lastReview) : reviewTime) };
}

/**
 * 结算每日词据，提交到 FSRS
 *
 * @param memoryState - 当前记忆状态（如果是新单词则为 null）
 * @param dailyEvidence - 每日词据
 * @param userId - 用户 ID
 * @returns 更新后的记忆状态，如果不需要提交则返回 null
 */
export function finalizeDailyEvidence(
  memoryState: WordMemoryState | null,
  dailyEvidence: DailyWordEvidence,
  userId: string,
  userTimezone: string = getSystemTimeZone()
): WordMemoryState | null {
  const { wordId, pendingGrade } = dailyEvidence;
  const actualTime = actualDailyReviewTime(dailyEvidence, userTimezone);
  const reviewTime = actualTime ?? getUtcInstantForLocalDayEnd(dailyEvidence.localDate, userTimezone);

  const previousIndex = memoryState?.fsrsReviews.findIndex(review =>
    review.source !== 'flashcard'
    && getLocalDateInTimeZone(new Date(review.review), userTimezone) === dailyEvidence.localDate) ?? -1;
  if (memoryState && previousIndex >= 0) {
    const priorReview = memoryState.fsrsReviews[previousIndex];
    const quality = dailyEvidence.averageRmeQuality;
    const measuredOriginal = memoryState.rme?.exposureHistory.some(exposure =>
      exposure.localDate === dailyEvidence.localDate
      && exposure.isValid
      && Date.parse(exposure.occurredAt) === Date.parse(priorReview.review)
      && exposure.quality < 0.8
      && Number.isFinite(exposure.dwellTimeMs) && Number(exposure.dwellTimeMs) >= 0
      && Number.isFinite(exposure.expectedDwellTimeMs) && Number(exposure.expectedDwellTimeMs) > 0);
    // A still-open encounter may reveal its real dwell only after midnight.
    // Only that same timestamp can retract its prematurely credited Good.
    if (pendingGrade !== 'Again' && dailyEvidence.clickedOccurrenceCount === 0
      && priorReview.rating === 3 && actualTime && measuredOriginal
      && actualTime.getTime() === Date.parse(priorReview.review)
      && typeof quality === 'number' && Number.isFinite(quality) && quality >= 0 && quality < 0.8) {
      return reviseHistoricalSuccess(memoryState, previousIndex, dailyEvidence, reviewTime, userTimezone, null);
    }
    if (pendingGrade !== 'Again' || memoryState.fsrsReviews[previousIndex].rating <= 1) return memoryState;
    return reviseHistoricalSuccess(memoryState, previousIndex, dailyEvidence, reviewTime, userTimezone, 'Again');
  }

  // 没有评级时仍允许上面的原始测量修正，但不创建复习。
  if (!pendingGrade) {
    return memoryState;
  }

  // Ordinary reading provides encounter evidence, not a verified successful
  // retrieval. Existing saved reviews above remain authoritative history.
  if (pendingGrade === 'Good') return memoryState;

  // 如果是新单词，初始化记忆状态
  if (!memoryState) {
    memoryState = initializeWordMemory(userId, wordId);
  }

  // 提交 FSRS 复习
  const stateWithRme = memoryState.rme
    ? memoryState
    : { ...memoryState, rme: rmeProfileForState(memoryState) };
  const updatedState = applyRmeReview(
    submitFsrsReview(stateWithRme, pendingGrade, reviewTime),
    pendingGrade,
    reviewTime,
    dailyEvidence.averageRmeQuality ?? 1,
  );
  const last = updatedState.fsrsReviews.length - 1;
  updatedState.fsrsReviews[last] = { ...updatedState.fsrsReviews[last],
    source: 'reading_lookup', localDate: dailyEvidence.localDate };
  return updatedState;
}

/**
 * 批量结算多个单词的每日词据
 *
 * @param memoryStates - 当前记忆状态 Map
 * @param dailyEvidences - 每日词据 Map
 * @param userId - 用户 ID
 * @returns 更新后的记忆状态 Map
 */
export function batchFinalizeDailyEvidence(
  memoryStates: Map<string, WordMemoryState>,
  dailyEvidences: Map<string, DailyWordEvidence>,
  userId: string,
  userTimezone: string = getSystemTimeZone()
): Map<string, WordMemoryState> {
  const updatedStates = new Map<string, WordMemoryState>();

  for (const [wordId, dailyEvidence] of dailyEvidences.entries()) {
    const currentState = memoryStates.get(wordId) || null;
    const updatedState = finalizeDailyEvidence(
      currentState,
      dailyEvidence,
      userId,
      userTimezone
    );

    if (updatedState) {
      updatedStates.set(wordId, updatedState);
    }
  }

  return updatedStates;
}

/**
 * 检查是否需要结算（当天已结束）
 *
 * @param localDate - 自然日（YYYY-MM-DD）
 * @param userTimezone - 用户时区（例如 'Asia/Shanghai'）
 * @returns 是否需要结算
 */
export function shouldFinalize(
  localDate: string,
  userTimezone: string,
  now: Date = new Date()
): boolean {
  const userToday = getLocalDateInTimeZone(now, userTimezone);

  // 如果 localDate 早于今天，需要结算
  return localDate < userToday;
}

/**
 * 获取需要结算的日期列表
 *
 * @param dailyEvidences - 所有未结算的每日词据
 * @param userTimezone - 用户时区
 * @returns 需要结算的日期列表（YYYY-MM-DD）
 */
export function getPendingFinalizationDates(
  dailyEvidences: DailyWordEvidence[],
  userTimezone: string,
  now: Date = new Date()
): string[] {
  const userToday = getLocalDateInTimeZone(now, userTimezone);

  // 筛选未结算且早于今天的日期
  const pendingDates = new Set<string>();

  for (const evidence of dailyEvidences) {
    if (!evidence.finalizedAt && evidence.localDate < userToday) {
      pendingDates.add(evidence.localDate);
    }
  }

  // 按日期排序
  return Array.from(pendingDates).sort();
}

