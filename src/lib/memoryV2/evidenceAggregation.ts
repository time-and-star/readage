/**
 * 词据聚合模块
 * 负责将原始事件聚合为文章级和每日级词据
 */

import {
  RawWordEvent,
  ArticleWordEvidence,
  DailyWordEvidence,
  FsrsGrade,
} from './types';

/** Assistance is separate from recall. Missing metadata retains historical semantics. */
export function recallFailureCount(evidence: Pick<ArticleWordEvidence, 'clickedOccurrenceCount' | 'recallFailureCount'>): number {
  return evidence.recallFailureCount ?? evidence.clickedOccurrenceCount;
}

/** Missing exact failure times retain the old aggregate's settlement semantics. */
export function recallFailureTime(evidence: ArticleWordEvidence): string | undefined {
  return recallFailureCount(evidence) > 0 ? evidence.lastRecallFailureAt ?? evidence.lastSeenAt : undefined;
}

export function mergeRecallFailureTime(left: ArticleWordEvidence, right: ArticleWordEvidence): Pick<ArticleWordEvidence, 'lastRecallFailureAt'> {
  if (left.recallFailureCount === undefined && right.recallFailureCount === undefined
    && left.lastRecallFailureAt === undefined && right.lastRecallFailureAt === undefined) return {};
  const latest = [recallFailureTime(left), recallFailureTime(right)].filter((time): time is string => Boolean(time))
    .sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1);
  return latest ? { lastRecallFailureAt: latest } : {};
}

/**
 * 聚合单个文章内的词据
 * 同一文章中的重复出现只记录一条文章级词据
 *
 * @param events - 同一单词在同一文章同一天的所有事件
 * @returns 文章级词据
 */
export function aggregateArticleEvidence(
  events: RawWordEvent[]
): ArticleWordEvidence | null {
  if (events.length === 0) return null;

  // First sightings and additional same-day exposures remain history only.
  const sortedEvents = [...events].sort(
    (a, b) => new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime()
  );
  const seenExposureOccurrences = new Set<string>();
  const exposureEvents = sortedEvents.filter((event) => {
    if (event.eventType !== 'exposure' || event.rmeIsValid === false) return false;
    if (seenExposureOccurrences.has(event.occurrenceId)) return false;
    seenExposureOccurrences.add(event.occurrenceId);
    return true;
  });
  const clickedOccurrences = new Set(
    sortedEvents
      .filter((event) => event.eventType === 'click')
      .map((event) => event.occurrenceId),
  );

  // 统计有效曝光次数
  const validExposureCount = exposureEvents.length;
  const averageRmeQuality = exposureEvents.some((event) => typeof event.rmeQuality === 'number')
    ? exposureEvents.reduce((sum, event) => sum
      + (clickedOccurrences.has(event.occurrenceId) ? 0 : event.rmeQuality ?? 1), 0) / exposureEvents.length
    : undefined;

  // 统计被点击的 occurrence 数量（去重）
  const clickedOccurrenceCount = clickedOccurrences.size;
  const hasLookupOnly = sortedEvents.some(event => event.eventType === 'click' && event.lookupOnly === true);
  const failureEvents = sortedEvents.filter(event => event.eventType === 'click' && !event.lookupOnly);
  const failures = new Set(failureEvents.map(event => event.occurrenceId)).size;

  const first = sortedEvents[0];

  return {
    userId: first.userId,
    wordId: first.wordId,
    articleId: first.articleId,
    localDate: first.localDate,
    validExposureCount,
    clickedOccurrenceCount,
    ...(hasLookupOnly ? { recallFailureCount: failures,
      ...(failureEvents.length ? { lastRecallFailureAt: failureEvents.at(-1)!.occurredAt } : {}) } : {}),
    firstSeenAt: sortedEvents[0].occurredAt,
    lastSeenAt: sortedEvents[sortedEvents.length - 1].occurredAt,
    ...(averageRmeQuality === undefined ? {} : { averageRmeQuality }),
  };
}

