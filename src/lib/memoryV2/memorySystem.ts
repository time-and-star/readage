/**
 * Memory V2.2 核心协调模块
 * 统一管理事件记录、词据聚合、FSRS 更新和 MS 计算
 */

import {
  RawWordEvent,
  ArticleWordEvidence,
  DailyWordEvidence,
  WordMemoryState,
  MemoryScoreParams,
  DEFAULT_MS_PARAMS,
  type ReadingVerificationInput,
  type FlashcardReviewInput,
  type FlashcardReviewCorrectionInput,
} from './types';
import { MemoryStorage } from './storage';
import {
  aggregateArticleEvidence,
  aggregateDailyEvidence,
  updateDailyEvidence,
  batchAggregateDailyEvidence,
} from './evidenceAggregation';
import {
  initializeWordMemory,
  finalizeDailyEvidence,
  batchFinalizeDailyEvidence,
  getPendingFinalizationDates,
} from './fsrsIntegration';
import {
  calculateMemoryScore,
  calculateBatchMemoryScores,
  scoreToLevel,
  scoreToLevelWithHysteresis,
} from './memoryScore';
import { hasFormalRecallEvidence, prepareRmeEvent, projectRmeProfile, rmeProfileForState } from './rmeV4Bridge';
import { updateExposureQuality } from '../memoryV4';
import { stageFromConfidence, classifyExposure } from '../memoryV4';
import { appendJournalEvents, importLookupEvents, refreshUserJournals, refreshWordJournal, readExternalLearningActivity } from '../browserExtension/importer';
import { getLocalDateInTimeZone, getSystemTimeZone } from './dateUtils';
import { mergeExposureSnapshot } from './rawEventPersistence';
import { readVerificationHistory, saveVerificationAttempt, saveFlashcardReviewCorrection, replayVerificationEvidence } from './verificationMemory';
import { readFlashcardStudyPreferences, saveFlashcardStudyPreferences, importFlashcardWords,
  repairImportedFlashcardStates, updateFlashcardWords, type FlashcardStudyPreferences } from '../flashcardPreferences';
import { LocalStorageMemoryStorage } from './localStorageImpl';
import { IndexedDbMemoryStorage } from './indexedDbImpl';
import { SqliteMemoryStorage } from './sqliteImpl';
import { repairPassiveReadingRecall } from './passiveRecallRepair';

export interface FlashcardRestoreTarget { wordId: string; relatedWordIds: readonly string[] }

export interface WordProficiencyView {
  wordId: string;
  memoryScore: number;
  level: 0 | 1 | 2 | 3 | 4;
  stability: number;
  difficulty: number;
  nextReview: string;
  lastReview: string | null;
  confidence?: number;
  opportunityScore?: number;
  memoryStage?: 0 | 1 | 2 | 3 | 4;
  isIntroduced?: boolean;
  /** Eligible for the word-card plan; passive reading alone does not count as a new word. */
  isFlashcardEligible?: boolean;
  status?: 'introduced' | 'learning' | 'mastered';
}

export interface WordProficiencyStats {
  total: number;
  byLevel: Record<number, number>;
  averageScore: number;
  introducedCount: number;
  learningCount: number;
  masteredCount: number;
  dueCount: number;
}

export interface MemoryLearningSnapshot {
  proficiencies: WordProficiencyView[];
  dueWords: WordProficiencyView[];
  confirmationWords: WordProficiencyView[];
  stats: WordProficiencyStats;
}

/** Persisted data and projections retained by the shared store, invalidated on external changes. */
export interface MemoryLearningSnapshotCache {
  states: Map<string, WordMemoryState>;
  preferences: FlashcardStudyPreferences;
  views: Map<string, WordProficiencyView>;
  dynamicWordIds: Set<string>;
  projectedAt: number;
  snapshot: MemoryLearningSnapshot;
}

export const DEFAULT_REVIEW_QUEUE_LIMIT = 5;

function applyPersistedClickQuality(
  state: WordMemoryState | null,
  events: RawWordEvent[],
): WordMemoryState | null {
  if (!state?.rme) return state;
  const clicked = events.filter((event) => event.eventType === 'click');
  if (clicked.length === 0) return state;
  let profile = rmeProfileForState(state);
  for (const event of clicked) {
    const exposure = profile.exposureHistory.filter(item =>
      item.occurrenceId === event.occurrenceId && Date.parse(item.occurredAt) <= Date.parse(event.occurredAt))
      .sort((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt))[0];
    if (exposure) profile = updateExposureQuality(profile, event.occurrenceId, 0, exposure.localDate);
  }
  const latestEventAt = events.reduce((latest, event) => {
    const timestamp = new Date(event.occurredAt).getTime();
    return Number.isFinite(timestamp) && timestamp > latest ? timestamp : latest;
  }, Number.NEGATIVE_INFINITY);
  const projectionTime = Number.isFinite(latestEventAt) ? new Date(latestEventAt) : new Date();
  return { ...state, rme: projectRmeProfile(profile, state, projectionTime) };
}

