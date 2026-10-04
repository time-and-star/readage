/**
 * Memory V2 integration for ReadingScreen.
 * Exposure and click events share the same normalized learning unit and
 * occurrence identifier.
 */

import { useCallback, useRef } from 'react';
import { useMemorySystem } from './memoryV2/hooks';
import { getReadingTermMatches } from './textHighlight';
import { tokenizeReadingParagraph } from './readingTokens';
import type { ReadingLearningUnit } from './readingExposure';
import type { MemoryExposureSignals } from './memoryV2/types';
import { resolveLearningWordIds } from './dictionaryClient';
import { getCanonicalWordProficiencyMap } from './learningWordProficiency';
import { canonicalLearningWordId } from './learningWordIds';
import {
  emitVocabClick,
  emitVocabExposure,
  toVocabSnapshot,
} from './vocabTelemetry';

type MemoryEventRecorder = (
  wordId: string,
  articleId: string,
  occurrenceId: string,
  signals?: MemoryExposureSignals,
) => Promise<void>;

type MemoryBatchRecorder = (
  items: ReadonlyArray<{
    wordId: string;
    articleId: string;
    occurrenceId: string;
  } & MemoryExposureSignals>,
) => Promise<void>;

/** Build the stable id used by both exposure and click for one occurrence. */
export function createMemoryOccurrenceId(
  articleId: string,
  paragraphIndex: number,
  unit: ReadingLearningUnit,
): string {
  return `${articleId}:p${paragraphIndex}:w${unit.tokenIndex}:${unit.wordId}`;
}

/**
 * Record a click and, when needed, first create the matching exposure.
 * This prevents fast clicks (before the 800ms paragraph timer) from producing
 * click-only evidence with validExposureCount = 0.
 */
export async function recordMemoryClickWithExposure({
  articleId,
  paragraphIndex,
  unit,
  exposedOccurrenceIds,
  recordExposure,
  recordClick,
  signals,
  canonicalWordId,
  occurrenceStartedAts,
}: {
  articleId: string;
  paragraphIndex: number;
  unit: ReadingLearningUnit;
  exposedOccurrenceIds: Set<string>;
  recordExposure: MemoryEventRecorder;
  recordClick: MemoryEventRecorder;
  signals?: MemoryExposureSignals;
  canonicalWordId?: string;
  occurrenceStartedAts?: Map<string, string>;
}): Promise<void> {
  const occurrenceId = createMemoryOccurrenceId(articleId, paragraphIndex, unit);
  const wordId = canonicalWordId || unit.wordId;

  if (!exposedOccurrenceIds.has(occurrenceId)) {
    const priorStartedAt = occurrenceStartedAts?.get(occurrenceId);
    const startedAt = priorStartedAt ?? signals?.exposureOccurredAt ?? new Date().toISOString();
    const exposureSignals = occurrenceStartedAts ? { ...signals, exposureOccurredAt: startedAt } : signals;
    occurrenceStartedAts?.set(occurrenceId, startedAt);
    exposedOccurrenceIds.add(occurrenceId);
    try {
      await recordExposure(wordId, articleId, occurrenceId, exposureSignals);
    } catch (error) {
      exposedOccurrenceIds.delete(occurrenceId);
      if (priorStartedAt === undefined) occurrenceStartedAts?.delete(occurrenceId);
      throw error;
    }
  }

  await recordClick(wordId, articleId, occurrenceId);
}

/**
 * Optimistically reserve paragraph occurrence ids and roll them back when the
 * persistent batch write fails, allowing a later visibility event to retry.
 */
export async function recordParagraphExposureWithRollback({
  articleId,
  paragraphIndex,
  units,
  exposedOccurrenceIds,
  recordExposures,
  signals,
  canonicalWordIds,
  exposureSnapshots,
  occurrenceStartedAts,
}: {
  articleId: string;
  paragraphIndex: number;
  units: readonly ReadingLearningUnit[];
  exposedOccurrenceIds: Set<string>;
  recordExposures: MemoryBatchRecorder;
  signals?: MemoryExposureSignals;
  canonicalWordIds?: readonly string[];
  exposureSnapshots?: Map<string, string>;
  occurrenceStartedAts?: Map<string, string>;
}): Promise<void> {
  const pending: Array<{
    wordId: string;
    articleId: string;
    occurrenceId: string;
  } & MemoryExposureSignals> = [];

  const priorReservations = new Map<string, { exposed: boolean; snapshot?: string; startedAt?: string }>();
  for (const [index, unit] of units.entries()) {
    const occurrenceId = createMemoryOccurrenceId(articleId, paragraphIndex, unit);
    const exposed = exposedOccurrenceIds.has(occurrenceId);
    const priorSnapshot = exposureSnapshots?.get(occurrenceId);
    const priorStartedAt = occurrenceStartedAts?.get(occurrenceId);
    const startedAt = priorStartedAt ?? signals?.exposureOccurredAt ?? new Date().toISOString();
    const exposureSignals = occurrenceStartedAts ? { ...signals, exposureOccurredAt: startedAt } : signals;
    const snapshot = JSON.stringify(exposureSignals ?? {});
    if (exposed && (!exposureSnapshots || priorSnapshot === snapshot)) continue;
    priorReservations.set(occurrenceId, { exposed, snapshot: priorSnapshot, startedAt: priorStartedAt });
    exposedOccurrenceIds.add(occurrenceId);
    exposureSnapshots?.set(occurrenceId, snapshot);
    occurrenceStartedAts?.set(occurrenceId, startedAt);
    pending.push({ wordId: canonicalWordIds?.[index] || unit.wordId, articleId, occurrenceId, ...exposureSignals });
  }

  if (pending.length === 0) return;

  try {
    await recordExposures(pending);
  } catch (error) {
    for (const item of pending) {
      const prior = priorReservations.get(item.occurrenceId)!;
      if (!prior.exposed) exposedOccurrenceIds.delete(item.occurrenceId);
      if (prior.snapshot === undefined) exposureSnapshots?.delete(item.occurrenceId);
      else exposureSnapshots?.set(item.occurrenceId, prior.snapshot);
      if (prior.startedAt === undefined) occurrenceStartedAts?.delete(item.occurrenceId);
      else occurrenceStartedAts?.set(item.occurrenceId, prior.startedAt);
    }
    throw error;
  }
}

