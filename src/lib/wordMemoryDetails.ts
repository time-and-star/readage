import type { FlashcardStudyPreferences } from './flashcardPreferences';
import type { WordProficiencyView } from './memoryV2/memorySystem';
import type { WordMemoryState } from './memoryV2/types';
import { calculateMemoryScore, scoreToLevel } from './memoryV2/memoryScore';
import { calculateFsrsRetention } from './memoryV4/confidence';
import { hasFormalRecallEvidence } from './memoryV2/rmeV4Bridge';

export const RECOGNITION_LEVEL_LABELS = ['尚未稳定', '初步记忆', '逐渐熟悉', '较为熟悉', '长期稳定'] as const;
export const FLASHCARD_RATING_LABELS: Record<number, string> = { 1: '忘记', 2: '费力', 3: '记住', 4: '轻松' };

/** Historical learned counts and the active study queues have different, explicit scopes. */
export function summarizeWordLearningViews(words: readonly WordProficiencyView[], now = new Date()) {
  return words.reduce((counts, word) => {
    if (word.isIntroduced) {
      if (word.isFlashcardEligible !== false) counts.introduced += 1;
    } else {
      counts.learned += 1;
      if (word.level === 4) counts.mastered += 1;
      else counts.learning += 1;
      if (word.isFlashcardEligible !== false && Date.parse(word.nextReview) <= now.getTime()) counts.due += 1;
    }
    return counts;
  }, { learned: 0, introduced: 0, learning: 0, mastered: 0, due: 0 });
}

export type WordStudyStatus = 'observed' | 'new' | 'due' | 'learning' | 'familiar' | 'paused' | 'removed';
export const WORD_STUDY_STATUS_LABELS: Record<WordStudyStatus, string> = {
  observed: '待确认', new: '待学新词', due: '待复习', learning: '学习中', familiar: '较熟悉', paused: '已暂停', removed: '已移出',
};

export function buildWordMemoryDetails(state: WordMemoryState | null, preferences: FlashcardStudyPreferences,
  now = new Date(), canonicalWordId = state?.wordId ?? '') {
  const recalled = state !== null && hasFormalRecallEvidence(state);
  const knownIds = [canonicalWordId, state?.wordId ?? ''];
  const inList = (ids: readonly string[] | undefined) => knownIds.some(id => ids?.includes(id));
  const paused = inList(preferences.pausedWordIds);
  const removed = inList(preferences.excludedWordIds);
  const enrolled = inList(preferences.importedWordIds);
  const hasLookup = Boolean(state && (Number.isFinite(Date.parse(state.lastAssistedAt ?? ''))
    || state.fsrsReviews.some(review => review.source === 'reading_lookup')));
  const score = recalled && state ? calculateMemoryScore(state, undefined, now) : null;
  const level = score === null ? null : scoreToLevel(score);
  const status: WordStudyStatus = removed ? 'removed' : paused ? 'paused' : !recalled ? hasLookup || enrolled ? 'new' : 'observed'
    : state && Date.parse(state.nextReview) <= now.getTime() ? 'due' : level === 4 ? 'familiar' : 'learning';
  const reviews = state?.fsrsReviews.filter(review => review.source !== 'reading_lookup') ?? [];
  return {
    status, statusLabel: WORD_STUDY_STATUS_LABELS[status], hasRecall: recalled, score, level,
    levelLabel: level === null ? '尚无正式回忆证据' : RECOGNITION_LEVEL_LABELS[level],
    recallPercent: recalled && state ? calculateFsrsRetention({ lastReview: state.lastReview, stabilityDays: state.stability }, now) * 100 : null,
    reviewCount: reviews.length + (recalled && state ? Math.max(0, state.fsrsCard.reps - state.fsrsReviews.length) : 0),
    reviews: [...reviews].reverse().slice(0, 5),
    lastReviewAt: reviews.at(-1)?.review ?? (recalled ? state?.lastReview ?? null : null),
    nextReviewAt: recalled && !paused && !removed ? state?.nextReview ?? null : null,
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
  return states.filter((state, index) => (canonicalIds[index] || state.wordId) === wordId)
    .sort((left, right) => Number(right.wordId === wordId) - Number(left.wordId === wordId)
      || (right.lastReview ?? '').localeCompare(left.lastReview ?? '')
      || left.wordId.localeCompare(right.wordId))[0] ?? null;
}