/** Raw events of settled days are pruned; partial late writes cannot erase known evidence. */
function preserveHistoricalArticleEvidence(prior: ArticleWordEvidence | undefined, current: ArticleWordEvidence): ArticleWordEvidence {
  if (!prior) return current;
  return { ...current,
    validExposureCount: Math.max(prior.validExposureCount, current.validExposureCount),
    clickedOccurrenceCount: Math.max(prior.clickedOccurrenceCount, current.clickedOccurrenceCount),
    firstSeenAt: [prior.firstSeenAt, current.firstSeenAt].sort()[0],
    lastSeenAt: [prior.lastSeenAt, current.lastSeenAt].sort().at(-1)!,
    ...(current.averageRmeQuality === undefined && prior.averageRmeQuality !== undefined
      ? { averageRmeQuality: prior.averageRmeQuality } : {}),
  };
}

function addRmeProjection(
  state: WordMemoryState,
  view: WordProficiencyView,
  now: Date,
): WordProficiencyView {
  const projected = projectRmeProfile(rmeProfileForState(state), state, now);
  return {
    ...view,
    confidence: projected.confidence,
    opportunityScore: projected.opportunityScore,
    memoryStage: stageFromConfidence(projected.confidence),
  };
}

/** Keep learning statistics aligned with word-card enrollment and genuine recall history. */
export function projectWordLearningStatus(state: WordMemoryState, preferences: FlashcardStudyPreferences) {
  return learningStatusProjector(preferences)(state);
}
function learningStatusProjector(preferences: FlashcardStudyPreferences) {
  const excludedIds = new Set([...preferences.pausedWordIds ?? [], ...preferences.excludedWordIds ?? []]);
  const enrolledIds = new Set(preferences.importedWordIds);
  return (state: WordMemoryState) => {
  const hasRecall = hasFormalRecallEvidence(state);
  const hasLookup = Number.isFinite(Date.parse(state.lastAssistedAt ?? ''))
    || state.fsrsReviews.some(review => review.source === 'reading_lookup');
  return { isIntroduced: !hasRecall,
    isFlashcardEligible: !excludedIds.has(state.wordId) && (hasRecall || hasLookup || enrolledIds.has(state.wordId)) };
  };
}

function limitWordViews(words: WordProficiencyView[], limit?: number): WordProficiencyView[] {
  return limit === undefined ? words : limit > 0 ? words.slice(0, Math.floor(limit)) : [];
}

function selectDueWords(proficiencies: WordProficiencyView[], now: Date, limit?: number): WordProficiencyView[] {
  const due = proficiencies.filter(word => word.isFlashcardEligible !== false && word.isIntroduced !== true
    && Date.parse(word.nextReview) <= now.getTime());
  due.sort((left, right) => Date.parse(left.nextReview) - Date.parse(right.nextReview) || left.wordId.localeCompare(right.wordId));
  return limitWordViews(due, limit);
}

function selectConfirmationWords(proficiencies: WordProficiencyView[], states: Map<string, WordMemoryState>,
  now: Date, timezone: string, limit?: number): WordProficiencyView[] {
  const today = getLocalDateInTimeZone(now, timezone);
  const anchors = new Map<string, number>();
  const words = proficiencies.filter(word => {
    if (word.isIntroduced !== true) return false;
    const state = states.get(word.wordId);
    if (!state || hasFormalRecallEvidence(state)) return false;
    if (!state.rme && state.fsrsReviews.length === 0) return false;
    const profile = rmeProfileForState(state);
    if (!(profile.successfulExposureCount > 0 && profile.exposureHistory.some(exposure => exposure.isValid && exposure.quality >= 0.8))) return false;
    const anchorAt = Date.parse(profile.lastEffectiveExposureAt ?? '');
    anchors.set(word.wordId, Number.isFinite(anchorAt) ? anchorAt : Number.POSITIVE_INFINITY);
    const lastDay = profile.lastEffectiveLocalDate
      ?? (Number.isFinite(anchorAt) ? getLocalDateInTimeZone(new Date(anchorAt), timezone) : null);
    return classifyExposure({ now, isRecommendation: true, isConfirmation: true,
      localDate: today, previousLocalDate: lastDay, userTimezone: timezone,
      lastExposureAt: profile.lastExposureAt, lastEffectiveExposureAt: profile.lastEffectiveExposureAt,
      firstUnconfirmedExposureAt: profile.firstUnconfirmedExposureAt, lastReviewAt: state.lastAssistedAt,
    }).isValid;
  });
  words.sort((left, right) => (right.opportunityScore ?? 0) - (left.opportunityScore ?? 0)
    || (anchors.get(left.wordId) ?? Number.POSITIVE_INFINITY) - (anchors.get(right.wordId) ?? Number.POSITIVE_INFINITY)
    || left.wordId.localeCompare(right.wordId));
  return limitWordViews(words, limit);
}

