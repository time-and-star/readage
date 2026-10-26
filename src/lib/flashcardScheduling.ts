import { fsrs, generatorParameters, Rating, State, type Card, type Grade, type ReviewLog } from 'ts-fsrs';

/** Frozen historical policies; V6 separates rehearsal and honors earlier model due times. */
export interface FlashcardSchedulingPolicy {
  version: 1 | 2 | 3 | 4 | 5 | 6;
  desiredRetention: number;
}

export const DEFAULT_DESIRED_RETENTION = 0.9;
// Freeze v1 independently of future changes to the library's default weights.
const FSRS6_V1_WEIGHTS = [0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194,
  0.001, 1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014,
  1.8729, 0.5425, 0.0912, 0.0658, 0.1542];
export function isFlashcardSchedulingPolicy(value: unknown): value is FlashcardSchedulingPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Partial<FlashcardSchedulingPolicy>;
  return (row.version === 1 || row.version === 2 || row.version === 3 || row.version === 4 || row.version === 5 || row.version === 6) && typeof row.desiredRetention === 'number'
    && Number.isFinite(row.desiredRetention) && row.desiredRetention >= 0.8 && row.desiredRetention <= 0.97
    && row.desiredRetention === Math.round(row.desiredRetention * 100) / 100;
}

export function createFlashcardSchedulingPolicy(desiredRetention = DEFAULT_DESIRED_RETENTION,
  version: FlashcardSchedulingPolicy['version'] = 6): FlashcardSchedulingPolicy {
  const policy = { version, desiredRetention };
  if (!isFlashcardSchedulingPolicy(policy)) throw new TypeError('目标保持率必须为 80% 到 97% 的整数百分比。');
  return policy;
}

const schedulers = new Map<string, ReturnType<typeof fsrs>>();
export function getFlashcardScheduler(policy: FlashcardSchedulingPolicy) {
  if (!isFlashcardSchedulingPolicy(policy)) throw new TypeError('词卡复习设置无效。');
  const key = `${policy.version}:${policy.desiredRetention}`;
  let scheduler = schedulers.get(key);
  if (!scheduler) {
    scheduler = fsrs(generatorParameters({
      w: [...FSRS6_V1_WEIGHTS],
      request_retention: policy.desiredRetention,
      maximum_interval: 36500,
      enable_fuzz: false,
      enable_short_term: true,
      // Positive library steps count short-term Good recalls; V5 Hard preserves
      // their progress. V4/V5 replace due times; the queue spaces its rounds.
      learning_steps: policy.version >= 3 ? ['1m', '1m', '3m'] : policy.version === 1 ? ['1m', '10m'] : ['1m'],
      relearning_steps: policy.version >= 3 ? ['1m', '1m', '3m'] : ['10m'],
    }));
    schedulers.set(key, scheduler);
  }
  return scheduler;
}

/** Continuous FSRS-6 interval, before the library's whole-day minimum/rounding. */
export function continuousRecallIntervalMs(stability: number, retention: number): number {
  const decay = FSRS6_V1_WEIGHTS[20];
  const factor = Math.pow(0.9, -1 / decay) - 1;
  return stability * (Math.pow(retention, -1 / decay) - 1) / factor * 86_400_000;
}

export type LearningCard = Card & { confirmation_due?: Date };

/** Explicit learning policy; its steps and next-day confirmation are product choices. */
export function scheduleFlashcardReview(card: LearningCard, at: Date, rating: Grade, policy: FlashcardSchedulingPolicy,
  preserveMemory = false): { card: LearningCard; log: ReviewLog } {
  const result = getFlashcardScheduler(policy).next(card, at, rating);
  delete (result.card as LearningCard).confirmation_due;
  if (preserveMemory) Object.assign(result.card, { stability: card.stability, difficulty: card.difficulty });
  const coordinateConfirmation = (candidate: LearningCard, confirmation: Date): LearningCard => {
    const interval = continuousRecallIntervalMs(candidate.stability, policy.desiredRetention);
    const origin = preserveMemory && card.last_review ? card.last_review.getTime() : at.getTime();
    const modelDue = Math.max(at.getTime() + 60_000, origin + interval);
    const due = new Date(Math.min(confirmation.getTime(), modelDue));
    return { ...candidate, due, scheduled_days: (due.getTime() - at.getTime()) / 86_400_000,
      confirmation_due: confirmation };
  };
  if (policy.version >= 6 && card.confirmation_due && rating !== Rating.Again
    && at.getTime() < card.confirmation_due.getTime() && card.state === State.Review) {
    return { ...result, card: coordinateConfirmation(result.card, card.confirmation_due) };
  }
  if (policy.version === 2 && rating === Rating.Hard) {
    return { ...result, card: { ...result.card, due: new Date(at.getTime() + 86_400_000),
      scheduled_days: 1, state: State.Review, learning_steps: 0 } };
  }
  if (policy.version >= 3) {
    if (rating === Rating.Hard) {
      if (policy.version >= 5) {
        // Mature effortful recall keeps the FSRS interval. Short-term recall
        // preserves completed steps rather than erasing successful learning.
        if (card.state === State.Review) return result;
        return { ...result, card: { ...result.card, due: new Date(at), scheduled_days: 0,
          learning_steps: card.learning_steps,
          state: card.state === State.Relearning ? State.Relearning : State.Learning } };
      }
      // Uncertain recall has not completed short-term learning. Restart the
      // consecutive-success steps, keeping FSRS's actual Hard model result.
      return { ...result, card: { ...result.card, due: new Date(at.getTime() + (policy.version === 4 ? 0 : 60_000)),
        scheduled_days: 0, learning_steps: 0,
        state: card.state === State.Review || card.state === State.Relearning ? State.Relearning : State.Learning } };
    }
    if (rating === Rating.Good && card.state !== State.Review && result.card.state === State.Review) {
      // Three short-term successes finish this learning pass, not long-term
      // mastery. Confirm the result after 24h before using longer intervals.
      const confirmation = new Date(at.getTime() + 86_400_000);
      if (policy.version >= 6) return { ...result, card: coordinateConfirmation(result.card, confirmation) };
      return { ...result, card: { ...result.card, due: confirmation, scheduled_days: 1 } };
    }
    if (policy.version >= 4 && (result.card.state === State.Learning || result.card.state === State.Relearning)) {
      return { ...result, card: { ...result.card, due: new Date(at), scheduled_days: 0 } };
    }
  }
  return result;
}
