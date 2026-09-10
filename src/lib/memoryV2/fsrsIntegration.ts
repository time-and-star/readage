/**
 * FSRS 集成模块
 * 负责将每日评级提交到 FSRS 并更新记忆状态
 */

import {
  fsrs,
  createEmptyCard,
  generatorParameters,
  Rating,
  type Card,
  type RecordLog,
  type Grade,
} from 'ts-fsrs';
import { WordMemoryState, DailyWordEvidence, FsrsGrade } from './types';
import {
  getLocalDateInTimeZone,
  getSystemTimeZone,
  getUtcInstantForLocalDayEnd,
} from './dateUtils';
import { applyRmeReview, rmeProfileForState } from './rmeV4Bridge';

// FSRS 参数配置（与主系统保持一致）
const FSRS_PARAMETERS = generatorParameters({
  request_retention: 0.9,
  maximum_interval: 36500,
  enable_fuzz: false,
  enable_short_term: false,
  learning_steps: [],
  relearning_steps: [],
});

// FSRS 调度器实例
const scheduler = fsrs(FSRS_PARAMETERS);

const MIN_PASSIVE_RECALL_CONTEXTS = 2;

/** Passive no-lookup evidence must repeat across both days and article contexts. */
export function hasSufficientPassiveRecallEvidence(
  memoryState: WordMemoryState | null,
): boolean {
  const lastReviewAt = memoryState?.lastReview
    ? Date.parse(memoryState.lastReview)
    : Number.NEGATIVE_INFINITY;
  const eligible = (memoryState?.rme?.exposureHistory ?? []).filter((exposure) => {
    const occurredAt = Date.parse(exposure.occurredAt);
    return exposure.isValid
      && exposure.quality >= 0.8
      && Number.isFinite(occurredAt)
      && occurredAt > lastReviewAt;
  });
  const articleIds = new Set(eligible.map((exposure) => exposure.articleId));
  const localDates = new Set(eligible.map((exposure) => exposure.localDate));

  return articleIds.size >= MIN_PASSIVE_RECALL_CONTEXTS
    && localDates.size >= MIN_PASSIVE_RECALL_CONTEXTS;
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
  grade: FsrsGrade,
  reviewTime: Date = new Date()
): WordMemoryState {
  const rating = gradeToRating(grade);

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
  const result = scheduler.next(card, reviewTime, rating);
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
  const { wordId, pendingGrade, localDate } = dailyEvidence;

  // 如果没有评级，不提交
  if (!pendingGrade) {
    return memoryState;
  }

  if (
    pendingGrade === 'Good'
    && dailyEvidence.articleEvidence.length > 0
    && !hasSufficientPassiveRecallEvidence(memoryState)
  ) {
    return memoryState;
  }

  // 如果是新单词，初始化记忆状态
  if (!memoryState) {
    memoryState = initializeWordMemory(userId, wordId);
  }

  // 计算复习时间（使用当天结束时刻）
  const reviewTime = getUtcInstantForLocalDayEnd(localDate, userTimezone);

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

