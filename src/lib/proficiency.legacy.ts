import { Rating, State, type Grade } from 'ts-fsrs';

export const REVIEW_DEDUP_WINDOW_MS = 10_000;
import type {
  LearningEvent,
  LearningEventType,
  ProficiencyLevel,
  ReviewWord,
  WordProficiency,
} from '../types';
import {
  createFsrsMemory,
  ensureFsrsMemory,
  getFsrsCardDue,
  getFsrsRetrievability,
  isValidFsrsMemory,
  reviewFsrsMemory,
} from './fsrs';

/**
 * Keep the inflection aliases intentionally small until a dictionary-backed
 * lemmatizer is available. This covers the observed chase/chasing mismatch
 * without stemming proper names, phrases, or arbitrary hyphenated terms.
 */
const CONSERVATIVE_INFLECTIONS: Readonly<Record<string, string>> = {
  chasing: 'chase',
  chased: 'chase',
  chases: 'chase',
};

/** Normalize a word or phrase while preserving phrase boundaries. */
export function toLemma(word: string): string {
  return word
    .toLowerCase()
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[^a-z'\s-]/g, ' ')
    .replace(/[-\s]+/g, ' ')
    .trim()
    .split(' ')
    .map((token) => token.replace(/^'+|'+$/g, ''))
    .map((token) => CONSERVATIVE_INFLECTIONS[token] ?? token)
    .filter(Boolean)
    .join(' ');
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}

function normalizeTextSegments(text: string): string[] {
  return text
    .split(/[.!?;:,\n\r/\\()[\]{}"\u2010-\u2015]+/)
    .map(toLemma)
    .filter(Boolean);
}

export function textContainsLemma(text: string, lemmaOrWord: string): boolean {
  const lemma = toLemma(lemmaOrWord);
  if (!lemma) return false;
  return normalizeTextSegments(text)
    .some((segment) => ` ${segment} `.includes(` ${lemma} `));
}

function emptyProficiency(lemma: string, at: Date): WordProficiency {
  const memory = createFsrsMemory(at);
  return {
    lemma,
    level: 0,
    recognitionScore: 0,
    productionScore: 0,
    stabilityDays: memory.card.stability,
    lastReviewedAt: at.toISOString(),
    nextReviewDue: '',
    exposureCount: 0,
    fsrs: memory,
  };
}

function liveRecognitionScore(memory: NonNullable<WordProficiency['fsrs']>, at: Date): number {
  // FSRS has no retrievability estimate before the first review. Treat a New
  // card as 0 rather than leaking the legacy recognitionScore cache into the
  // live projection.
  return memory.card.reps > 0 ? clamp01(getFsrsRetrievability(memory, at)) : 0;
}

function computeLevel(
  p: WordProficiency,
  retrievability: number,
  lastRating: number | undefined,
  reps: number,
  isIntroduced: boolean
): ProficiencyLevel {
  if (reps === 0) {
    // Passive sightings keep an unreviewed word at L0 until the third exposure.
    return isIntroduced ? 1 : 0;
  }

  // An explicit failure remains learning until positive evidence arrives.
  if (lastRating === Rating.Again) return 1;

  if (retrievability >= 0.8 && p.productionScore >= 0.7) return 4;
  if (retrievability >= 0.6 && p.productionScore >= 0.3) return 3;

  const hasPositiveRecall = lastRating === Rating.Hard
    || lastRating === Rating.Good
    || lastRating === Rating.Easy;
  if ((p.exposureCount >= 3 || hasPositiveRecall) && retrievability >= 0.14) return 2;
  return 1;
}

/**
 * Project a persisted word into its live state at a specific instant.
 * The returned level and recognition score are derived from FSRS, never trusted
 * from the persisted compatibility fields.
 */
export function getEffectiveProficiency(
  p: WordProficiency,
  at = new Date()
): WordProficiency {
  const memory = ensureFsrsMemory(p, at);
  const reps = memory.card.reps;
  const retrievability = liveRecognitionScore(memory, at);
  const lastReviewedAt = memory.card.lastReview || p.lastReviewedAt || at.toISOString();
  const nextReviewDue = memory.isIntroduced ? memory.card.due : '';

  return {
    ...p,
    recognitionScore: retrievability,
    stabilityDays: memory.card.stability,
    lastReviewedAt,
    nextReviewDue,
    fsrs: memory,
    level: computeLevel(p, retrievability, memory.lastRating, reps, memory.isIntroduced),
  };
}

/** Backward-compatible name; now returns canonical FSRS retrievability. */
export function getRetentionStrength(p: WordProficiency, at = new Date()): number {
  return getEffectiveProficiency(p, at).recognitionScore;
}

export function recomputeLevel(p: WordProficiency, at = new Date()): ProficiencyLevel {
  return getEffectiveProficiency(p, at).level;
}

function withMemory(
  p: WordProficiency,
  memory: NonNullable<WordProficiency['fsrs']>,
  at: Date
): WordProficiency {
  const lastReviewedAt = memory.card.lastReview || p.lastReviewedAt || at.toISOString();
  const next: WordProficiency = {
    ...p,
    fsrs: memory,
    recognitionScore: liveRecognitionScore(memory, at),
    stabilityDays: memory.card.stability,
    lastReviewedAt,
    nextReviewDue: memory.isIntroduced ? memory.card.due : '',
  };
  return { ...next, level: getEffectiveProficiency(next, at).level };
}

function applyRating(
  p: WordProficiency,
  rating: Grade,
  at: Date
): WordProficiency {
  const current = ensureFsrsMemory(p, at);
  const latest = current.reviews.at(-1);
  const elapsedSinceLatest = latest ? at.getTime() - Date.parse(latest.review) : Number.POSITIVE_INFINITY;

  // UI double-clicks and retried requests must not become multiple memory
  // reviews. Only identical ratings are deduplicated; contrary evidence remains
  // meaningful and may be recorded at the same instant.
  if (latest
    && latest.rating === rating
    && elapsedSinceLatest >= 0
    && elapsedSinceLatest < REVIEW_DEDUP_WINDOW_MS) {
    return withMemory(p, current, at);
  }

  return withMemory(p, reviewFsrsMemory(current, rating, at), at);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isPersistedProficiency(value: unknown): value is WordProficiency {
  if (!isRecord(value)) return false;
  return typeof value.lemma === 'string'
    && Boolean(toLemma(value.lemma))
    && Number.isInteger(value.level)
    && (value.level as number) >= 0
    && (value.level as number) <= 4
    && typeof value.recognitionScore === 'number'
    && Number.isFinite(value.recognitionScore)
    && value.recognitionScore >= 0
    && value.recognitionScore <= 1
    && typeof value.productionScore === 'number'
    && Number.isFinite(value.productionScore)
    && value.productionScore >= 0
    && value.productionScore <= 1
    && typeof value.stabilityDays === 'number'
    && Number.isFinite(value.stabilityDays)
    && value.stabilityDays >= 0
    && typeof value.lastReviewedAt === 'string'
    && typeof value.nextReviewDue === 'string'
    && Number.isInteger(value.exposureCount)
    && (value.exposureCount as number) >= 0
    && isOptionalString(value.phonetic)
    && isOptionalString(value.partOfSpeech)
    && isOptionalString(value.definition)
    && isOptionalString(value.definitionChinese)
    && isOptionalString(value.chineseTranslation)
    && isOptionalString(value.exampleSentence);
}

/** Validate, canonicalize, and upgrade persisted proficiency data before use. */
export function migrateProficiencyMap(
  value: unknown,
  at = new Date(),
  fallback: Record<string, WordProficiency> = {}
): Record<string, WordProficiency> {
  if (!isRecord(value)) return fallback;

  let changed = false;
  const next: Record<string, WordProficiency> = {};
  for (const [storedLemma, stored] of Object.entries(value)) {
    if (!isPersistedProficiency(stored)) {
      changed = true;
      continue;
    }

    const lemma = toLemma(stored.lemma);
    const p = lemma === storedLemma && lemma === stored.lemma
      ? stored
      : { ...stored, lemma };
    if (p !== stored || next[lemma]) changed = true;

    if (isValidFsrsMemory(p.fsrs)) {
      next[lemma] = p;
      continue;
    }
    changed = true;
    next[lemma] = getEffectiveProficiency(p, at);
  }
  return changed ? next : value as Record<string, WordProficiency>;
}

export function applyClickLookup(
  map: Record<string, WordProficiency>,
  surface: string,
  at = new Date()
): Record<string, WordProficiency> {
  const lemma = toLemma(surface);
  if (!lemma) return map;
  const prev = map[lemma] ?? emptyProficiency(lemma, at);
  const next = applyRating(prev, Rating.Again, at);
  return { ...map, [lemma]: { ...next, level: 1 } };
}

export function applyExposures(
  map: Record<string, WordProficiency>,
  surfaces: string[],
  at = new Date()
): Record<string, WordProficiency> {
  const next = { ...map };
  const seen = new Set<string>();

  for (const surface of surfaces) {
    const lemma = toLemma(surface);
    if (!lemma || seen.has(lemma)) continue;
    seen.add(lemma);

    const prev = next[lemma] ?? emptyProficiency(lemma, at);
    const memory = ensureFsrsMemory(prev, at);
    const exposureCount = prev.exposureCount + 1;
    let updated: WordProficiency = {
      ...prev,
      exposureCount,
      // Passive exposure is tracked separately from FSRS recall evidence.
      recognitionScore: 0,
      fsrs: memory,
    };

    if (memory.card.reps === 0 && exposureCount >= 3 && !memory.isIntroduced) {
      // Seeing a word is not a recall attempt, so it must not create a fake
      // Good/Hard review. The third sighting only introduces a New card that is
      // due now; an explicit later interaction supplies the first FSRS rating.
      updated = withMemory(updated, {
        ...memory,
        isIntroduced: true,
        card: { ...memory.card, due: at.toISOString() },
      }, at);
    } else {
      // Passive exposure never clears a previous Again or changes scheduling.
      updated = withMemory(updated, memory, at);
    }

    next[lemma] = updated;
  }

  return next;
}

export function applyAddToReview(
  map: Record<string, WordProficiency>,
  word: Partial<ReviewWord> & { word: string },
  at = new Date()
): Record<string, WordProficiency> {
  const lemma = toLemma(word.word);
  if (!lemma) return map;
  const prev = map[lemma] ?? emptyProficiency(lemma, at);
  const memory = ensureFsrsMemory(prev, at);
  const next = withMemory({
    ...prev,
    recognitionScore: 0,
    phonetic: word.phonetic ?? prev.phonetic,
    partOfSpeech: word.partOfSpeech ?? prev.partOfSpeech,
    definition: word.definition ?? prev.definition,
    definitionChinese: word.definitionChinese ?? prev.definitionChinese,
    chineseTranslation: word.chineseTranslation ?? prev.chineseTranslation,
    exampleSentence: word.exampleSentence ?? prev.exampleSentence,
  }, { ...memory, isIntroduced: true, card: { ...memory.card, due: at.toISOString() } }, at);
  return { ...map, [lemma]: { ...next, level: 1 } };
}

export function findUsedLemmas(
  map: Record<string, WordProficiency>,
  text: string
): string[] {
  return Object.keys(map).filter((lemma) => textContainsLemma(text, lemma));
}

export function applyProductionUse(
  map: Record<string, WordProficiency>,
  text: string,
  boost = 0.1,
  at = new Date()
): Record<string, WordProficiency> {
  const next = { ...map };
  for (const lemma of findUsedLemmas(map, text)) {
    const prev = next[lemma];
    const credited: WordProficiency = {
      ...prev,
      productionScore: clamp01(prev.productionScore + boost),
    };
    // A correct unprompted use proves successful recall, but without an ease
    // signal it is canonical Good rather than Easy.
    next[lemma] = applyRating(credited, Rating.Good, at);
  }
  return next;
}

export function applyIncorrectUse(
  map: Record<string, WordProficiency>,
  words: string[],
  at = new Date()
): Record<string, WordProficiency> {
  const next = { ...map };
  for (const word of words) {
    const lemma = toLemma(word);
    if (!lemma || !next[lemma]) continue;
    const prev = next[lemma];
    const penalized: WordProficiency = {
      ...prev,
      productionScore: clamp01(prev.productionScore - 0.25),
    };
    next[lemma] = { ...applyRating(penalized, Rating.Again, at), level: 1 };
  }
  return next;
}

export function applyAvoidance(
  map: Record<string, WordProficiency>,
  words: string[],
  at = new Date()
): Record<string, WordProficiency> {
  const next = { ...map };
  for (const word of words) {
    const lemma = toLemma(word);
    if (!lemma || !next[lemma]) continue;
    const prev = next[lemma];
    const penalized: WordProficiency = {
      ...prev,
      productionScore: clamp01(prev.productionScore - 0.12),
    };
    // Explicitly avoiding a requested target is failed recall, not a difficult
    // successful recall. Hard can increase stability; Again applies the intended
    // negative scheduling evidence while the smaller score penalty preserves the
    // distinction from an incorrect use.
    next[lemma] = applyRating(penalized, Rating.Again, at);
  }
  return next;
}

export function applyGrammarQuery(
  map: Record<string, WordProficiency>,
  wordOrPhrase: string,
  at = new Date()
): Record<string, WordProficiency> {
  const lemma = toLemma(wordOrPhrase);
  if (!lemma) return map;
  const prev = map[lemma] ?? emptyProficiency(lemma, at);
  return { ...map, [lemma]: { ...applyRating(prev, Rating.Again, at), level: 1 } };
}

export function applyMastered(
  map: Record<string, WordProficiency>,
  lemmaOrWord: string,
  at = new Date()
): Record<string, WordProficiency> {
  const lemma = toLemma(lemmaOrWord);
  if (!lemma || !map[lemma]) return map;
  const prev: WordProficiency = {
    ...map[lemma],
    productionScore: Math.max(map[lemma].productionScore, 0.75),
  };
  return { ...map, [lemma]: applyRating(prev, Rating.Easy, at) };
}

function isEffectiveReviewDue(p: WordProficiency, at: Date): boolean {
  return p.level >= 1
    && Boolean(p.fsrs)
    && getFsrsCardDue(p.fsrs!) <= at.getTime();
}

export function isReviewDue(p: WordProficiency, at = new Date()): boolean {
  return isEffectiveReviewDue(getEffectiveProficiency(p, at), at);
}

export function getDueLemmas(
  map: Record<string, WordProficiency>,
  at = new Date()
): string[] {
  return Object.values(map)
    .map((p) => getEffectiveProficiency(p, at))
    .filter((p) => isEffectiveReviewDue(p, at))
    .sort((a, b) => getFsrsCardDue(a.fsrs!) - getFsrsCardDue(b.fsrs!))
    .map((p) => p.lemma);
}

export function proficiencyToReviewWords(
  map: Record<string, WordProficiency>,
  at = new Date()
): ReviewWord[] {
  return Object.values(map)
    .map((p) => getEffectiveProficiency(p, at))
    .filter((p) => isEffectiveReviewDue(p, at))
    .map((p) => ({
      id: `word-${p.lemma}`,
      word: p.lemma,
      phonetic: p.phonetic || '',
      partOfSpeech: p.partOfSpeech,
      definition: p.definition || 'Added from reading.',
      definitionChinese: p.definitionChinese,
      chineseTranslation: p.chineseTranslation,
      exampleSentence: p.exampleSentence || '',
      mastered: false,
      nextReviewDate: new Date(p.fsrs!.card.due).toLocaleDateString(),
    }));
}

export function countByBand(
  map: Record<string, WordProficiency>,
  at = new Date()
): { learning: number; mastered: number } {
  let learning = 0;
  let mastered = 0;
  for (const stored of Object.values(map)) {
    const p = getEffectiveProficiency(stored, at);
    if (p.level >= 4) mastered += 1;
    else if (p.level >= 1) learning += 1;
  }
  return { learning, mastered };
}

export function makeEvent(
  type: LearningEventType,
  opts?: { articleId?: string; lemma?: string; detail?: string },
  at = new Date()
): LearningEvent {
  return {
    id: `evt-${at.getTime()}-${Math.random().toString(36).slice(2, 7)}`,
    type,
    articleId: opts?.articleId,
    lemma: opts?.lemma,
    detail: opts?.detail,
    createdAt: at.toISOString(),
  };
}

/** Seed map from initial review word list as due, unreviewed FSRS cards. */
export function seedFromReviewWords(
  words: ReviewWord[],
  at = new Date()
): Record<string, WordProficiency> {
  const map: Record<string, WordProficiency> = {};
  for (const word of words) {
    const lemma = toLemma(word.word);
    if (!lemma) continue;
    const memory = { ...createFsrsMemory(at), isIntroduced: true };
    map[lemma] = {
      lemma,
      level: 1,
      recognitionScore: 0,
      productionScore: 0.1,
      stabilityDays: memory.card.stability,
      lastReviewedAt: at.toISOString(),
      nextReviewDue: at.toISOString(),
      phonetic: word.phonetic,
      partOfSpeech: word.partOfSpeech,
      definition: word.definition,
      definitionChinese: word.definitionChinese,
      chineseTranslation: word.chineseTranslation,
      exampleSentence: word.exampleSentence,
      exposureCount: 0,
      fsrs: memory,
    };
  }
  return map;
}

export function findAvoidedTargetWords(
  text: string,
  targetWords: string[],
  minimumUtteranceWords = 4
): string[] {
  const utteranceWordCount = toLemma(text).split(/\s+/).filter(Boolean).length;
  if (utteranceWordCount < minimumUtteranceWords) return [];
  return [...new Set(targetWords.map(toLemma).filter(Boolean))].filter(
    (lemma) => !textContainsLemma(text, lemma)
  );
}
