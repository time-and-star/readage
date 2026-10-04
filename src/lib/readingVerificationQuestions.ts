import { toLemma } from './proficiency.legacy';
import { READING_VERIFICATION_QUESTION_DRAFTS, type VerificationChoiceDraft } from '../data/readingVerificationQuestionBank';

export interface ReadingVerificationOption {
  id: string;
  en: string;
  zh: string;
  explanationZh: string;
}

export interface ReadingVerificationQuestion {
  id: string;
  wordId: string;
  sentence: string;
  options: [ReadingVerificationOption, ReadingVerificationOption, ReadingVerificationOption];
  correctOptionId: string;
  explanationZh: string;
  purpose?: 'delayed_verification' | 'immediate_practice';
}

export const READING_VERIFICATION_QUESTION_VERSION = 'reading-verification.v1';

function normalizedContext(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[^a-z0-9']+/g, ' ').trim();
}

function wordWindows(text: string, width: number): Set<string> {
  const words = normalizedContext(text).split(' ').filter(Boolean);
  return new Set(words.slice(0, Math.max(0, words.length - width + 1))
    .map((_, index) => words.slice(index, index + width).join(' ')));
}

/** Exact reuse, sentence-in-paragraph reuse, and near copies are all excluded. */
export function isFreshReadingVerificationContext(sentence: string, excluded: readonly string[] = []): boolean {
  const normalized = normalizedContext(sentence);
  const windows = wordWindows(sentence, 4);
  for (const context of excluded) {
    const previous = normalizedContext(context);
    if (!previous) continue;
    if (previous.includes(normalized)
      || (previous.split(' ').length >= 5 && normalized.includes(previous))) return false;
    const previousWindows = wordWindows(context, 4);
    const shared = [...windows].filter((window) => previousWindows.has(window)).length;
    if (windows.size && shared / windows.size >= 0.5) return false;
  }
  return true;
}

/** Deterministic rotation avoids giving every correct answer the same position. */
function answerPosition(id: string): number {
  let hash = 2166136261;
  for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0) % 3;
}

const questions = READING_VERIFICATION_QUESTION_DRAFTS.map((draft): ReadingVerificationQuestion => {
  const id = `${READING_VERIFICATION_QUESTION_VERSION}:${draft.wordId}:${draft.senseId}`;
  const option = (choice: VerificationChoiceDraft, suffix: string): ReadingVerificationOption => ({
    id: `${id}:${suffix}`, en: choice[0], zh: choice[1], explanationZh: choice[2],
  });
  const correct = option(draft.correct, 'correct');
  const options = draft.distractors.map((choice, index) => option(choice, `alternative-${index + 1}`));
  options.splice(answerPosition(id), 0, correct);
  return { id, wordId: draft.wordId, sentence: draft.sentence,
    options: options as ReadingVerificationQuestion['options'],
    correctOptionId: correct.id, explanationZh: draft.explanationZh };
});

// Finite verified inflections keep this helper offline. Unknown words are never
// stemmed speculatively or turned into newly generated questions.
const aliases = new Map<string, string>();
for (const draft of READING_VERIFICATION_QUESTION_DRAFTS) {
  for (const surface of [draft.wordId, ...(draft.aliases ?? [])]) aliases.set(toLemma(surface), draft.wordId);
}

export function getReadingVerificationWordIds(excludedContextTexts: readonly string[] = []): string[] {
  return [...new Set(questions.filter((question) => isFreshReadingVerificationContext(question.sentence, excludedContextTexts))
    .map((question) => question.wordId))];
}

export function hasReadingVerificationQuestion(wordId: string, excludedContextTexts: readonly string[] = [],
  excludedQuestionIds: readonly string[] = []): boolean {
  const canonical = aliases.get(toLemma(wordId));
  return questions.some((question) => question.wordId === canonical
    && !excludedQuestionIds.includes(question.id)
    && isFreshReadingVerificationContext(question.sentence, excludedContextTexts));
}

/**
 * Find a fixed bilingual transfer question in requested-word order. Callers
 * should exclude article paragraphs and any examples already shown in cards.
 * A missing or non-fresh question returns null, never a fabricated fallback.
 */
export async function findReadingVerificationQuestion(
  wordIds: readonly string[],
  excludedContextTexts: readonly string[] = [],
  excludedQuestionIds: readonly string[] = [],
): Promise<ReadingVerificationQuestion | null> {
  for (const wordId of wordIds) {
    const canonical = aliases.get(toLemma(wordId));
    const question = questions.find((candidate) => candidate.wordId === canonical
      && !excludedQuestionIds.includes(candidate.id)
      && isFreshReadingVerificationContext(candidate.sentence, excludedContextTexts));
    if (question) return { ...question, options: question.options.map((option) => ({ ...option })) as ReadingVerificationQuestion['options'] };
  }
  return null;
}