/**
 * 从文章级词据判断该文章提供的评级
 *
 * 规则：
 * - validExposureCount = 0 → 不提供证据
 * - clickedOccurrenceCount > 0 → Again
 * - validExposureCount > 0 且 clickedOccurrenceCount = 0 → Good
 */
export function getArticleGrade(evidence: ArticleWordEvidence): FsrsGrade | null {
  if (recallFailureCount(evidence) > 0) {
    return 'Again';
  }

  if (evidence.validExposureCount === 0
    || (evidence.averageRmeQuality !== undefined && evidence.averageRmeQuality < 0.8)) {
    return null; // 不提供证据
  }

  return 'Good';
}

/**
 * 聚合每日词据
 * 合并当天所有文章的证据，并计算最终评级
 *
 * @param articleEvidences - 当天该单词在所有文章中的证据
 * @returns 每日词据
 */
export function aggregateDailyEvidence(
  articleEvidences: ArticleWordEvidence[]
): DailyWordEvidence | null {
  if (articleEvidences.length === 0) return null;

  const first = articleEvidences[0];
  const userId = first.userId;
  const wordId = first.wordId;
  const localDate = first.localDate;

  // 统计总曝光和点击
  let totalExposures = 0;
  let totalClicks = 0;
  let qualityWeightedTotal = 0;
  let qualityWeightedCount = 0;

  for (const evidence of articleEvidences) {
    totalExposures += evidence.validExposureCount;
    totalClicks += evidence.clickedOccurrenceCount;
    if (evidence.averageRmeQuality !== undefined && evidence.validExposureCount > 0) {
      qualityWeightedTotal += evidence.averageRmeQuality * evidence.validExposureCount;
      qualityWeightedCount += evidence.validExposureCount;
    }
  }

  // 计算当天的待定评级
  const pendingGrade = calculateDailyGrade(articleEvidences);

  return {
    userId,
    wordId,
    localDate,
    articleEvidence: articleEvidences,
    articleCount: articleEvidences.length,
    validExposureCount: totalExposures,
    clickedOccurrenceCount: totalClicks,
    ...(articleEvidences.some(row => row.recallFailureCount !== undefined)
      ? { recallFailureCount: articleEvidences.reduce((sum, row) => sum + recallFailureCount(row), 0) } : {}),
    pendingGrade,
    ...(qualityWeightedCount > 0
      ? { averageRmeQuality: qualityWeightedTotal / qualityWeightedCount }
      : {}),
    finalizedAt: null, // 未结算
  };
}

/**
 * 计算当天的最终评级
 *
 * 规则：
 * - 当天没有有效曝光 → null（不提交 FSRS）
 * - 当天任何文章中出现至少一次点击 → Again
 * - 当天至少一次曝光，且所有文章均未点击 → Good
 *
 * 优先级：Again > Good > No Grade
 */
export function calculateDailyGrade(
  articleEvidences: ArticleWordEvidence[]
): FsrsGrade | null {
  if (articleEvidences.length === 0) return null;

  // A lookup is direct failure evidence even when the surrounding paragraph
  // was not visible long enough to count as a successful passive exposure.
  const hasClick = articleEvidences.some((e) => recallFailureCount(e) > 0);
  if (hasClick) {
    return 'Again';
  }

  // 检查是否有有效曝光
  const hasValidExposure = articleEvidences.some((e) => e.validExposureCount > 0
    && (e.averageRmeQuality === undefined || e.averageRmeQuality >= 0.8));
  if (!hasValidExposure) {
    return null;
  }

  // 有曝光且无点击
  return 'Good';
}

/**
 * 更新每日词据的待定评级
 * 用于当天新增事件时实时更新
 *
 * @param dailyEvidence - 当前的每日词据
 * @param newArticleEvidence - 新增的文章级词据
 * @returns 更新后的每日词据
 */
