import type { ReadingLearnerWord, ReadingLearnerSummary } from '../types';
import type { WordMemoryState } from './memoryV2/types';
import { selectCanonicalMemoryState } from './memoryV2/wordIdentity';
import { buildWordMemoryDetails } from './wordMemoryDetails';
import { toLemma } from './proficiency.legacy';
import type { ReadingVerificationCandidate, ReadingVerificationAttemptSummary } from './readingVerification';
import { shouldTrackMemoryWord } from './memoryV2/stopWords';

export const MAX_READING_AGENT_WORDS = 120;
export const MAX_READING_AGENT_ARTICLE_CHARS = 120_000;

export function articleContainsLearningWord(text: string, word: string): boolean {
  const target = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(?<![a-z])${target}(?![a-z])`, 'i').test(text);
}

/** The agent sees article-related words plus a broad eligible pool, not five preselected targets. */
export function buildAfterReadingContext({ states, history, candidates, articleText, articleId,
  canonicalWordIds, now, articleWordIds }: {
  states: readonly WordMemoryState[];
  history: readonly ReadingVerificationAttemptSummary[];
  candidates: readonly ReadingVerificationCandidate[];
  articleText: string;
  articleId: string;
  canonicalWordIds: ReadonlyMap<string, string>;
  now: Date;
  articleWordIds?: readonly string[];
}): { learnerWords: ReadingLearnerWord[]; learningSummary: ReadingLearnerSummary } {
  const grouped = new Map<string, WordMemoryState[]>();
  for (const state of states) {
    const id = canonicalWordIds.get(state.wordId) || toLemma(state.wordId);
    if (!id || !/^[a-z]+(?:['-][a-z]+)*(?: [a-z]+(?:['-][a-z]+)*)*$/.test(id)) continue;
    grouped.set(id, [...grouped.get(id) ?? [], state]);
  }
  const tokens = new Set((articleText.toLowerCase().match(/[a-z]+(?:['-][a-z]+)*/g) ?? []).map(toLemma));
  const trackedArticleIds = [...grouped].filter(([id, group]) => (id.includes(' ')
    ? articleContainsLearningWord(articleText, id) : tokens.has(id))
    || group.some(state => state.rme?.contextHistory.some(row => row.articleId === articleId)))
    .map(([id]) => id);
  const detected = articleWordIds ?? [...tokens].map(id => canonicalWordIds.get(id) || id)
    .filter(id => shouldTrackMemoryWord(id));
  const articleIds = [...new Set([...detected, ...trackedArticleIds])]
    .filter(id => /^[a-z]+(?:['-][a-z]+)*(?: [a-z]+(?:['-][a-z]+)*)*$/.test(id));
  const eligible = new Set(candidates.map(candidate => candidate.wordId));
  // Reserve room for both sources, even in a long article or a large review queue.
  const selected = [...new Set([...articleIds.slice(0, 80), ...candidates.slice(0, 40).map(row => row.wordId)])];
  const learnerWords = selected.map((wordId): ReadingLearnerWord => {
    const group = grouped.get(wordId) ?? [];
    // Prefer a canonical state; aliases contribute recency but never add stability/repetitions.
    const state = selectCanonicalMemoryState(group, wordId);
    const memory = buildWordMemoryDetails(state, { dailyNewWordLimit: 10, importedWordIds: [] }, now, wordId);
    const latest = (times: Array<string | null | undefined>) => times.filter((at): at is string =>
      Boolean(at) && Number.isFinite(Date.parse(at!))).sort().at(-1) ?? null;
    const last = [...history].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
      .find(row => (canonicalWordIds.get(row.wordId) || row.wordId) === wordId);
    const recentContext = group.flatMap(row => row.rme?.contextHistory ?? [])
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)).find(row => row.contextText)?.contextText?.slice(0, 500);
    return { wordId, inArticle: articleIds.includes(wordId), eligibleDelayed: eligible.has(wordId),
      memoryScore: memory.score === null ? null : Math.round(memory.score),
      confidence: memory.recallPercent === null ? null : Math.round(memory.recallPercent),
      exposureCount: state?.rme?.exposureHistory.length ?? 0,
      reviewCount: memory.reviewCount,
      lastSeenAt: latest(group.flatMap(row => [row.rme?.lastExposureAt, row.lastAssistedAt, row.lastReview,
        ...row.fsrsReviews.map(review => review.review)])),
      lastAssistedAt: latest(group.map(row => row.lastAssistedAt)),
      lastReviewAt: memory.lastReviewAt,
      ...(last ? { lastOutcome: last.outcome, lastOutcomePurpose: last.purpose ?? 'delayed_verification' } : {}),
      ...(recentContext ? { recentContext } : {}) };
  });
  return { learnerWords, learningSummary: { trackedWordCount: grouped.size,
    articleWordCount: articleIds.length, eligibleDelayedCount: candidates.length } };
}
