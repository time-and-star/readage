import type { RawWordEvent } from './types';
import { calculateExposureQuality } from '../memoryV4/exposure';

function sameRawEvent(left: RawWordEvent, right: RawWordEvent): boolean {
  return left.userId === right.userId && left.wordId === right.wordId
    && left.articleId === right.articleId && left.localDate === right.localDate
    && left.occurrenceId === right.occurrenceId
    && left.eventType === right.eventType
    && left.occurredAt === right.occurredAt;
}

/** Only measured payload may evolve; encounter identity remains immutable. */
export function mergeExposureSnapshot(prior: RawWordEvent, incoming: RawWordEvent): RawWordEvent | null {
  if (!sameRawEvent(prior, incoming) || prior.eventType !== 'exposure'
    || prior.occurrenceId.startsWith('extension:')
    || Boolean(prior.isRecommendation) !== Boolean(incoming.isRecommendation)
    || (prior.expectedDwellTimeMs !== undefined && prior.expectedDwellTimeMs !== incoming.expectedDwellTimeMs)
    || (prior.contextText && incoming.contextText && prior.contextText !== incoming.contextText)) return null;
  const previousDwell = prior.dwellTimeMs;
  const nextDwell = incoming.dwellTimeMs;
  if (!Number.isFinite(nextDwell) || Number(nextDwell) < 0) return null;
  if (Number.isFinite(previousDwell) && Number(previousDwell) > Number(nextDwell)) return prior;
  return { ...prior, ...incoming,
    rmeExposureKind: prior.rmeExposureKind ?? incoming.rmeExposureKind,
    rmeIsValid: prior.rmeIsValid ?? incoming.rmeIsValid,
    rmeQuality: prior.rmeQuality === 0 || incoming.rmeQuality === 0 ? 0
      : incoming.rmeQuality ?? calculateExposureQuality(incoming),
  };
}

/** Merge raw events idempotently so a retried write cannot inflate evidence. */
export function mergeRawEvents(
  existing: RawWordEvent[],
  incoming: RawWordEvent[],
): RawWordEvent[] {
  const merged = [...existing];
  for (const event of incoming) {
    const index = merged.findIndex((prior) => sameRawEvent(prior, event));
    if (index < 0) merged.push(event);
    else merged[index] = mergeExposureSnapshot(merged[index], event) ?? merged[index];
  }
  return merged;
}
