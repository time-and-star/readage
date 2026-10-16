import { computeDecayFactor } from 'ts-fsrs';
import { calculateFsrsForgettingCurve, FSRS_ALGORITHM_VERSION, FSRS_PARAMETERS } from './fsrs';
import type { WordMemoryState } from './memoryV2/types';

export type ForgettingCurveHorizon = 1 | 7 | 30;
export interface ForgettingCurvePoint {
  elapsedDays: number;
  percent: number;
  kind: 'reference_fit' | 'reference_observation' | 'prediction';
}
export interface PersonalForgettingCurve {
  status: 'insufficient' | 'limited' | 'ready';
  points: ForgettingCurvePoint[];
  wordCount: number;
  reviewCount: number;
  label: string;
  metric: 'recall_probability';
  metricLabel: string;
  note: string;
  dataNote: string;
  /** Each word uses its own elapsed time here; this is not the aligned x=0 value. */
  currentPercent: number | null;
  lastRecallAt: string | null;
  stabilityDays: number | null;
  /** Valid formal-recall snapshots, one per canonical word, for exact predictions at any time. */
  readonly stabilityDaysByWord: readonly number[];
}
export interface ForgettingCurveModel {
  horizonDays: ForgettingCurveHorizon;
  axisLabel: string;
  reference: {
    points: ForgettingCurvePoint[];
    observations: ForgettingCurvePoint[];
    label: string;
    metric: 'relearning_savings';
    metricLabel: string;
    sourceUrl: string;
    supportingSourceUrl: string;
    note: string;
    formula: string;
  };
  personal: { currentWord: PersonalForgettingCurve; allWords: PersonalForgettingCurve };
  excludedWordCount: number;
  comparisonNote: string;
  fsrs: { algorithm: string; decay: number; factor: number; formula: string; note: string };
}

export const EBBINGHAUS_SOURCE_URL = 'https://home.uni-leipzig.de/wundtbriefe/wwcd/opera/ebbing/memory/Gdaecht7.htm';
export const EBBINGHAUS_METHOD_SOURCE_URL = 'https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0120644';

/** Original 1885 chapter VII §§28–29: observed savings, not percentage recalled. */
export const EBBINGHAUS_OBSERVATIONS: readonly ForgettingCurvePoint[] = Object.freeze([
  { elapsedDays: 19 / 1440, percent: 58.2, kind: 'reference_observation' as const },
  { elapsedDays: 63 / 1440, percent: 44.2, kind: 'reference_observation' as const },
  { elapsedDays: 525 / 1440, percent: 35.8, kind: 'reference_observation' as const },
  { elapsedDays: 1, percent: 33.7, kind: 'reference_observation' as const },
  { elapsedDays: 2, percent: 27.8, kind: 'reference_observation' as const },
  { elapsedDays: 6, percent: 25.4, kind: 'reference_observation' as const },
  { elapsedDays: 31, percent: 21.1, kind: 'reference_observation' as const },
].map(point => Object.freeze(point)));

/** Ebbinghaus' logarithmic fit (§29): t counts minutes from one minute before learning ended. */
export function predictClassicSavingsPercent(elapsedDays: number): number | null {
  if (!Number.isFinite(elapsedDays) || elapsedDays < 0) return null;
  return 100 * 1.84 / (Math.pow(Math.log10(elapsedDays * 1440 + 1), 1.25) + 1.84);
}

/** Same curve and default weights as review scheduling, with invalid inputs kept out of the chart. */
export function predictFsrsRecallPercent(elapsedDays: number, stabilityDays: number): number | null {
  if (!Number.isFinite(elapsedDays) || elapsedDays < 0 || !Number.isFinite(stabilityDays) || stabilityDays <= 0) return null;
  return calculateFsrsForgettingCurve(elapsedDays, stabilityDays) * 100;
}

/** Exact aligned word-library prediction; sampled chart points are only for drawing the line. */
export function predictPersonalRecallPercent(elapsedDays: number, stabilityDaysByWord: readonly number[]): number | null {
  if (!Number.isFinite(elapsedDays) || elapsedDays < 0 || !Array.isArray(stabilityDaysByWord) || !stabilityDaysByWord.length) return null;
  let total = 0;
  for (const stabilityDays of stabilityDaysByWord) {
    const percent = predictFsrsRecallPercent(elapsedDays, stabilityDays);
    if (percent === null) return null;
    total += percent;
  }
  return total / stabilityDaysByWord.length;
}