function summarizeProficiency(proficiencies: WordProficiencyView[], now: Date): WordProficiencyStats {
  const stats: WordProficiencyStats = { total: 0, byLevel: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 },
    averageScore: 0, introducedCount: 0, learningCount: 0, masteredCount: 0, dueCount: 0 };
  let totalScore = 0;
  for (const word of proficiencies) {
    if (word.isFlashcardEligible === false) continue;
    stats.total++; stats.byLevel[word.level]++; totalScore += word.memoryScore;
    if (word.isIntroduced) stats.introducedCount++;
    else if (word.level === 4) stats.masteredCount++;
    else stats.learningCount++;
    if (!word.isIntroduced && Date.parse(word.nextReview) <= now.getTime()) stats.dueCount++;
  }
  stats.averageScore = stats.total ? totalScore / stats.total : 0;
  return stats;
}

export class MemorySystemV2 {
  private projectWordProficiency(state: WordMemoryState, projectLearning: ReturnType<typeof learningStatusProjector>, now: Date): WordProficiencyView {
    const memoryScore = hasFormalRecallEvidence(state) ? calculateMemoryScore(state, this.params, now) : 0;
    const level = scoreToLevel(memoryScore);
    const learning = projectLearning(state);
    return addRmeProjection(state, {
      wordId: state.wordId, memoryScore, level, stability: state.stability, difficulty: state.difficulty,
      nextReview: state.nextReview, lastReview: state.lastReview, ...learning,
      status: learning.isIntroduced ? 'introduced' : level === 4 ? 'mastered' : 'learning',
    }, now);
  }

  /** One read serves all learning collections; passive paragraph writes refresh only affected words. */
  async getLearningSnapshot(userId: string, now: Date, userTimezone: string,
    previous: MemoryLearningSnapshotCache | null = null, changedWordIds: readonly string[] = []): Promise<MemoryLearningSnapshotCache> {
    let states: Map<string, WordMemoryState>;
    let preferences: FlashcardStudyPreferences;
    let changed: Set<string>;
    if (!previous) {
      const [allStates, loadedPreferences] = await Promise.all([
        this.storage.getAllMemoryStates(userId), this.getFlashcardStudyPreferences(userId),
      ]);
      states = new Map(allStates.map(state => [state.wordId, structuredClone(state)]));
      preferences = loadedPreferences;
      changed = new Set(states.keys());
    } else {
      states = new Map(previous.states);
      preferences = previous.preferences;
      changed = new Set(changedWordIds);
      if (changed.size) {
        const refreshed = await this.storage.getBatchMemoryStates(userId, [...changed]);
        for (const wordId of changed) {
          const state = refreshed.get(wordId);
          if (state) states.set(wordId, structuredClone(state)); else states.delete(wordId);
        }
      }
    }
    const views = new Map(previous?.views ?? []);
    const dynamicWordIds = new Set(previous?.dynamicWordIds ?? []);
    for (const wordId of changed) {
      const state = states.get(wordId);
      // Untouched imported cards have constant zero scores. Learned words retain exact clock-based projections.
      if (state && (state.rme || state.lastReview || state.lastAssistedAt || hasFormalRecallEvidence(state))) dynamicWordIds.add(wordId);
      else dynamicWordIds.delete(wordId);
    }
    const projectIds = new Set(changed);
    if (!previous || previous.projectedAt !== now.getTime()) for (const wordId of dynamicWordIds) projectIds.add(wordId);
    const projectLearning = learningStatusProjector(preferences);
    for (const wordId of projectIds) {
      const state = states.get(wordId);
      if (state) views.set(wordId, this.projectWordProficiency(state, projectLearning, now)); else views.delete(wordId);
    }
    const proficiencies = [...views.values()];
    const snapshot = {
      proficiencies,
      dueWords: selectDueWords(proficiencies, now),
      confirmationWords: selectConfirmationWords(proficiencies, states, now, userTimezone),
      stats: summarizeProficiency(proficiencies, now),
    };
    return { states, preferences, views, dynamicWordIds, projectedAt: now.getTime(), snapshot };
  }

