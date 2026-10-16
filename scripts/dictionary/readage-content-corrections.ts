import type { ReadAgeWord } from '../../packages/dictionary/readage';

export const READAGE_CONTENT_CORRECTIONS_VERSION = '2026-10-09.1';

// Exact text matches preserve later author edits while keeping reimports from
// restoring these known errors in the original published corpus.
const replacements: Record<string, ReadonlyMap<string, string>> = {
  promote: new Map([
    ['公共衛生', '公共卫生'],
    ['診所透過在遠離醫院的社區舉辦免費夜間接種時段，來推廣疫苗接種。', '诊所通过在远离医院的社区举办免费夜间接种时段，来推广疫苗接种。'],
    ['職場', '职场'],
    ['主導重新設計後，安娜獲晉升為部門主管。', '主导重新设计后，安娜获晋升为部门主管。'],
    ['商業', '商业'],
    ['書店在三間當地圖書館舉辦朗讀會，宣傳這本新譯作。', '书店在三间当地图书馆举办朗读会，宣传这本新译作。'],
  ]),
  compulsory: new Map([
    ['他们要一个义务的的答复，不要长篇发言。', '他们要一个义务的答复，不要长篇发言。'],
    ['即使是初读者也能看出，这个结果是义务的的。', '即使是初读者也能看出，这个结果是义务的。'],
  ]),
};

export function applyReadAgeContentCorrections(word: ReadAgeWord): ReadAgeWord {
  const corrections = replacements[word.lemma];
  if (!corrections) return word;
  function correct(value: unknown): unknown {
    if (typeof value === 'string') return corrections.get(value) ?? value;
    if (Array.isArray(value)) return value.map(correct);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, correct(item)]));
    return value;
  }
  return correct(word) as ReadAgeWord;
}
