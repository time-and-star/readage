/**
 * Memory V2 integration for ReadingScreen.
 * Exposure and click events share the same normalized learning unit and
 * occurrence identifier.
 */

import { useCallback, useRef } from 'react';
import { useMemorySystem } from './memoryV2/hooks';
import { toLemma } from './proficiency';
import type { ReadingLearningUnit } from './readingExposure';
import type { MemoryExposureSignals } from './memoryV2/types';
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
}: {
  articleId: string;
  paragraphIndex: number;
  unit: ReadingLearningUnit;
  exposedOccurrenceIds: Set<string>;
  recordExposure: MemoryEventRecorder;
  recordClick: MemoryEventRecorder;
  signals?: MemoryExposureSignals;
}): Promise<void> {
  const occurrenceId = createMemoryOccurrenceId(articleId, paragraphIndex, unit);

  if (!exposedOccurrenceIds.has(occurrenceId)) {
    exposedOccurrenceIds.add(occurrenceId);
    try {
      await recordExposure(unit.wordId, articleId, occurrenceId, signals);
    } catch (error) {
      exposedOccurrenceIds.delete(occurrenceId);
      throw error;
    }
  }

  await recordClick(unit.wordId, articleId, occurrenceId);
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
}: {
  articleId: string;
  paragraphIndex: number;
  units: readonly ReadingLearningUnit[];
  exposedOccurrenceIds: Set<string>;
  recordExposures: MemoryBatchRecorder;
  signals?: MemoryExposureSignals;
}): Promise<void> {
  const pending: Array<{
    wordId: string;
    articleId: string;
    occurrenceId: string;
  } & MemoryExposureSignals> = [];

  for (const unit of units) {
    const occurrenceId = createMemoryOccurrenceId(articleId, paragraphIndex, unit);
    if (exposedOccurrenceIds.has(occurrenceId)) continue;
    exposedOccurrenceIds.add(occurrenceId);
    pending.push({ wordId: unit.wordId, articleId, occurrenceId, ...signals });
  }

  if (pending.length === 0) return;

  try {
    await recordExposures(pending);
  } catch (error) {
    for (const item of pending) {
      exposedOccurrenceIds.delete(item.occurrenceId);
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
  });

  if (exposureStateRef.current.streamKey !== streamKey) {
    exposureStateRef.current = {
      streamKey,
      occurrenceIds: new Set<string>(),
    };
  }

  const snapshotWords = useCallback(
    async (wordIds: readonly string[]) => {
      const unique = [...new Set(wordIds.filter(Boolean))];
      if (unique.length === 0) return [];
      try {
        const map = await memorySystem.getBatchWordProficiency(userId, unique);
        return unique.map((wordId) => toVocabSnapshot(wordId, map.get(wordId) ?? null));
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
      try {
        await recordParagraphExposureWithRollback({
          articleId,
          paragraphIndex,
          units,
          exposedOccurrenceIds: exposureStateRef.current.occurrenceIds,
          recordExposures,
          signals: { ...defaults, ...signals },
        });
        // Real Memory V2 write succeeded → notify vocab particle view
        const words = await snapshotWords(units.map((unit) => unit.wordId));
        emitVocabExposure({ articleId, paragraphIndex, words });
      } catch (error) {
        console.error('Failed to record paragraph exposures:', error);
      }
    },
    [streamKey, defaults, recordExposures, snapshotWords],
  );

  const recordWordClick = useCallback(
    async (
      unit: ReadingLearningUnit,
      paragraphIndex: number,
      articleId: string = streamKey,
      signals: MemoryExposureSignals = {},
    ) => {
      try {
        await recordMemoryClickWithExposure({
          articleId,
          paragraphIndex,
          unit,
          exposedOccurrenceIds: exposureStateRef.current.occurrenceIds,
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
        const [word] = await snapshotWords([unit.wordId]);
        if (word) emitVocabClick({ articleId, paragraphIndex, word });
      } catch { /* Learning data is already committed. */ }
    },
    [streamKey, defaults, recordClick, recordExposure, snapshotWords],
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
  const tokens = paragraphText.trim().split(/\s+/).map(toLemma);
  const targetTokens = toLemma(targetWord).split(' ').filter(Boolean);
  if (targetTokens.length === 0) return -1;

  for (let index = 0; index <= tokens.length - targetTokens.length; index += 1) {
    const matches = targetTokens.every(
      (targetToken, offset) => tokens[index + offset] === targetToken,
    );
    if (matches) return index;
  }

  return -1;
}