  getMemoryStorageKind(): 'sqlite' | 'indexedDB' | 'localStorage' | 'unknown' {
    return this.storage instanceof LocalStorageMemoryStorage ? 'localStorage'
      : this.storage instanceof IndexedDbMemoryStorage ? 'indexedDB'
      : this.storage instanceof SqliteMemoryStorage ? 'sqlite' : 'unknown';
  }
  getFlashcardStudyPreferences(userId: string) { return readFlashcardStudyPreferences(this.storage, userId); }
  saveFlashcardStudyPreferences(userId: string, dailyNewWordLimit: number | null) {
    return saveFlashcardStudyPreferences(this.storage, userId, dailyNewWordLimit);
  }
  updateFlashcardWords(userId: string, wordIds: string[], action: 'pause' | 'resume' | 'remove') {
    return updateFlashcardWords(this.storage, userId, wordIds, action);
  }
  /** The store holds one write lock; only the final preference write resumes enrollment. */
  async restoreFlashcardWords(userId: string, targets: readonly FlashcardRestoreTarget[], now = new Date()) {
    if (!Number.isFinite(now.getTime())) throw new TypeError('Invalid flashcard restore date');
    const ids = new Set<string>();
    for (const { wordId, relatedWordIds } of targets) {
      await this.seedCanonicalWordMemory(userId, wordId, relatedWordIds);
      if (!await this.storage.getMemoryState(userId, wordId)) {
        const state = initializeWordMemory(userId, wordId);
        state.nextReview = now.toISOString();
        state.fsrsCard.due = now.toISOString();
        await this.storage.saveMemoryState(state);
      }
      ids.add(wordId);
      relatedWordIds.forEach(id => ids.add(id));
    }
    return updateFlashcardWords(this.storage, userId, [...ids], 'resume');
  }
  importFlashcardWords(userId: string, canonicalWordIds: string[], existingCanonicalWordIds?: ReadonlyMap<string, string>, now = new Date()) {
    return importFlashcardWords(this.storage, userId, canonicalWordIds, existingCanonicalWordIds, now,
      (wordId, aliases) => this.seedCanonicalWordMemory(userId, wordId, aliases));
  }
  async getArticleLearningEvidence(userId: string): Promise<ArticleWordEvidence[]> {
    return this.storage.getAllArticleEvidence ? this.storage.getAllArticleEvidence(userId) : [];
  }

  async getVerificationHistory(userId: string) {
    return (await readVerificationHistory(this.storage, userId))
      .filter((attempt): attempt is typeof attempt & ReadingVerificationInput => attempt.purpose !== 'flashcard_review');
  }
  async getFlashcardReviewHistory(userId: string) {
    return (await readVerificationHistory(this.storage, userId))
      .filter((attempt): attempt is typeof attempt & FlashcardReviewInput => attempt.purpose === 'flashcard_review');
  }
  getReadingVerificationMemoryStates(userId: string) { return this.storage.getAllMemoryStates(userId); }

  async recordVerification(userId: string, input: ReadingVerificationInput | FlashcardReviewInput, now = new Date()): Promise<void> {
    await saveVerificationAttempt(this.storage, userId, input, this.timezone, now);
    if (input.purpose === 'immediate_practice') return;
    if (!await refreshWordJournal(this.storage, userId, input.wordId, this.timezone, now)) {
      await this.refreshVerificationWord(userId, input.wordId, now);
    }
  }

  async correctFlashcardReview(userId: string, input: FlashcardReviewCorrectionInput, now = new Date()): Promise<void> {
    await saveFlashcardReviewCorrection(this.storage, userId, input, now);
    if (!await refreshWordJournal(this.storage, userId, input.wordId, this.timezone, now)) {
      await this.refreshVerificationWord(userId, input.wordId, now);
    }
  }

  private async refreshVerificationWord(userId: string, wordId: string, now = new Date()): Promise<void> {
    const attempts = (await readVerificationHistory(this.storage, userId)).filter(attempt => attempt.wordId === wordId);
    const state = await this.storage.getMemoryState(userId, wordId);
    if (!attempts.length && !state?.fsrsReviews.some(review => review.source === 'flashcard')) return;
    const days = this.storage.getWordDailyEvidence ? await this.storage.getWordDailyEvidence(userId, wordId)
      : (await Promise.all([...new Set([...attempts.map(attempt => attempt.localDate),
        ...state?.fsrsReviews.filter(review => review.localDate || Number.isFinite(Date.parse(review.review)))
          .map(review => review.localDate ?? getLocalDateInTimeZone(new Date(review.review), this.timezone)) ?? []])]
        .map(date => this.storage.getDailyEvidence(userId, wordId, date)))).filter((day): day is DailyWordEvidence => Boolean(day));
    const updated = replayVerificationEvidence(state, attempts, this.timezone, days, now);
    if (updated && updated !== state) await this.storage.saveMemoryState(updated);
  }

  getExternalLearningActivity(userId: string) { return readExternalLearningActivity(this.storage, userId); }
  async importExtensionLookups(userId: string, events: unknown, timezone: string, now = new Date()): Promise<string[]> {
    return importLookupEvents(this.storage, userId, events, timezone, now);
  }
  constructor(
    private storage: MemoryStorage,
    private params: MemoryScoreParams = DEFAULT_MS_PARAMS,
    private timezone: string = getSystemTimeZone(),
  ) {}

