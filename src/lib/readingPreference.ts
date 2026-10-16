import { normalizeCefrBand, type CefrBand } from './articleLevel';
import { CEFR_BAND_ORDER, DEFAULT_USER_CEFR } from './userReadingProfile';

export type DifficultyFeedback = 'hard' | 'right' | 'easy';
export interface ReadingPreference { level: CefrBand; feedback: Record<string, DifficultyFeedback> }
export const defaultReadingPreference: ReadingPreference = { level: DEFAULT_USER_CEFR, feedback: {} };
export function normalizeReadingPreference(value: unknown): ReadingPreference {
  if (!value || typeof value !== 'object') return defaultReadingPreference;
  const row = value as ReadingPreference;
  const feedback = row.feedback && typeof row.feedback === 'object' ? Object.fromEntries(
    Object.entries(row.feedback).filter(([, rating]) => ['hard', 'right', 'easy'].includes(rating)),
  ) : {};
  return { level: normalizeCefrBand(row.level) || DEFAULT_USER_CEFR, feedback };
}
export function applyDifficultyFeedback(previous: ReadingPreference, articleId: string, articleLevel: string, rating: DifficultyFeedback): ReadingPreference {
  const band = normalizeCefrBand(articleLevel) || previous.level;
  const offset = rating === 'hard' ? -1 : rating === 'easy' ? 1 : 0;
  const index = Math.max(0, Math.min(CEFR_BAND_ORDER.length - 1, CEFR_BAND_ORDER.indexOf(band) + offset));
  return { level: CEFR_BAND_ORDER[index], feedback: { ...previous.feedback, [articleId]: rating } };
}
