/**
 * Memory Score 计算模块
 *
 * MS(t) = 100 × R(t, S)^γ × M(S)
 * M(S) = min(1, ln(1 + S) / ln(1 + S_cap))
 */

import { WordMemoryState, MemoryScoreParams, DEFAULT_MS_PARAMS } from './types';
import { calculateFsrsForgettingCurve } from '../fsrs';

/**
 * 计算当前回忆概率 R(t, S)
 * 基于 FSRS 的遗忘曲线
 *
 * @param daysSinceReview - 距离上次复习的天数
 * @param stability - FSRS Stability (天)
 * @returns 0-1 之间的回忆概率
 */
export function calculateRetention(daysSinceReview: number, stability: number): number {
  return calculateFsrsForgettingCurve(daysSinceReview, stability);
}

/**
 * 计算长期掌握度调节因子 M(S)
 * 避免"刚能记住"被误判为长期掌握
 *
 * @param stability - FSRS Stability (天)
 * @param S_cap - 产品定义的满级稳定天数
 * @returns 0-1 之间的调节因子
 */
export function calculateMasteryModifier(stability: number, S_cap: number): number {
  if (stability <= 0) return 0;

  // M(S) = min(1, ln(1 + S) / ln(1 + S_cap))
  const modifier = Math.log(1 + stability) / Math.log(1 + S_cap);
  return Math.min(1, modifier);
}

/**
 * 计算 Memory Score
 *
 * @param memoryState - FSRS 记忆状态
 * @param params - MS 计算参数
 * @param currentTime - 当前时间（用于计算距上次复习的天数）
 * @returns 0-100 的记忆分数
 */
export function calculateMemoryScore(
  memoryState: WordMemoryState,
  params: MemoryScoreParams = DEFAULT_MS_PARAMS,
  currentTime: Date = new Date()
): number {
  const { stability } = memoryState;
  const { S_cap, gamma } = params;

  // 如果从未复习，返回 0
  if (
    !memoryState.lastReview
    || !Number.isFinite(stability)
    || stability <= 0
    || !Number.isFinite(S_cap)
    || S_cap <= 0
    || !Number.isFinite(gamma)
    || gamma < 0
  ) {
    return 0;
  }

  // 计算距上次复习的天数
  const lastReviewTime = Date.parse(memoryState.lastReview);
  if (!Number.isFinite(lastReviewTime) || !Number.isFinite(currentTime.getTime())) {
    return 0;
  }
  const daysSinceReview = (currentTime.getTime() - lastReviewTime) / (1000 * 60 * 60 * 24);

  // 计算回忆概率 R(t, S)
  const retention = calculateRetention(daysSinceReview, stability);

  // 计算长期掌握度调节因子 M(S)
  const masteryModifier = calculateMasteryModifier(stability, S_cap);

  // MS(t) = 100 × R(t, S)^γ × M(S)
  const score = 100 * Math.pow(retention, gamma) * masteryModifier;

  return Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : 0;
}

/**
 * 根据 Memory Score 映射到 L0-L4 等级
 *
 * @param score - Memory Score (0-100)
 * @returns 熟练度等级 (0-4)
 */
export function scoreToLevel(score: number): 0 | 1 | 2 | 3 | 4 {
  if (!Number.isFinite(score) || score < 20) return 0;
  if (score < 40) return 1;
  if (score < 60) return 2;
  if (score < 85) return 3;
  return 4;
}

/**
 * 带滞后带的等级映射（避免边界频繁跳动）
 *
 * @param score - 当前 Memory Score
 * @param lastLevel - 上次显示的等级
 * @param buffer - 滞后带宽度（默认 3）
 * @returns 新的显示等级
 */
export function scoreToLevelWithHysteresis(
  score: number,
  lastLevel: 0 | 1 | 2 | 3 | 4,
  buffer: number = 3
): 0 | 1 | 2 | 3 | 4 {
  const newLevel = scoreToLevel(score);

  // 如果没有跨越等级边界，保持原等级
  if (newLevel === lastLevel) {
    return lastLevel;
  }

  // 计算边界
  const boundaries = [0, 20, 40, 60, 85, 100];

  // 上升：需要超过新等级的下边界 + buffer
  if (newLevel > lastLevel) {
    const threshold = boundaries[newLevel] + buffer;
    if (score >= threshold) {
      return newLevel;
    }
    return lastLevel;
  }

  // 下降：需要低于旧等级的下边界 - buffer
  if (newLevel < lastLevel) {
    const threshold = boundaries[lastLevel] - buffer;
    if (score <= threshold) {
      return newLevel;
    }
    return lastLevel;
  }

  return newLevel;
}

/**
 * 批量计算多个单词的 Memory Score
 */
export function calculateBatchMemoryScores(
  memoryStates: WordMemoryState[],
  params: MemoryScoreParams = DEFAULT_MS_PARAMS,
  currentTime: Date = new Date()
): Map<string, number> {
  const scores = new Map<string, number>();

  for (const state of memoryStates) {
    const score = calculateMemoryScore(state, params, currentTime);
    scores.set(state.wordId, score);
  }

  return scores;
}