  /** Preserve one known legacy baseline when a word first adopts its canonical ID. */
  async seedCanonicalWordMemory(userId: string, canonicalWordId: string, legacyWordIds: readonly string[]): Promise<void> {
    const existing = await this.storage.getMemoryState(userId, canonicalWordId);
    if (existing && !existing.fsrsReviews.some(review => review.source === undefined && review.rating === 3)) return;
    const aliases = [...new Set(legacyWordIds)].filter(id => id !== canonicalWordId);
    const originals = aliases.length ? [...(await this.storage.getBatchMemoryStates(userId, aliases)).values()] : [];
    if (existing) {
      const days = await this.readWordDailyEvidence(existing, this.timezone);
      const copiedReviews = new Set(existing.fsrsReviews.map(review => JSON.stringify(review)));
      for (const alias of originals) {
        // Only dictionary-confirmed aliases carrying the exact copied history
        // can supply missing evidence for an existing canonical baseline.
        if (![...alias.fsrsReviews, ...alias.passiveReadingReviews ?? []]
          .some(review => copiedReviews.has(JSON.stringify(review)))) continue;
        days.push(...(await this.readWordDailyEvidence(alias, this.timezone)).map(day => ({ ...day, wordId: canonicalWordId })));
      }
      const updated = repairPassiveReadingRecall(existing, days, this.timezone);
      if (updated !== existing) await this.storage.saveMemoryState(updated);
      return;
    }
    if (!originals.length) return;
    const candidates = await Promise.all(originals
      .map(async state => repairPassiveReadingRecall(state, await this.readWordDailyEvidence(state, this.timezone), this.timezone)));
    const lastKnownAt = (state: WordMemoryState) => Math.max(0,
      Date.parse(state.lastReview ?? '') || 0, Date.parse(state.rme?.lastExposureAt ?? '') || 0);
    candidates.sort((left, right) => (Date.parse(right.lastReview ?? '') || 0) - (Date.parse(left.lastReview ?? '') || 0)
      || lastKnownAt(right) - lastKnownAt(left)
      || left.wordId.localeCompare(right.wordId));
    const baseline = candidates[0];
    if (baseline) await this.storage.saveMemoryState({ ...baseline, wordId: canonicalWordId });
  }

  /** Dictionary-resolved identities allow copied baselines to find their original reading proof. */
  async repairCanonicalRecallHistory(userId: string, canonicalWordIds: ReadonlyMap<string, string>): Promise<string[]> {
    const aliasesByCanonical = new Map<string, string[]>();
    for (const [alias, canonical] of canonicalWordIds) {
      if (!canonical || alias === canonical) continue;
      const aliases = aliasesByCanonical.get(canonical) ?? [];
      aliases.push(alias);
      aliasesByCanonical.set(canonical, aliases);
    }
    if (!aliasesByCanonical.size) return [];
    const states = await this.storage.getBatchMemoryStates(userId, [...aliasesByCanonical.keys()]);
    const changed: string[] = [];
    for (const [canonical, aliases] of aliasesByCanonical) {
      const before = states.get(canonical);
      if (!before?.fsrsReviews.some(review => review.source === undefined && review.rating === 3)) continue;
      await this.seedCanonicalWordMemory(userId, canonical, aliases);
      const after = await this.storage.getMemoryState(userId, canonical);
      if (JSON.stringify(before) !== JSON.stringify(after)) changed.push(canonical);
    }
    return changed;
  }

  private async readWordDailyEvidence(state: WordMemoryState, timezone: string): Promise<DailyWordEvidence[]> {
    if (this.storage.getWordDailyEvidence) return this.storage.getWordDailyEvidence(state.userId, state.wordId);
    const dates = [...new Set(state.fsrsReviews.filter(review => review.localDate || Number.isFinite(Date.parse(review.review)))
      .map(review => review.localDate
      ?? getLocalDateInTimeZone(new Date(review.review), timezone)))];
    return (await Promise.all(dates.map(date => this.storage.getDailyEvidence(state.userId, state.wordId, date))))
      .filter((day): day is DailyWordEvidence => Boolean(day));
  }

  /** Run under the store's existing write lock; retain excluded logs for audit. */
  private async repairPassiveRecallHistory(userId: string, timezone: string, now: Date): Promise<void> {
    const candidates = (await this.storage.getAllMemoryStates(userId))
      .filter(state => state.fsrsReviews.some(review => review.source === undefined && review.rating === 3));
    if (!candidates.length) return;
    const daysByWord = new Map<string, DailyWordEvidence[]>();
    if (this.storage.getAllDailyEvidence) {
      for (const day of await this.storage.getAllDailyEvidence(userId)) {
        const rows = daysByWord.get(day.wordId) ?? [];
        rows.push(day);
        daysByWord.set(day.wordId, rows);
      }
    }
    for (const state of candidates) {
      const days = this.storage.getAllDailyEvidence ? daysByWord.get(state.wordId) ?? []
        : await this.readWordDailyEvidence(state, timezone);
      const updated = repairPassiveReadingRecall(state, days, timezone, now);
      if (updated !== state) await this.storage.saveMemoryState(updated);
    }
  }

