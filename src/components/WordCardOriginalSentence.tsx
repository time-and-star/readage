import { WordCardText } from './WordCardText';

export function WordCardOriginalSentence({ text, word = '' }: { text: string; word?: string }) {
  const query = word.trim().toLowerCase(), lower = text.toLowerCase();
  const parts: Array<{ text: string; selected: boolean }> = [];
  let position = 0;
  if (query) for (let start = lower.indexOf(query); start >= 0; start = lower.indexOf(query, start + query.length)) {
    const end = start + query.length;
    if ((start > 0 && /[\p{L}\p{N}]/u.test(text[start - 1])) || (end < text.length && /[\p{L}\p{N}]/u.test(text[end]))) continue;
    if (start > position) parts.push({ text: text.slice(position, start), selected: false });
    parts.push({ text: text.slice(start, end), selected: true }); position = end;
  }
  if (position < text.length) parts.push({ text: text.slice(position), selected: false });
  return <span data-word-card-sentence="true">{parts.map((part, index) => part.selected
    ? <mark key={index}><WordCardText text={part.text} sentence={false} /></mark>
    : <WordCardText key={index} text={part.text} sentence={false} />)}</span>;
}
