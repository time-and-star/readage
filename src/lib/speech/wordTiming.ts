export interface SpokenWord {
  text: string;
  start: number;
  end: number;
}

export function speechWords(text: string): SpokenWord[] {
  if (/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(text) && typeof Intl.Segmenter === 'function') {
    return Array.from(new Intl.Segmenter('ja', { granularity: 'word' }).segment(text))
      .filter(part => part.isWordLike)
      .map(part => ({ text: part.segment, start: part.index, end: part.index + part.segment.length }));
  }
  return Array.from(text.matchAll(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu), match => ({
    text: match[0], start: match.index!, end: match.index! + match[0].length,
  }));
}

/** Map chunk offsets back to the source monotonically, including repeated sentences. */
export function mapSpokenChunks(source: string, chunks: string[]): SpokenWord[][] {
  let cursor = 0;
  return chunks.map(chunk => speechWords(chunk).map(word => {
    const start = source.indexOf(word.text, cursor);
    if (start < 0) throw new Error('Speech chunk no longer matches its source.');
    cursor = start + word.text.length;
    return { ...word, start, end: cursor };
  }));
}

/** Duration-weighted guide, not forced alignment: use actual audio time, never wall time. */
export function estimateWordTimeline(text: string, duration: number): { start: number; end: number }[] {
  const words = speechWords(text);
  if (!words.length || !Number.isFinite(duration) || duration <= 0) return [];
  const weights = words.map((word, index) => {
    const syllables = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(word.text)
      ? Array.from(word.text).length * 0.6 : word.text.toLowerCase().match(/[aeiouy]+/g)?.length || 1;
    const gap = text.slice(word.end, words[index + 1]?.start ?? text.length);
    return Math.max(1, syllables) + Math.min(word.text.length, 12) * 0.08
      + (/[.!?。！？]/.test(gap) ? 1.4 : /[,;:、，；：]/.test(gap) ? 0.6 : 0);
  });
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let elapsed = 0;
  return weights.map(weight => {
    const start = elapsed;
    elapsed += duration * weight / total;
    return { start, end: elapsed };
  });
}

export function wordIndexAtTime(timeline: { start: number; end: number }[], time: number): number {
  if (!timeline.length || !Number.isFinite(time) || time < 0) return -1;
  const index = timeline.findIndex(word => time < word.end);
  return index < 0 ? timeline.length - 1 : index;
}