  /**
   * 记录原始事件
   * 实时更新文章级和每日级词据
   */
  async recordEvent(event: RawWordEvent): Promise<void> {
    if (await appendJournalEvents(this.storage, [event], this.timezone, new Date())) return;
    await this.storage.prefetchEventBatch?.([event]);
    const { userId, wordId, articleId, localDate } = event;
    const currentState = await this.storage.getMemoryState(userId, wordId);
    const previousRaw = (await this.storage.getRawEventsByDate(userId, wordId, localDate))
      .find(prior => prior.occurrenceId === event.occurrenceId
        && prior.eventType === event.eventType && prior.occurredAt === event.occurredAt);
    const prepared = prepareRmeEvent(currentState,
      previousRaw ? mergeExposureSnapshot(previousRaw, event) ?? event : event, this.timezone);
    const normalizedEvent = prepared.event;

    // 1. 保存原始事件
    await this.storage.saveRawEvent(normalizedEvent);

    // 2. 获取当天该单词在该文章中的所有事件
    const articleEvents = await this.storage.getRawEventsByDate(userId, wordId, localDate);
    const articleSpecificEvents = articleEvents.filter((e) => e.articleId === articleId);

    const correctedState = applyPersistedClickQuality(prepared.state ?? currentState, articleEvents);
    if (correctedState && correctedState !== prepared.state) await this.storage.saveMemoryState(correctedState);

    // 3. 聚合文章级词据
    let dailyEvidence = await this.storage.getDailyEvidence(userId, wordId, localDate);
    const hasHistoricalReview = Boolean(dailyEvidence?.finalizedAt)
      || Boolean(currentState?.fsrsReviews.some(review => getLocalDateInTimeZone(new Date(review.review), this.timezone) === localDate));
    const aggregated = aggregateArticleEvidence(articleSpecificEvents);
    const articleEvidence = aggregated && hasHistoricalReview
      ? preserveHistoricalArticleEvidence(dailyEvidence?.articleEvidence.find(row => row.articleId === articleId), aggregated)
      : aggregated;
    if (articleEvidence) {
      await this.storage.saveArticleEvidence(articleEvidence);
    }

    // 4. 获取当天所有文章的词据
    const allArticleEvidences = await this.storage.getArticleEvidencesByDate(
      userId,
      wordId,
      localDate
    );

    // 5. 聚合或更新每日词据
    if (!dailyEvidence) {
      // 首次创建
      dailyEvidence = aggregateDailyEvidence(allArticleEvidences);
    } else if (articleEvidence) {
      // 更新现有词据
      dailyEvidence = updateDailyEvidence(dailyEvidence, articleEvidence);
    }

    if (dailyEvidence) {
      await this.storage.saveDailyEvidence(dailyEvidence);
    }

    if (correctedState) await this.storage.saveMemoryState(correctedState);
    await this.refreshVerificationWord(userId, wordId);
  }

