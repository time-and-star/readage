/** Foreground, sufficiently visible reading time, measured with a monotonic clock. */
export interface ReadingDwellState {
  accumulatedMs: number;
  longestContinuousMs: number;
  activeSince: number | null;
  idleDeadline: number | null;
}

export interface ReadingDwellSnapshot {
  dwellTimeMs: number;
  continuousTimeMs: number;
  longestContinuousMs: number;
  isActive: boolean;
}

export function createReadingDwellState(): ReadingDwellState {
  return { accumulatedMs: 0, longestContinuousMs: 0, activeSince: null, idleDeadline: null };
}

/** Allow quiet reading, but do not count an unattended tab indefinitely. */
export function getReadingIdleAllowanceMs(expectedDwellTimeMs: number): number {
  const expected = Number.isFinite(expectedDwellTimeMs) ? Math.max(0, expectedDwellTimeMs) : 0;
  return Math.max(60_000, expected * 2);
}

export function getExpectedReadingDwellMs(paragraphText: string): number {
  const wordCount = paragraphText.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(300, wordCount * 300);
}

export function readReadingDwell(state: ReadingDwellState, now: number): ReadingDwellSnapshot {
  const end = Math.min(now, state.idleDeadline ?? now);
  const continuousTimeMs = state.activeSince === null ? 0 : Math.max(0, end - state.activeSince);
  return {
    dwellTimeMs: state.accumulatedMs + continuousTimeMs,
    continuousTimeMs,
    longestContinuousMs: Math.max(state.longestContinuousMs, continuousTimeMs),
    isActive: state.activeSince !== null && now < (state.idleDeadline ?? Infinity),
  };
}

/** Pause for scrolling away, a hidden/unfocused tab, or a reading overlay. */
export function pauseReadingDwell(state: ReadingDwellState, now: number): ReadingDwellState {
  const snapshot = readReadingDwell(state, now);
  return {
    accumulatedMs: snapshot.dwellTimeMs,
    longestContinuousMs: snapshot.longestContinuousMs,
    activeSince: null,
    idleDeadline: null,
  };
}

/** Starting after a pause preserves earlier reading time without including the pause. */
export function resumeReadingDwell(
  state: ReadingDwellState,
  now: number,
  idleAllowanceMs: number,
): ReadingDwellState {
  const paused = state.activeSince !== null && !readReadingDwell(state, now).isActive
    ? pauseReadingDwell(state, now)
    : state;
  if (paused.activeSince !== null) return paused;
  return { ...paused, activeSince: now, idleDeadline: now + idleAllowanceMs };
}

/** Extend an active session on real user activity; an expired idle gap is excluded. */
export function refreshReadingDwellActivity(
  state: ReadingDwellState,
  now: number,
  idleAllowanceMs: number,
): ReadingDwellState {
  const resumed = resumeReadingDwell(state, now, idleAllowanceMs);
  return { ...resumed, idleDeadline: now + idleAllowanceMs };
}

/** Progress requires one sustained segment; repeated flashes cannot qualify a paragraph. */
export function hasQualifiedReadingDwell(
  state: ReadingDwellState,
  now: number,
  minimumContinuousMs: number,
): boolean {
  return readReadingDwell(state, now).longestContinuousMs >= minimumContinuousMs;
}
