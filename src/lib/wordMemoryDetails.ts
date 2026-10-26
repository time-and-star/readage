import type { FlashcardStudyPreferences } from './flashcardPreferences';
import type { MemoryScoreParams, WordMemoryState } from './memoryV2/types';
import { projectWordProficiency, projectWordLearningStatus, projectWordStudyStatus,
  type WordProficiencyView, type WordStudyStatus } from './memoryV2/wordProficiency';
import { selectCanonicalMemoryState } from './memoryV2/wordIdentity';
export type { WordStudyStatus } from './memoryV2/wordProficiency';

export const RECOGNITION_LEVEL_LABELS = ['尚未稳定', '初步记忆', '逐渐熟悉', '较为熟悉', '长期稳定'] as const;
export const FLASHCARD_RATING_LABELS: Record<number, string> = { 1: '不认识', 2: '记不稳', 3: '认识', 4: '轻松（历史评分）' };

/** Historical learned counts and the active study queues have different, explicit scopes. */
export function summarizeWordLearningViews(words: readonly WordProficiencyView[], now = new Date()) {
  return words.reduce((counts, word) => {
    if (word.isIntroduced) {
      if (word.isFlashcardEligible !== false && !word.hasPractice) counts.introduced += 1;
      if (word.hasPractice && word.isFlashcardEligible !== false && Date.parse(word.nextReview) <= now.getTime()) counts.due += 1;
    } else {
      counts.learned += 1;
      if (word.level === 4) counts.mastered += 1;
      else counts.learning += 1;
      if (word.isFlashcardEligible !== false && Date.parse(word.nextReview) <= now.getTime()) counts.due += 1;
    }
    return counts;
  }, { learned: 0, introduced: 0, learning: 0, mastered: 0, due: 0 });
}

export const WORD_STUDY_STATUS_LABELS: Record<WordStudyStatus, string> = {
  observed: '待确认', new: '待学新词', due: '待复习', learning: '学习中', familiar: '长期稳定', paused: '已暂停', removed: '已移出',
};

export function buildWordMemoryDetails(state: WordMemoryState | null, preferences: FlashcardStudyPreferences,
  now = new Date(), canonicalWordId = state?.wordId ?? '', params?: MemoryScoreParams) {
  const view = state ? projectWordProficiency(state, preferences, now, params, canonicalWordId) : null;
  const recalled = view?.isIntroduced === false;
  const score = recalled ? view!.memoryScore : null;
  const level = recalled ? view!.level : null;
  const status = view?.studyStatus
    ?? projectWordStudyStatus(projectWordLearningStatus(null, preferences, canonicalWordId), null, 0, now);
  const reviews = state?.fsrsReviews.filter(review => review.source !== 'reading_lookup' && review.modelApplied !== false) ?? [];
  return {
    status, statusLabel: WORD_STUDY_STATUS_LABELS[status], hasRecall: recalled, score, level,
    levelLabel: level === null ? '尚无正式回忆证据' : RECOGNITION_LEVEL_LABELS[level],
    recallPercent: recalled ? view!.confidence ?? null : null,
    forgettingRiskPercent: recalled ? view!.forgettingRiskPercent ?? null : null,
    reviewCount: reviews.length + (recalled && state ? Math.max(0, state.fsrsCard.reps - state.fsrsReviews.length) : 0),
    practiceCount: state?.fsrsReviews.filter(review => review.modelApplied === false).length ?? 0,
    reviews: [...reviews].reverse().slice(0, 5),
    lastReviewAt: reviews.at(-1)?.review ?? (recalled ? state?.lastReview ?? null : null),
    nextReviewAt: (recalled || view?.hasPractice) && view?.isFlashcardEligible ? view.nextReview : null,
    stabilityDays: recalled ? state?.stability ?? null : null,
    lastAssistedAt: state?.lastAssistedAt ?? null,
    exposureCount: state?.rme?.exposureHistory.length ?? 0,
  };
}

export function memoryDateLabel(value: string | null, timezone: string): string {
  if (!value || !Number.isFinite(Date.parse(value))) return '暂无记录';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: timezone, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

/** Match the same canonical-owner policy as the learning overview and word-card queue. */
export function selectWordMemoryState(states: readonly WordMemoryState[], canonicalIds: readonly string[], wordId: string) {
  return selectCanonicalMemoryState(states.filter((state, index) => (canonicalIds[index] || state.wordId) === wordId), wordId);
}