  /**
   * 批量记录事件（用于离线同步或批量导入）
   */
  async recordBatchEvents(events: RawWordEvent[]): Promise<void> {
    if (events.length === 0) return;

    const groups = new Map<string, RawWordEvent[]>();
    for (const event of events) {
      const key = JSON.stringify([event.userId, event.wordId]);
      groups.set(key, [...(groups.get(key) ?? []), event]);
    }
    const remaining: RawWordEvent[] = [];
    for (const group of groups.values()) {
      if (!await appendJournalEvents(this.storage, group, this.timezone, new Date())) remaining.push(...group);
    }
    events = remaining;
    if (!events.length) return;
    await this.storage.prefetchEventBatch?.(events);

    const preparedEvents: RawWordEvent[] = [];
    const preparedStates = new Map<string, WordMemoryState | null>();
    for (const event of events) {
      const key = `${event.userId}:${event.wordId}`;
      const current = preparedStates.has(key)
        ? preparedStates.get(key) || null
        : await this.storage.getMemoryState(event.userId, event.wordId);
      const sameEncounter = (prior: RawWordEvent) => prior.occurrenceId === event.occurrenceId
        && prior.eventType === event.eventType && prior.occurredAt === event.occurredAt;
      const previousRaw = preparedEvents.filter(prior => prior.userId === event.userId
        && prior.wordId === event.wordId).reverse().find(sameEncounter)
        ?? (await this.storage.getRawEventsByDate(event.userId, event.wordId, event.localDate)).find(sameEncounter);
      const prepared = prepareRmeEvent(current,
        previousRaw ? mergeExposureSnapshot(previousRaw, event) ?? event : event, this.timezone);
      preparedEvents.push(prepared.event);
      preparedStates.set(key, prepared.state);
    }

    // 1. Persist the raw batch before rebuilding derived evidence.
    await this.storage.saveRawEvents(preparedEvents);

    for (const [key, state] of preparedStates.entries()) {
      if (!state) continue;
      const relevantEvents = preparedEvents.filter((event) =>
        event.userId === state?.userId && event.wordId === state?.wordId
      );
      const persistedEvents = (await Promise.all([...new Set(relevantEvents.map(event => event.localDate))]
        .map(date => this.storage.getRawEventsByDate(state.userId, state.wordId, date)))).flat();
      const corrected = applyPersistedClickQuality(state, persistedEvents);
      preparedStates.set(key, corrected);
      if (corrected) await this.storage.saveMemoryState(corrected);
    }

    // 2. Collect each affected user + word + date combination.
    const affectedWordDates = new Map<string, RawWordEvent>();
    for (const event of events) {
      const key = JSON.stringify([event.userId, event.wordId, event.localDate]);
      affectedWordDates.set(key, event);
    }

    // 3. Rebuild from all persisted events so existing same-day evidence is preserved.
    for (const event of affectedWordDates.values()) {
      const persistedEvents = await this.storage.getRawEventsByDate(
        event.userId,
        event.wordId,
        event.localDate
      );
      let dailyEvidence = batchAggregateDailyEvidence(persistedEvents).get(event.wordId);
      if (!dailyEvidence) continue;

      const previousDaily = await this.storage.getDailyEvidence(event.userId, event.wordId, event.localDate);
      const currentState = preparedStates.get(`${event.userId}:${event.wordId}`);
      const hasHistoricalReview = Boolean(previousDaily?.finalizedAt)
        || Boolean(currentState?.fsrsReviews.some(review => getLocalDateInTimeZone(new Date(review.review), this.timezone) === event.localDate));
      if (hasHistoricalReview && previousDaily) {
        const articles = new Map(previousDaily.articleEvidence.map(row => [row.articleId, row]));
        for (const row of dailyEvidence.articleEvidence) articles.set(row.articleId,
          preserveHistoricalArticleEvidence(articles.get(row.articleId), row));
        dailyEvidence = aggregateDailyEvidence([...articles.values()])!;
      }

      // 4. Persist the complete daily and per-article evidence.
      await this.storage.saveDailyEvidence(dailyEvidence);
      for (const articleEvidence of dailyEvidence.articleEvidence) {
        await this.storage.saveArticleEvidence(articleEvidence);
      }
    }
    for (const group of groups.values()) await this.refreshVerificationWord(group[0].userId, group[0].wordId);
  }

  /**
   * 结算历史未结算的日期
   * 在应用启动或用户进入新一天时调用
   */
  async finalizeHistoricalDates(userId: string, userTimezone: string): Promise<void> {
    await this.repairPassiveRecallHistory(userId, userTimezone, new Date());
    await repairImportedFlashcardStates(this.storage, userId, new Date(),
      (wordId, aliases) => this.seedCanonicalWordMemory(userId, wordId, aliases));
    // Also recovers an interrupted import, even when some days were already marked finalized.
    await refreshUserJournals(this.storage, userId, userTimezone, new Date());
    const verificationWords = [...new Set((await readVerificationHistory(this.storage, userId)).map(attempt => attempt.wordId))];
    for (const wordId of verificationWords) await this.refreshVerificationWord(userId, wordId);
    // 1. 获取所有未结算的每日词据
    const unfinalizedEvidences = await this.storage.getUnfinalizedDailyEvidence(userId);

    // 2. 找出需要结算的日期
    const pendingDates = getPendingFinalizationDates(unfinalizedEvidences, userTimezone);

    if (pendingDates.length === 0) return;

    // 3. 按日期结算
    for (const localDate of pendingDates) {
      await this.finalizeDate(userId, localDate, userTimezone);
    }
  }

  /**
   * 结算指定日期的所有单词
   */
  private async finalizeDate(
    userId: string,
    localDate: string,
    userTimezone: string
  ): Promise<void> {
    // 1. 获取该日期的所有未结算词据
    const dailyEvidences = await this.storage.getUnfinalizedDailyEvidenceByDate(
      userId,
      localDate
    );

    if (dailyEvidences.length === 0) return;

    // 2. 获取所有涉及单词的记忆状态
    const wordIds = dailyEvidences.map((e) => e.wordId);
    const memoryStates = await this.storage.getBatchMemoryStates(userId, wordIds);

    // 3. 批量结算并更新 FSRS
    const updatedStates = batchFinalizeDailyEvidence(
      memoryStates,
      new Map(dailyEvidences.map((e) => [e.wordId, e])),
      userId,
      userTimezone
    );

    // 4. 保存更新后的记忆状态
    for (const state of updatedStates.values()) {
      await this.storage.saveMemoryState(state);
    }

    // A late reading lookup can precede an already saved word-card review.
    // Rebuild before marking the day complete, so an interrupted write retries.
    for (const wordId of wordIds) await this.refreshVerificationWord(userId, wordId);

    // 5. 标记所有词据为已结算，并清理已结算日的 raw events 以控制存储体积
    const now = new Date().toISOString();
    for (const evidence of dailyEvidences) {
      await this.storage.deleteRawEventsByDate(userId, evidence.wordId, localDate);
      await this.storage.markDailyEvidenceFinalized(
        userId,
        evidence.wordId,
        localDate,
        now
      );
    }
  }

