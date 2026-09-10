import { buildCefrRecommendationProfile } from './userReadingProfile';
import type { CefrBand } from './articleLevel';

/** Cold-start defaults that do not import comprehension-test results into ranking. */
export function getArticleOnlyRecommendationDefaults(preferredLevel?: CefrBand) {
  const cefrProfile = buildCefrRecommendationProfile(preferredLevel);
  return {
    userLevel: cefrProfile.userLevel,
    cefrProfile,
  };
}
