import { toLemma } from './proficiency';
import { getReadingTermMatches } from './textHighlight';
import { normalizeEnglishSurface } from './englishTokens';
import { tokenizeReadingParagraph } from './readingTokens';
import { shouldTrackMemoryWord } from './memoryV2/stopWords';

export interface ReadingLearningUnit {
  /** Normalized word or phrase tracked by Memory V2. */
  wordId: string;
  /** Zero-based index of the first rendered token in this occurrence. */
  tokenIndex: number;
  /** Number of rendered tokens covered by this occurrence. */
  tokenLength: number;
}

export const MAX_CONCURRENT_EXPOSURE_CANDIDATES = 2;

/** Keep several visible desktop paragraphs from starting exposure timers together. */
export function limitConcurrentExposureCandidates<T>(
  candidates: readonly T[],
  activeCount: number,
  maximum = MAX_CONCURRENT_EXPOSURE_CANDIDATES,
): T[] {
  const active = Number.isFinite(activeCount) ? Math.max(0, Math.floor(activeCount)) : 0;
  const limit = Number.isFinite(maximum) ? Math.max(0, Math.floor(maximum)) : 0;
  return candidates.slice(0, Math.max(0, limit - active));
}

function isMetadataParagraph(paragraphText: string): boolean {
  // Imported magazine bodies can contain provenance lines such as
  // "downloaded from https://...". Do not turn a URL slug into one lemma.
  return /^\s*(?:This (?:article|poem) was downloaded\b|downloaded from\b)/i.test(paragraphText);
}

/**
 * Extract Memory V2 learning-unit occurrences in rendered-token order.
 * Highlighted phrases replace their component words so exposure and click
 * operate on the same unit.
 */
export function extractLearningUnits(
  paragraphText: string,
  highlightTerms: readonly string[] = [],
): ReadingLearningUnit[] {
  if (isMetadataParagraph(paragraphText)) return [];

  const tokens = tokenizeReadingParagraph(paragraphText);
  const matches = new Map(getReadingTermMatches(tokens, highlightTerms).map((match) => [match.tokenIndex, match]));
  const allowlist = new Set(
    highlightTerms.map((term) => toLemma(normalizeEnglishSurface(term))).filter(Boolean)
  );
  const units: ReadingLearningUnit[] = [];

  let coveredUntil = -1;
  for (const token of tokens) {
    if (token.type !== 'word' || token.tokenIndex < coveredUntil) continue;
    const { tokenIndex } = token;
    const match = matches.get(tokenIndex);
    if (match) {
      const wordId = toLemma(normalizeEnglishSurface(match.term));
      const { tokenLength } = match;
      // Highlighted phrases/terms are always tracked (including stop-word exceptions).
      if (wordId) {
        units.push({ wordId, tokenIndex, tokenLength });
      }
      coveredUntil = tokenIndex + tokenLength;
      continue;
    }

    const wordId = toLemma(normalizeEnglishSurface(token.value));
    if (wordId && shouldTrackMemoryWord(wordId, allowlist)) {
      units.push({ wordId, tokenIndex, tokenLength: 1 });
    }
  }

  return units;
}

/** Resolve a rendered token click to its containing word or phrase unit. */
export function findLearningUnitAtTokenIndex(
  paragraphText: string,
  highlightTerms: readonly string[],
  tokenIndex: number,
): ReadingLearningUnit | null {
  if (!Number.isInteger(tokenIndex) || tokenIndex < 0) return null;

  return extractLearningUnits(paragraphText, highlightTerms).find(
    (unit) => tokenIndex >= unit.tokenIndex
      && tokenIndex < unit.tokenIndex + unit.tokenLength,
  ) ?? null;
}

/** Extract normalized lemmas once, preserving their first-seen order. */
export function extractUniqueLemmas(paragraphText: string): string[] {
  const unique = new Set<string>();

  for (const unit of extractLearningUnits(paragraphText)) {
    unique.add(unit.wordId);
  }

  return [...unique];
}

/** Return paragraph lemmas that have not already been exposed. */
export function getNewLemmas(
  paragraphText: string,
  exposedLemmas: ReadonlySet<string>
): string[] {
  return extractUniqueLemmas(paragraphText).filter((lemma) => !exposedLemmas.has(lemma));
}

/** Require 60% of the paragraph, capped at 60% of the viewport for long paragraphs. */
export function hasSufficientExposureVisibility(
  visibleHeight: number,
  paragraphHeight: number,
  viewportHeight: number
): boolean {
  if (visibleHeight <= 0 || paragraphHeight <= 0 || viewportHeight <= 0) return false;
  const requiredHeight = Math.min(paragraphHeight * 0.6, viewportHeight * 0.6);
  return visibleHeight >= requiredHeight;
}

export function shouldAdvanceRecommendationAtScrollEnd(
  lastParagraphBottom: number,
  scrollTop: number,
  viewportHeight: number,
  documentHeight: number,
  viewportTop = 0,
): boolean {
  if (![lastParagraphBottom, scrollTop, viewportHeight, documentHeight, viewportTop]
    .every(Number.isFinite)) return false;
  if (documentHeight <= viewportHeight || viewportHeight <= 0) return false;

  const paragraphExited = lastParagraphBottom <= viewportTop;
  const documentEnded = scrollTop + viewportHeight >= documentHeight - 2;
  return paragraphExited || documentEnded;
}

/** Continuous visible time required before a paragraph can produce exposure evidence. */
export function getMinimumExposureDwellMs(paragraphText: string): number {
  const wordCount = paragraphText.trim().split(/\s+/).filter(Boolean).length;
  return Math.min(6_000, Math.max(1_200, wordCount * 150));
}
