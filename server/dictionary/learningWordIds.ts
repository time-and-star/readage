import { getDictionaryRuntime } from './runtime';

/** Shared by the compact API and the server's persisted magazine vocabulary. */
export async function resolveDictionaryLearningWordIds(words: readonly string[]): Promise<string[]> {
  return (await getDictionaryRuntime().resolveLearningTerms(words)).map(ref => ref.stableId);
}