export function updateDailyEvidence(
  dailyEvidence: DailyWordEvidence,
  newArticleEvidence: ArticleWordEvidence
): DailyWordEvidence {
  // 查找是否已存在该文章的证据
  const existingIndex = dailyEvidence.articleEvidence.findIndex(
    (e) => e.articleId === newArticleEvidence.articleId
  );

  let updatedArticleEvidence: ArticleWordEvidence[];

  if (existingIndex >= 0) {
    // 更新现有文章证据
    updatedArticleEvidence = [...dailyEvidence.articleEvidence];
    updatedArticleEvidence[existingIndex] = newArticleEvidence;
  } else {
    // 新增文章证据
    updatedArticleEvidence = [...dailyEvidence.articleEvidence, newArticleEvidence];
  }

  // 重新计算汇总数据
  const totalExposures = updatedArticleEvidence.reduce(
    (sum, e) => sum + e.validExposureCount,
    0
  );
  const totalClicks = updatedArticleEvidence.reduce(
    (sum, e) => sum + e.clickedOccurrenceCount,
    0
  );
  const qualityRows = updatedArticleEvidence.filter(
    (e) => e.averageRmeQuality !== undefined && e.validExposureCount > 0,
  );
  const qualityWeightedCount = qualityRows.reduce((sum, e) => sum + e.validExposureCount, 0);
  const averageRmeQuality = qualityWeightedCount > 0
    ? qualityRows.reduce((sum, e) => sum + (e.averageRmeQuality! * e.validExposureCount), 0)
      / qualityWeightedCount
    : undefined;

  // 重新计算待定评级
  const pendingGrade = calculateDailyGrade(updatedArticleEvidence);

  return {
    ...dailyEvidence,
    articleEvidence: updatedArticleEvidence,
    articleCount: updatedArticleEvidence.length,
    validExposureCount: totalExposures,
    clickedOccurrenceCount: totalClicks,
    ...(updatedArticleEvidence.some(row => row.recallFailureCount !== undefined)
      ? { recallFailureCount: updatedArticleEvidence.reduce((sum, row) => sum + recallFailureCount(row), 0) } : {}),
    pendingGrade,
    ...(averageRmeQuality === undefined ? {} : { averageRmeQuality }),
    finalizedAt: null,
  };
}

/**
 * 批量聚合多个单词的每日词据
 *
 * @param events - 原始事件列表
 * @returns Map<wordId, DailyWordEvidence>
 */
export function batchAggregateDailyEvidence(
  events: RawWordEvent[]
): Map<string, DailyWordEvidence> {
  // 按 wordId + articleId 分组
  const articleGroups = new Map<string, RawWordEvent[]>();

  for (const event of events) {
    const key = `${event.wordId}|${event.articleId}`;
    if (!articleGroups.has(key)) {
      articleGroups.set(key, []);
    }
    articleGroups.get(key)!.push(event);
  }

  // 生成文章级词据
  const articleEvidences: ArticleWordEvidence[] = [];
  for (const group of articleGroups.values()) {
    const evidence = aggregateArticleEvidence(group);
    if (evidence) {
      articleEvidences.push(evidence);
    }
  }

  // 按 wordId 分组
  const wordGroups = new Map<string, ArticleWordEvidence[]>();
  for (const evidence of articleEvidences) {
    if (!wordGroups.has(evidence.wordId)) {
      wordGroups.set(evidence.wordId, []);
    }
    wordGroups.get(evidence.wordId)!.push(evidence);
  }

  // 生成每日词据
  const dailyEvidences = new Map<string, DailyWordEvidence>();
  for (const [wordId, evidences] of wordGroups.entries()) {
    const dailyEvidence = aggregateDailyEvidence(evidences);
    if (dailyEvidence) {
      dailyEvidences.set(wordId, dailyEvidence);
    }
  }

  return dailyEvidences;
}