interface RecallSnapshot {
  wordId: string;
  canonicalWordId: string;
  stabilityDays: number;
  lastRecallAt: string;
  reviewCount: number;
}
const DAY_MS = 86_400_000;
const dated = (value: string | null | undefined) => Date.parse(value ?? '');
const formalRecall = (review: WordMemoryState['fsrsReviews'][number]) =>
  review.source === 'flashcard' || review.source === 'verification';

/** Review logs contain the PRE-review stability. A following log retains the preceding review's result. */
function lastFormalRecall(state: WordMemoryState, canonicalWordId: string, now: Date): RecallSnapshot | null {
  const reviews = state.fsrsReviews;
  if (!reviews.length || !Number.isInteger(state.fsrsCard.reps) || state.fsrsCard.reps < reviews.length
    || !Number.isFinite(state.stability) || state.stability <= 0
    || !Number.isFinite(state.fsrsCard.stability) || state.fsrsCard.stability <= 0
    || Math.abs(state.stability - state.fsrsCard.stability) > 1e-7) return null;
  const latest = dated(state.lastReview);
  if (!Number.isFinite(latest) || latest > now.getTime() || latest !== dated(reviews.at(-1)!.review)
    || (state.fsrsCard.lastReview !== undefined && dated(state.fsrsCard.lastReview) !== latest)) return null;
  let lastIndex = -1;
  let count = 0;
  let previousAt = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < reviews.length; index += 1) {
    const review = reviews[index];
    const at = dated(review.review);
    if (!Number.isFinite(at) || at < previousAt || at > now.getTime()
      || ![1, 2, 3, 4].includes(review.rating)) return null;
    if (formalRecall(review)) { lastIndex = index; count += 1; }
    previousAt = at;
  }
  if (lastIndex < 0) return null;
  const stabilityDays = lastIndex === reviews.length - 1 ? state.fsrsCard.stability : reviews[lastIndex + 1].stability;
  if (!Number.isFinite(stabilityDays) || stabilityDays <= 0) return null;
  return { wordId: state.wordId, canonicalWordId, stabilityDays, lastRecallAt: reviews[lastIndex].review, reviewCount: count };
}

function timeGrid(horizon: ForgettingCurveHorizon): number[] {
  // Resolve the steep early curve from one second to half a day even in a 30-day window.
  const times = new Set([0, 19 / 1440, 63 / 1440, 525 / 1440, 0.5, 1, 2, 6, 7, 30]);
  for (let minutes = 1 / 60; minutes < 720; minutes *= 1.12) times.add(minutes / 1440);
  for (let index = 0; index <= 120; index += 1) times.add(horizon * index / 120);
  return [...times].filter(time => time <= horizon).sort((left, right) => left - right);
}

const PERSONAL_NOTE = '按每词上次正式回忆对齐，假设此后不再学习或复习。采用应用统一参数，尚未拟合个人遗忘参数；0 天的 100% 是模型起点，不是实测成绩。';
function personalCurve(words: readonly RecallSnapshot[], label: string, times: readonly number[], now: Date): PersonalForgettingCurve {
  const reviewCount = words.reduce((sum, word) => sum + word.reviewCount, 0);
  const limited = words.some(word => word.reviewCount < 2);
  const stabilityDaysByWord = Object.freeze(words.map(word => word.stabilityDays));
  return {
    status: !words.length ? 'insufficient' : limited ? 'limited' : 'ready',
    points: words.length ? times.map(elapsedDays => ({ elapsedDays, kind: 'prediction',
      percent: predictPersonalRecallPercent(elapsedDays, stabilityDaysByWord)! })) : [],
    wordCount: words.length, reviewCount, label,
    metric: 'recall_probability', metricLabel: 'FSRS 预测回忆率（%）', note: PERSONAL_NOTE,
    dataNote: !words.length ? '暂无可用正式回忆记录。先完成词卡评分；查词、被动阅读和来源不明的旧记录不生成个人曲线。'
      : limited ? `基于 ${words.length} 个词、${reviewCount} 次正式回忆；部分词仅有 1 次记录，数据仍少，预测会随复习更新。`
        : `基于 ${words.length} 个词、${reviewCount} 次正式回忆。使用应用统一的 FSRS 参数，尚未拟合个人遗忘参数。`,
    currentPercent: words.length ? words.reduce((sum, word) => sum
      + predictFsrsRecallPercent((now.getTime() - dated(word.lastRecallAt)) / DAY_MS, word.stabilityDays)!, 0) / words.length : null,
    lastRecallAt: words.length === 1 ? words[0].lastRecallAt : null,
    stabilityDays: words.length === 1 ? words[0].stabilityDays : null,
    stabilityDaysByWord,
  };
}

