import type { LanguageAdapter, TextSegment } from '../contracts';
import { normalizeJapaneseSurface } from './japaneseSurface';

const cache = new Map<string, readonly TextSegment[]>();
const wordPattern = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Latin}\p{N}]/u;
const hiragana = /^[\p{Script=Hiragana}ー]+$/u;
const particles = new Set(['は', 'が', 'を', 'に', 'の', 'で', 'へ', 'と', 'も', 'や', 'か', 'ね', 'よ',
  'から', 'まで', 'だけ', 'ほど', 'より', 'こそ', 'さえ', 'でも', 'とか', 'など', 'って', 'とも',
  'しか', 'なら', 'ばかり', 'ので', 'のに', 'だから']);
const copulas = new Set(['です', 'でした', 'でしょう', 'だ', 'だった', 'だっ', 'だろう']);
// ICU can emit 食 / べ / ま / した. Joining lexical kana and auxiliary pieces
// makes the surface clickable; only the dictionary can confirm a lemma relationship.
const auxiliary = /^(?:ます|ました|ません|ませんでした|ましょう|した|して|ない|なかった|なく|なくて|ないで|た|て|で|だ|たい|たかった|れる|られる|せる|させる|う|よう|(?:て|で)(?:いる|いた|います|いました|いません|いませんでした))$/u;

/** Preserves original UTF-16 offsets, whitespace, punctuation and combining characters. */
export function segmentJapaneseText(text: string): TextSegment[] {
  const cached = cache.get(text);
  if (cached) return cached.map(segment => ({ ...segment }));
  const segmenter = new Intl.Segmenter('ja', { granularity: 'word' });
  const initial: TextSegment[] = [...segmenter.segment(text)].map(segment => ({
    text: segment.segment, start: segment.index, end: segment.index + segment.segment.length,
    kind: segment.isWordLike && wordPattern.test(segment.segment) ? 'term' : 'text',
  }));
  const segments: TextSegment[] = [];
  for (let index = 0; index < initial.length; index++) {
    const current = { ...initial[index] };
    const lexical = current.kind === 'term' && /\p{Script=Han}/u.test(current.text)
      && (/\p{Script=Hiragana}$/u.test(current.text) || /^[\p{Script=Han}々]$/u.test(current.text));
    if (lexical) {
      let hasKana = /\p{Script=Hiragana}/u.test(current.text);
      const next = initial[index + 1];
      if (!hasKana && next?.kind === 'term' && next.start === current.end && hiragana.test(next.text)
        && !particles.has(next.text) && !copulas.has(next.text)) {
        current.text += next.text; current.end = next.end; index++; hasKana = true;
      }
      if (hasKana) {
        // Match complete auxiliaries across ICU pieces (ま / せん / で / した),
        // so partial endings and nominal です/でした remain separate.
        let suffix = ''; let through = index;
        for (let tail = index + 1; tail < initial.length && tail <= index + 6; tail++) {
          const part = initial[tail];
          if (part.kind !== 'term' || part.start !== initial[tail - 1].end || !hiragana.test(part.text)) break;
          suffix += part.text;
          if (auxiliary.test(suffix)) through = tail;
        }
        while (index < through) { index++; current.text += initial[index].text; current.end = initial[index].end; }
      }
    }
    segments.push(current);
  }
  if (text.length <= 32_768) {
    cache.set(text, segments.map(segment => ({ ...segment })));
    if (cache.size > 64) cache.delete(cache.keys().next().value!);
  }
  return segments;
}

export const japaneseLanguageAdapter: LanguageAdapter = {
  language: 'ja', adapterVersion: 'japanese.v1.1:intl-word-segmenter',
  capabilities: { normalization: 'supported', segmentation: 'supported', candidates: 'supported', morphology: 'unsupported' },
  normalize: normalizeJapaneseSurface,
  segment: segmentJapaneseText,
  candidates: text => [{ text: normalizeJapaneseSurface(text), kind: 'normalized' }],
};
