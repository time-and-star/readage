import type { ReadingVerificationOption, ReadingVerificationQuestion } from './readingVerificationQuestions';
import { isFreshReadingVerificationContext } from './readingVerificationQuestions';

export { isFreshReadingVerificationContext } from './readingVerificationQuestions';

export interface GeneratedReadingVerificationConstraints {
  wordIds: readonly string[];
  excludedContextTexts?: readonly string[];
  excludedQuestionIds?: readonly string[];
}

export const GENERATED_READING_VERIFICATION_VERSION = 'reading-verification.llm.v1';

function invalid(reason: string): never {
  throw new Error(`Invalid reading verification question: ${reason}.`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function boundedText(value: unknown, label: string, maximumCharacters: number): string {
  if (typeof value !== 'string' || !value.trim()) invalid(`${label} must be non-empty text`);
  if (value.length > maximumCharacters) invalid(`${label} is too long`);
  if (/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/.test(value)
    || /[<>]/.test(value)) invalid(`${label} contains control characters or markup`);
  return value.trim().replace(/ +/g, ' ');
}

function englishText(value: unknown, label: string, maximumCharacters: number, maximumWords: number): string {
  const text = boundedText(value, label, maximumCharacters);
  const letters = text.match(/\p{L}/gu) ?? [];
  if (!/[A-Za-z]/.test(text) || letters.some((letter) => !/\p{Script=Latin}/u.test(letter))) {
    invalid(`${label} must be English`);
  }
  if (text.split(/\s+/).length > maximumWords) invalid(`${label} has too many words`);
  return text;
}

function chineseText(value: unknown, label: string, maximumCharacters: number): string {
  const text = boundedText(value, label, maximumCharacters);
  const letters = text.match(/\p{L}/gu) ?? [];
  const chinese = text.match(/[\u3400-\u9fff]/g) ?? [];
  if (!chinese.length || chinese.length / Math.max(1, letters.length) < 0.2
    || letters.some((letter) => !/[\u3400-\u9fff]/.test(letter) && !/\p{Script=Latin}/u.test(letter))) {
    invalid(`${label} must include a Chinese explanation`);
  }
  return text;
}

function normalizedWordId(wordId: string): string {
  return wordId.trim().toLowerCase().replace(/[\u2018\u2019\u02bc]/g, "'").replace(/\s+/g, ' ');
}

function normalizedMeaning(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\p{P}\p{Z}]+/gu, '').trim();
}

function hasExactTarget(sentence: string, wordId: string): boolean {
  const escaped = wordId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
  // Hyphens and apostrophes are part of lexical tokens, so run in run-based
  // and bank in bank's do not satisfy an exact requested target.
  return new RegExp(`(^|[^a-z'’-])${escaped}(?=$|[^a-z'’-])`, 'i')
    .test(sentence.replace(/[\u2018\u2019\u02bc]/g, "'"));
}

function stableHash(content: string): string {
  let first = 2166136261;
  let second = 5381;
  for (const character of content) {
    const code = character.codePointAt(0)!;
    first = Math.imul(first ^ code, 16777619);
    second = Math.imul(second, 33) ^ code;
  }
  return (first >>> 0).toString(16).padStart(8, '0') + (second >>> 0).toString(16).padStart(8, '0');
}

/**
 * Shared server/client structural validation. This cannot prove that English
 * and Chinese have the same meaning or that only one answer is semantically
 * correct; those remain requirements for the generator and content review.
 */
export function validateGeneratedReadingVerificationQuestion(
  raw: unknown,
  constraints: GeneratedReadingVerificationConstraints,
): ReadingVerificationQuestion {
  const input = record(raw, 'question');
  const rawWordId = boundedText(input.wordId, 'wordId', 80);
  const wordId = normalizedWordId(rawWordId);
  if (!/^[a-z]+(?:['-][a-z]+)*(?: [a-z]+(?:['-][a-z]+)*)*$/.test(wordId)
    || !constraints.wordIds.some((candidate) => normalizedWordId(candidate) === wordId)) {
    invalid('wordId is not one of the requested words');
  }

  const sentence = englishText(input.sentence, 'sentence', 500, 60);
  if (sentence.split(/\s+/).length < 6 || !/[.!?]["'”’)]?$/.test(sentence)) {
    invalid('sentence must be a complete English sentence');
  }
  if (!hasExactTarget(sentence, wordId)) invalid('sentence does not contain the exact target word or phrase');
  if (!isFreshReadingVerificationContext(sentence, constraints.excludedContextTexts ?? [])) {
    invalid('sentence repeats an excluded context');
  }

  if (!Array.isArray(input.options) || input.options.length !== 3) invalid('exactly three options are required');
  const options = input.options.map((value, index): ReadingVerificationOption => {
    const option = record(value, `option ${index + 1}`);
    const id = boundedText(option.id, `option ${index + 1} id`, 24);
    if (!/^[a-z][a-z0-9_-]{0,23}$/i.test(id)) invalid('option ids must be short letters, numbers, underscores or hyphens');
    return { id,
      en: englishText(option.en, `option ${id} English meaning`, 180, 30),
      zh: chineseText(option.zh, `option ${id} Chinese meaning`, 100),
      explanationZh: chineseText(option.explanationZh, `option ${id} explanation`, 300),
    };
  }) as ReadingVerificationQuestion['options'];
  if (new Set(options.map((option) => option.id.toLowerCase())).size !== 3) invalid('option ids must be unique');
  if (new Set(options.map((option) => normalizedMeaning(option.en))).size !== 3
    || new Set(options.map((option) => normalizedMeaning(option.zh))).size !== 3) {
    invalid('English and Chinese option meanings must each be distinct');
  }
  const correctOptionId = boundedText(input.correctOptionId, 'correctOptionId', 24);
  if (options.filter((option) => option.id === correctOptionId).length !== 1) invalid('correctOptionId must match exactly one option');
  const explanationZh = chineseText(input.explanationZh, 'question explanation', 400);

  // Ignore any model-provided question id. Stable content identifies the same
  // question even when JSON property order or option order differs.
  const normalizedContent = { wordId, sentence,
    options: [...options].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    correctOptionId, explanationZh };
  const id = `${GENERATED_READING_VERIFICATION_VERSION}:${wordId}:${stableHash(JSON.stringify(normalizedContent))}`;
  if ((constraints.excludedQuestionIds ?? []).includes(id)) invalid('question id was already used');
  return { id, wordId, sentence, options, correctOptionId, explanationZh };
}