/**
 * Complete Memory V2 integration hook for ReadingScreen.
 * It tracks exposed occurrence ids across paragraph visibility and fast clicks.
 *
 * `streamKey` resets the in-memory occurrence set when the reading stream
 * changes (e.g. primary article id). Within one continuous recommendation
 * stream, callers pass the real `articleId` for each paragraph/click so later
 * articles still write Memory V2 evidence.
 */
export function useMemoryV2Integration(
  streamKey: string,
  defaults: MemoryExposureSignals = {},
) {
  const {
    recordExposure,
    recordExposures,
    recordClick,
    memorySystem,
    userId,
  } = useMemorySystem();
  const exposureStateRef = useRef({
    streamKey,
    occurrenceIds: new Set<string>(),
    exposureSnapshots: new Map<string, string>(),
    occurrenceStartedAts: new Map<string, string>(),
  });

  if (exposureStateRef.current.streamKey !== streamKey) {
    exposureStateRef.current = {
      streamKey,
      occurrenceIds: new Set<string>(),
      exposureSnapshots: new Map<string, string>(),
      occurrenceStartedAts: new Map<string, string>(),
    };
  }
  // Cleanup from the previous reading stream must retain its own reservations.
  const exposureState = exposureStateRef.current;

  const snapshotWords = useCallback(
    async (wordIds: readonly string[]) => {
      const unique = [...new Set((await resolveLearningWordIds(wordIds)).filter(Boolean))];
      if (unique.length === 0) return [];
      try {
        const map = await memorySystem.getBatchWordProficiency(userId, unique);
        const legacy = unique.some((wordId) => !map.has(wordId))
          ? await getCanonicalWordProficiencyMap(await memorySystem.getAllWordProficiency(userId))
          : new Map();
        return unique.map((wordId) => toVocabSnapshot(wordId, map.get(wordId) ?? legacy.get(wordId) ?? null));
      } catch {
        return unique.map((wordId) => toVocabSnapshot(wordId, null));
      }
    },
    [memorySystem, userId],
  );

  const recordParagraphExposure = useCallback(
    async (
      paragraphIndex: number,
      units: readonly ReadingLearningUnit[],
      articleId: string = streamKey,
      signals: MemoryExposureSignals = {},
    ) => {
      const canonicalWordIds = await resolveLearningWordIds(units.map((unit) => unit.wordId));
      try {
        await recordParagraphExposureWithRollback({
          articleId,
          paragraphIndex,
          units,
          exposedOccurrenceIds: exposureState.occurrenceIds,
          exposureSnapshots: exposureState.exposureSnapshots,
          occurrenceStartedAts: exposureState.occurrenceStartedAts,
          canonicalWordIds,
          recordExposures,
          signals: { ...defaults, ...signals },
        });
      } catch (error) {
        console.error('Failed to record paragraph exposures:', error);
        throw error;
      }
      try {
        const words = await snapshotWords(canonicalWordIds);
        emitVocabExposure({ articleId, paragraphIndex, words });
      } catch { /* Telemetry must not turn a persisted exposure into a retry. */ }
    },
    [streamKey, defaults, exposureState, recordExposures, snapshotWords],
  );

  const recordWordClick = useCallback(
    async (
      unit: ReadingLearningUnit,
      paragraphIndex: number,
      articleId: string = streamKey,
      signals: MemoryExposureSignals = {},
      canonicalWordId?: string,
    ) => {
      const [wordId] = canonicalWordId
        ? [canonicalLearningWordId(unit.wordId, canonicalWordId)]
        : await resolveLearningWordIds([unit.wordId]);
      try {
        await recordMemoryClickWithExposure({
          articleId,
          paragraphIndex,
          unit,
          exposedOccurrenceIds: exposureState.occurrenceIds,
          canonicalWordId: wordId,
          occurrenceStartedAts: exposureState.occurrenceStartedAts,
          recordExposure,
          recordClick,
          signals: { ...defaults, ...signals },
        });
      } catch (error) {
        console.error('Failed to record click for', unit.wordId, error);
        throw error;
      }
      // Telemetry is best effort and must not turn a committed lookup into a retry.
      try {
        const [word] = await snapshotWords([wordId]);
        if (word) emitVocabClick({ articleId, paragraphIndex, word });
      } catch { /* Learning data is already committed. */ }
    },
    [streamKey, defaults, exposureState, recordClick, recordExposure, snapshotWords],
  );

  return {
    recordParagraphExposure,
    recordWordClick,
    snapshotWords,
  };
}

/**
 * Find the first rendered-token index of a normalized word or phrase.
 * Kept for compatibility with callers outside ReadingScreen.
 */
export function findWordIndexInParagraph(
  paragraphText: string,
  targetWord: string
): number {
  return getReadingTermMatches(tokenizeReadingParagraph(paragraphText), [targetWord])[0]?.tokenIndex ?? -1;
}
