import type { DictionaryExample } from './englishTypes';

export function isDictionaryExampleVisible(example: DictionaryExample): boolean {
  return example.reviewStatus === 'reviewed' || example.origin === 'dictionary-source';
}
