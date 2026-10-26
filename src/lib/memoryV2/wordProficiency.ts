import type { FlashcardStudyPreferences } from '../flashcardPreferences';
import { stageFromConfidence } from '../memoryV4';
import { calculateLongTermMemoryScore, scoreToLevel } from './memoryScore';
import { hasFormalRecallEvidence, projectRmeProfile, rmeProfileForState } from './rmeV4Bridge';
import { DEFAULT_MS_PARAMS, type MemoryScoreParams, type WordMemoryState } from './types';
import { projectUnratedFlashcardPractice } from '../flashcardPractice';

export type WordStudyStatus = 'observed' | 'new' | 'due' | 'learning' | 'familiar' | 'paused' | 'removed';

export interface WordProficiencyView {
  wordId: string;
  memoryScore: number;
  level: 0 | 1 | 2 | 3 | 4;
  stability: number;
  difficulty: number;
  nextReview: string;
  lastReview: string | null;
  /** Derived owner tie-breaker; never persisted as a separate learning state. */
  fsrsReps?: number;
  confidence?: number;
  /** Current estimated failure probability, independent of long-term level. */
  forgettingRiskPercent?: number;
  opportunityScore?: number;
  memoryStage?: 0 | 1 | 2 | 3 | 4;
  isIntroduced?: boolean;
  /** Lookup evidence belongs to the selected history, independently of enrollment. */
  hasLookup?: boolean;
  hasPractice?: boolean;
  /** Eligible for the word-card plan; passive reading alone does not count as a new word. */
  isFlashcardEligible?: boolean;
  status?: 'introduced' | 'learning' | 'mastered';
  /** Active plan status is independent of the historical proficiency level. */
  studyStatus?: WordStudyStatus;
}

export interface WordLearningStatus {
  hasRecall: boolean;
  hasPractice?: boolean;
  hasLookup: boolean;
  isEnrolled: boolean;
  isPaused: boolean;
  isRemoved: boolean;
  isIntroduced: boolean;
  isFlashcardEligible: boolean;
}

export type WordLearningStatusProjector = (state: WordMemoryState | null, canonicalWordId?: string) => WordLearningStatus;

function createLearningFactsProjector(preferences: FlashcardStudyPreferences) {
  const pausedIds = new Set(preferences.pausedWordIds ?? []);
  const removedIds = new Set(preferences.excludedWordIds ?? []);
  const enrolledIds = new Set(preferences.importedWordIds);
  return (hasRecall: boolean, hasLookup: boolean, wordId: string, canonicalWordId = wordId): WordLearningStatus => {
    const inList = (ids: ReadonlySet<string>) => ids.has(canonicalWordId) || ids.has(wordId);
    const isEnrolled = inList(enrolledIds);
    const isPaused = inList(pausedIds);
    const isRemoved = inList(removedIds);
    return { hasRecall, hasLookup, isEnrolled, isPaused, isRemoved, isIntroduced: !hasRecall,
      isFlashcardEligible: !isPaused && !isRemoved && (hasRecall || hasLookup || isEnrolled) };
  };
}

/** Resolve enrollment once for a batch, while preserving a selected alias's own preferences. */
export function createWordLearningStatusProjector(preferences: FlashcardStudyPreferences): WordLearningStatusProjector {
  const project = createLearningFactsProjector(preferences);
  return (state, canonicalWordId = state?.wordId ?? '') => {
    const learning = project(hasFormalRecallEvidence(state), Boolean(state && (Number.isFinite(Date.parse(state.lastAssistedAt ?? ''))
      || state.fsrsReviews.some(review => review.source === 'reading_lookup'))), state?.wordId ?? '', canonicalWordId);
    const hasPractice = Boolean(projectUnratedFlashcardPractice(state));
    return { ...learning, hasPractice, isFlashcardEligible: learning.isFlashcardEligible
      || hasPractice && !learning.isPaused && !learning.isRemoved };
  };
}

export function projectWordLearningStatus(state: WordMemoryState | null, preferences: FlashcardStudyPreferences,
  canonicalWordId = state?.wordId ?? ''): WordLearningStatus {
  return createWordLearningStatusProjector(preferences)(state, canonicalWordId);
}

/** A plan can pause or remove a word without changing its recall evidence or proficiency. */
export function projectWordStudyStatus(learning: WordLearningStatus, nextReview: string | null,
  level: WordProficiencyView['level'], now: Date): WordStudyStatus {
  if (learning.isRemoved) return 'removed';
  if (learning.isPaused) return 'paused';
  if (!learning.hasRecall && !learning.hasPractice) return learning.hasLookup || learning.isEnrolled ? 'new' : 'observed';
  if (nextReview && Date.parse(nextReview) <= now.getTime()) return 'due';
  return level === 4 ? 'familiar' : 'learning';
}

/** Reapply resolved preferences to the selected history, without borrowing evidence from an alias. */
export function createWordProficiencyPreferencesProjector(preferences: FlashcardStudyPreferences, now = new Date()) {
  const project = createLearningFactsProjector(preferences);
  return (view: WordProficiencyView, canonicalWordId = view.wordId): WordProficiencyView => {
    const learning = project(view.isIntroduced !== true, view.hasLookup ?? false, view.wordId, canonicalWordId);
    return { ...view, wordId: canonicalWordId, isFlashcardEligible: learning.isFlashcardEligible
      || Boolean(view.hasPractice) && !learning.isPaused && !learning.isRemoved,
      studyStatus: projectWordStudyStatus({ ...learning, hasPractice: view.hasPractice }, view.nextReview, view.level, now) };
  };
}

/** One read-only projection for reading, word cards, details and learning statistics. */
export function projectWordProficiency(state: WordMemoryState, preferences: FlashcardStudyPreferences,
  now = new Date(), params: MemoryScoreParams = DEFAULT_MS_PARAMS, canonicalWordId = state.wordId,
  projectLearning: WordLearningStatusProjector = createWordLearningStatusProjector(preferences)): WordProficiencyView {
  const learning = projectLearning(state, canonicalWordId);
  const practice = projectUnratedFlashcardPractice(state);
  const nextReview = practice?.due ?? state.nextReview;
  const memoryScore = learning.hasRecall ? calculateLongTermMemoryScore(state, params) : 0;
  const level = scoreToLevel(memoryScore);
  const projected = projectRmeProfile(rmeProfileForState(state), state, now);
  return {
    wordId: canonicalWordId, memoryScore, level, stability: state.stability, difficulty: state.difficulty,
    nextReview, lastReview: state.lastReview, fsrsReps: state.fsrsCard.reps,
    confidence: projected.confidence, forgettingRiskPercent: learning.hasRecall ? 100 - projected.confidence : undefined,
    opportunityScore: projected.opportunityScore,
    memoryStage: stageFromConfidence(projected.confidence),
    isIntroduced: learning.isIntroduced, hasLookup: learning.hasLookup, hasPractice: Boolean(practice), isFlashcardEligible: learning.isFlashcardEligible,
    status: learning.isIntroduced && !practice ? 'introduced' : level === 4 ? 'mastered' : 'learning',
    studyStatus: projectWordStudyStatus(learning, nextReview, level, now),
  };
}
