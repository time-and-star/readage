/** Shared CEFR reading preferences and recommendation helpers. */
import { normalizeCefrBand, type CefrBand } from './articleLevel';

export const DEFAULT_USER_CEFR: CefrBand = 'B1';

export const CEFR_BAND_ORDER: readonly CefrBand[] = [
  'A1',
  'A2',
  'B1',
  'B2',
  'C1',
  'C2',
];

export type CefrConfidence = 'high' | 'medium' | 'low';

export type CefrRelation =
  | 'exact'
  | 'adjacent-higher'
  | 'adjacent-lower'
  | 'far-higher'
  | 'far-lower'
  | 'unknown';

export type CefrRecommendationProfile = {
  userLevel: CefrBand;
  useLevelFilter: boolean;
  confidence: CefrConfidence;
  idealBands: CefrBand[];
  stretchBand: CefrBand | null;
  cefrWeight: number;
  preferShorter: boolean;
};

const WORD_COUNT_BY_BAND: Record<CefrBand, { min: number; max: number }> = {
  A1: { min: 60, max: 120 },
  A2: { min: 100, max: 180 },
  B1: { min: 180, max: 300 },
  B2: { min: 250, max: 400 },
  C1: { min: 350, max: 550 },
  C2: { min: 450, max: 700 },
};

export function resolveUserCefrLevel(
  preferredLevel: string | null | undefined,
  fallback: CefrBand = DEFAULT_USER_CEFR
): CefrBand {
  return normalizeCefrBand(preferredLevel ?? '') || fallback;
}

function idealBandsFor(userLevel: CefrBand): CefrBand[] {
  const index = CEFR_BAND_ORDER.indexOf(userLevel);
  const bands = [userLevel];
  if (index < CEFR_BAND_ORDER.length - 1) bands.push(CEFR_BAND_ORDER[index + 1]);
  return bands;
}

function stretchBandFor(userLevel: CefrBand): CefrBand | null {
  const index = CEFR_BAND_ORDER.indexOf(userLevel);
  return index < CEFR_BAND_ORDER.length - 1
    ? CEFR_BAND_ORDER[index + 1]
    : null;
}

/** Build the single CEFR input shared by catalog, local and AI recommendations. */
export function buildCefrRecommendationProfile(
  preferredLevel: string | null | undefined = DEFAULT_USER_CEFR,
  options: { confidence?: CefrConfidence; useLevelFilter?: boolean } = {}
): CefrRecommendationProfile {
  const userLevel = resolveUserCefrLevel(preferredLevel);
  const confidence = options.confidence ?? 'low';
  const useLevelFilter = options.useLevelFilter ?? false;
  return {
    userLevel,
    useLevelFilter,
    confidence,
    idealBands: idealBandsFor(userLevel),
    stretchBand: stretchBandFor(userLevel),
    cefrWeight: useLevelFilter ? { high: 1.3, medium: 1, low: 0.7 }[confidence] : 0.4,
    preferShorter: CEFR_BAND_ORDER.indexOf(userLevel) <= CEFR_BAND_ORDER.indexOf('B1'),
  };
}

/** Map the ideal window to levels that actually exist in the current candidate pool. */
export function projectBandsOntoCatalog(
  idealBands: readonly (string | null | undefined)[],
  availableLevels: readonly (string | null | undefined)[]
): CefrBand[] {
  const ideal = idealBands
    .map((band) => normalizeCefrBand(band))
    .filter((band): band is CefrBand => Boolean(band));
  const available = [...new Set(
    availableLevels
      .map((band) => normalizeCefrBand(band))
      .filter((band): band is CefrBand => Boolean(band))
  )];
  if (ideal.length === 0 || available.length === 0) return [];

  const direct = ideal.filter((band) => available.includes(band));
  if (direct.length > 0) return direct;

  const distanceToIdeal = (band: CefrBand) => Math.min(
    ...ideal.map((target) => Math.abs(
      CEFR_BAND_ORDER.indexOf(band) - CEFR_BAND_ORDER.indexOf(target)
    ))
  );
  return available
    .sort((a, b) => {
      const distance = distanceToIdeal(a) - distanceToIdeal(b);
      return distance || CEFR_BAND_ORDER.indexOf(a) - CEFR_BAND_ORDER.indexOf(b);
    })
    .filter((band, index, bands) => distanceToIdeal(band) === distanceToIdeal(bands[0]));
}

export function getCefrRelation(
  articleLevel: string | undefined | null,
  userLevel: string
): CefrRelation {
  const article = normalizeCefrBand(articleLevel);
  const user = normalizeCefrBand(userLevel) || DEFAULT_USER_CEFR;
  if (!article) return 'unknown';

  const delta = CEFR_BAND_ORDER.indexOf(article) - CEFR_BAND_ORDER.indexOf(user);
  if (delta === 0) return 'exact';
  if (delta === 1) return 'adjacent-higher';
  if (delta === -1) return 'adjacent-lower';
  return delta > 0 ? 'far-higher' : 'far-lower';
}

export function suggestedWordCountRange(bandRaw: string): { min: number; max: number; label: string } {
  const band = normalizeCefrBand(bandRaw) || DEFAULT_USER_CEFR;
  const range = WORD_COUNT_BY_BAND[band];
  return {
    ...range,
    label: `${range.min}–${range.max} 词`,
  };
}

/** Distance between two CEFR bands (0 = same). Empty article level → null. */
export function cefrBandDistance(articleLevel: string | undefined | null, userLevel: string): number | null {
  const article = normalizeCefrBand(articleLevel);
  const user = normalizeCefrBand(userLevel) || DEFAULT_USER_CEFR;
  if (!article) return null;
  return Math.abs(CEFR_BAND_ORDER.indexOf(article) - CEFR_BAND_ORDER.indexOf(user));
}

/**
 * Multiplier for recommendation scoring: exact match > adjacent > farther.
 */
export function cefrLevelMatchMultiplier(
  articleLevel: string | undefined | null,
  userLevel: string
): number {
  const distance = cefrBandDistance(articleLevel, userLevel);
  if (distance === null) return 1;
  if (distance === 0) return 1.15;
  if (distance === 1) return 1.06;
  return 1;
}

/** Prefer rewrite targets near the user's preferred band. */
export function preferredRewriteLevels(userLevelRaw: string): CefrBand[] {
  const user = resolveUserCefrLevel(userLevelRaw);
  const index = CEFR_BAND_ORDER.indexOf(user);
  const nearby = [user];
  if (index > 0) nearby.push(CEFR_BAND_ORDER[index - 1]);
  if (index < CEFR_BAND_ORDER.length - 1) nearby.push(CEFR_BAND_ORDER[index + 1]);
  return nearby;
}