  /**
   * 获取单词的熟练度视图（包含实时 MS 和等级）
   */
  async getWordProficiency(
    userId: string,
    wordId: string,
    currentTime: Date = new Date()
  ): Promise<WordProficiencyView | null> {
    const [memoryState, preferences] = await Promise.all([
      this.storage.getMemoryState(userId, wordId), this.getFlashcardStudyPreferences(userId),
    ]);

    if (!memoryState) {
      return null;
    }

    const memoryScore = hasFormalRecallEvidence(memoryState)
      ? calculateMemoryScore(memoryState, this.params, currentTime) : 0;
    const level = scoreToLevel(memoryScore);
    const learning = projectWordLearningStatus(memoryState, preferences);

    return addRmeProjection(memoryState, {
      wordId,
      memoryScore,
      level,
      stability: memoryState.stability,
      difficulty: memoryState.difficulty,
      nextReview: memoryState.nextReview,
      lastReview: memoryState.lastReview,
      ...learning,
      status: learning.isIntroduced
        ? 'introduced'
        : level === 4 ? 'mastered' : 'learning',
    }, currentTime);
  }

  /**
   * 批量获取多个单词的熟练度
   */
  async getBatchWordProficiency(
    userId: string,
    wordIds: string[],
    currentTime: Date = new Date()
  ): Promise<Map<string, WordProficiencyView>> {
    const [memoryStates, preferences] = await Promise.all([
      this.storage.getBatchMemoryStates(userId, wordIds), this.getFlashcardStudyPreferences(userId),
    ]);
    const scores = calculateBatchMemoryScores(
      Array.from(memoryStates.values()),
      this.params,
      currentTime
    );

    const proficiencies = new Map<string, WordProficiencyView>();
    const projectLearning = learningStatusProjector(preferences);

    for (const [wordId, memoryState] of memoryStates.entries()) {
      const memoryScore = hasFormalRecallEvidence(memoryState) ? scores.get(wordId) || 0 : 0;
      const level = scoreToLevel(memoryScore);
      const learning = projectLearning(memoryState);

      proficiencies.set(wordId, addRmeProjection(memoryState, {
        wordId,
        memoryScore,
        level,
        stability: memoryState.stability,
        difficulty: memoryState.difficulty,
        nextReview: memoryState.nextReview,
        lastReview: memoryState.lastReview,
        ...learning,
        status: learning.isIntroduced
          ? 'introduced'
          : level === 4 ? 'mastered' : 'learning',
      }, currentTime));
    }

    return proficiencies;
  }

  /**
   * 获取所有单词的熟练度
   */
  async getAllWordProficiency(
    userId: string,
    currentTime: Date = new Date()
  ): Promise<WordProficiencyView[]> {
    const [memoryStates, preferences] = await Promise.all([
      this.storage.getAllMemoryStates(userId), this.getFlashcardStudyPreferences(userId),
    ]);
    const scores = calculateBatchMemoryScores(memoryStates, this.params, currentTime);
    const projectLearning = learningStatusProjector(preferences);

    return memoryStates.map((state) => {
      const memoryScore = hasFormalRecallEvidence(state) ? scores.get(state.wordId) || 0 : 0;
      const level = scoreToLevel(memoryScore);
      const learning = projectLearning(state);

      return addRmeProjection(state, {
        wordId: state.wordId,
        memoryScore,
        level,
        stability: state.stability,
        difficulty: state.difficulty,
        nextReview: state.nextReview,
        lastReview: state.lastReview,
        ...learning,
        status: learning.isIntroduced
          ? 'introduced'
          : level === 4 ? 'mastered' : 'learning',
      }, currentTime);
    });
  }

  /**
   * 获取需要复习的单词
   */
  async getDueWords(
    userId: string,
    currentTime: Date = new Date(),
    limit?: number
  ): Promise<WordProficiencyView[]> {
    return selectDueWords(await this.getAllWordProficiency(userId, currentTime), currentTime, limit);
  }

  /**
   * Return spaced reading encounters awaiting their first formal recall.
   * Additional passive exposures cannot complete that confirmation step.
   */
  async getConfirmationWords(
    userId: string,
    currentTime: Date = new Date(),
    limit?: number,
    userTimezone: string = getSystemTimeZone(),
  ): Promise<WordProficiencyView[]> {
    const snapshot = await this.getLearningSnapshot(userId, currentTime, userTimezone);
    return limitWordViews(snapshot.snapshot.confirmationWords, limit);
  }

  /**
   * 获取熟练度统计
   */
  async getProficiencyStats(
    userId: string,
    currentTime: Date = new Date(),
  ): Promise<WordProficiencyStats> {
    return summarizeProficiency(await this.getAllWordProficiency(userId, currentTime), currentTime);
  }
}
