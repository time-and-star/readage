import type { FlashcardQueueCard } from './flashcardReview';
import type { FlashcardStudyPreferences } from './flashcardPreferences';

/** Only settings that change eligible cards; registry ordering does not change a study plan. */
export function getFlashcardPlanSettingsKey(preferences: FlashcardStudyPreferences): string {
  const sortedIds = (ids: readonly string[] = []) => [...new Set(ids)].sort();
  return JSON.stringify([preferences.dailyNewWordLimit, sortedIds(preferences.importedWordIds),
    sortedIds(preferences.pausedWordIds), sortedIds(preferences.excludedWordIds)]);
}

/** Reopen an exhausted session or apply changed settings without replacing an answer on every saved review. */
export function shouldRefreshFlashcardSession(currentQueue: readonly FlashcardQueueCard[],
  previousSettingsKey: string | null, nextSettingsKey: string): boolean {
  return currentQueue.length === 0 || previousSettingsKey !== nextSettingsKey;
}

/** Apply a new daily plan without dropping an answer already saved or same-session rehearsal. */
export function reconcileFlashcardSession(
  currentQueue: readonly FlashcardQueueCard[],
  plannedQueue: readonly FlashcardQueueCard[],
  skippedCanonicalWordIds: ReadonlySet<string>,
  retainCurrentAnswer: boolean,
): FlashcardQueueCard[] {
  const current = currentQueue[0];
  const practice = currentQueue.filter(card => card.isPractice);
  const practiceIds = new Set(practice.map(card => card.canonicalWordId));
  const plannedCurrent = current && plannedQueue.find(card => card.canonicalWordId === current.canonicalWordId);
  const retainCurrent = !!current && (retainCurrentAnswer || current.isPractice
    || Boolean(plannedCurrent));
  const next = plannedQueue.filter(card => !skippedCanonicalWordIds.has(card.canonicalWordId)
    && !practiceIds.has(card.canonicalWordId) && (!retainCurrent || card.canonicalWordId !== current.canonicalWordId));
  // An unrated surface alias must save to the new canonical memory owner after import.
  if (retainCurrent) next.unshift(retainCurrentAnswer || current.isPractice ? current : plannedCurrent ?? current);
  for (const card of practice) {
    if (retainCurrent && card === current) continue;
    const oldPosition = currentQueue.indexOf(card);
    next.splice(Math.min(oldPosition, next.length), 0, card);
  }
  return next;
}
