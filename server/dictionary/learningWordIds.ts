import { LearningWordIdResolver } from '../../src/lib/learningWordIds';
import { getDictionaryHealth, lookupDictionaryWords } from './service';

const resolver = new LearningWordIdResolver(async (words) => {
  if (!getDictionaryHealth().available) throw new Error('Learning-word dictionary is unavailable.');
  const entries = await lookupDictionaryWords(words);
  return entries.map((entry) => entry?.lemma ?? null);
});

/** Shared by the compact API and the server's persisted magazine vocabulary. */
export function resolveDictionaryLearningWordIds(words: readonly string[]): Promise<string[]> {
  return resolver.resolve(words);
}