/** Pure local projection: no synthetic user observations or writes to memory. */
export function buildForgettingCurveModel(states: readonly WordMemoryState[], {
  now = new Date(), horizonDays = 30, currentWordId, canonicalWordIds,
}: {
  now?: Date;
  horizonDays?: ForgettingCurveHorizon;
  currentWordId?: string;
  canonicalWordIds?: ReadonlyMap<string, string>;
} = {}): ForgettingCurveModel {
  if (!Number.isFinite(now.getTime())) throw new TypeError('Invalid forgetting curve date');
  if (![1, 7, 30].includes(horizonDays)) throw new RangeError('Unsupported forgetting curve horizon');
  const grouped = new Map<string, WordMemoryState[]>();
  for (const state of states) {
    const wordId = canonicalWordIds?.get(state.wordId) ?? state.wordId;
    if (!wordId) continue;
    grouped.set(wordId, [...grouped.get(wordId) ?? [], state]);
  }
  const recalls: RecallSnapshot[] = [];
  for (const [canonicalWordId, group] of grouped) {
    // Follow the same canonical owner policy as the word-card queue and app statistics.
    const state = [...group].sort((left, right) => Number(right.wordId === canonicalWordId) - Number(left.wordId === canonicalWordId)
      || (dated(right.lastReview) || 0) - (dated(left.lastReview) || 0)
      || right.fsrsCard.reps - left.fsrsCard.reps || left.wordId.localeCompare(right.wordId))[0];
    const recall = lastFormalRecall(state, canonicalWordId, now);
    if (recall) recalls.push(recall);
  }
  const currentId = currentWordId && (canonicalWordIds?.get(currentWordId) ?? currentWordId);
  const current = recalls.filter(word => word.canonicalWordId === currentId);
  const times = timeGrid(horizonDays);
  const { decay, factor } = computeDecayFactor(FSRS_PARAMETERS.w);
  return {
    horizonDays, axisLabel: '距上次学习 / 正式复习的天数',
    reference: {
      points: times.map(elapsedDays => ({ elapsedDays, percent: predictClassicSavingsPercent(elapsedDays)!, kind: 'reference_fit' })),
      observations: EBBINGHAUS_OBSERVATIONS.filter(point => point.elapsedDays <= horizonDays).map(point => ({ ...point })),
      label: '艾宾浩斯经典拟合', metric: 'relearning_savings', metricLabel: '重学节省率（%）',
      sourceUrl: EBBINGHAUS_SOURCE_URL, supportingSourceUrl: EBBINGHAUS_METHOD_SOURCE_URL,
      note: '依据艾宾浩斯无意义音节实验的经典拟合；研究点表示重学所节省的学习时间比例。线条是拟合，研究点是观测，不代表你的单词记忆。',
      formula: 'Q(t) = 100 × 1.84 / ((log₁₀(1440t + 1))^1.25 + 1.84)，t 为学习结束后的天数。',
    },
    personal: {
      currentWord: personalCurve(current, '当前词的预测', times, now),
      allWords: personalCurve(recalls, '我的词库平均预测', times, now),
    },
    excludedWordCount: grouped.size - recalls.length,
    comparisonNote: '参考曲线衡量重学节省率，个人曲线预测回忆概率；指标不同，仅用于查看趋势，百分数不能直接比较。',
    fsrs: { algorithm: FSRS_ALGORITHM_VERSION, decay, factor, formula: 'R(t, S) = (1 + factor × t / S)^decay',
      note: 'S 是预测回忆率降到 90% 所需的天数。各词曲线使用上次正式回忆后的稳定性；查词不重置正式回忆起点。' },
  };
}
