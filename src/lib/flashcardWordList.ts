export type FlashcardWordListFormat = 'text' | 'csv' | 'tsv' | 'json' | 'auto';

export interface ParsedFlashcardWordList {
  words: string[];
  duplicateCount: number;
  invalidCount: number;
  inputCount: number;
}

const MAX_ITEMS = 10_000;
const MAX_BYTES = 2 * 1024 * 1024;
const HEADERS = ['word', 'lemma', 'term', '单词', '词汇', '英文'];
const JSON_FIELDS = ['word', 'lemma', 'term'];
const ITEM_LIMIT_MESSAGE = '词表最多支持 10000 项，请拆分后导入。';
const LETTER = '\\p{Script=Latin}[\\p{Script=Latin}\\p{M}]*';
const ENGLISH_TERM = new RegExp(`^${LETTER}(?:['-]${LETTER})*(?: ${LETTER}(?:['-]${LETTER})*)*$`, 'u');

function cleanText(value: string): string {
  let word = value.normalize('NFKC').replace(/\uFEFF/g, '')
    .replace(/[‘’‚‛ʼ]/g, "'").replace(/[“”„‟«»]/g, '"')
    .replace(/[‐‑‒–—]/g, '-').trim();
  while (word.length > 1 && (word[0] === '"' || word[0] === "'") && word.at(-1) === word[0]) {
    word = word.slice(1, -1).trim();
  }
  return word.replace(/\s+/g, ' ').toLowerCase();
}

/** Conservative sentence checks; never tokenize a paragraph into individual words. */
function looksLikeSentence(value: string): boolean {
  return /[.!?。！？]/.test(value)
    || value.split(' ').length > 10 || value.length > 120
    || /^(?:i|you|he|she|we|they) (?!and\b|or\b|of\b|to\b)/.test(value)
    || /^(?:i'm|i've|i'll|i'd|you're|you've|you'll|you'd|he's|she's|it's|we're|we've|we'll|we'd|they're|they've|they'll|they'd|that's|there's) /.test(value)
    || /^(?:it|this|that|these|those|there) (?:am|is|are|was|were|has|have|had|can|could|will|would|should|must|does|did)\b/.test(value)
    || /^(?:the|a|an) \S+(?: \S+)? (?:is|are|was|were|has|have) /.test(value);
}

function normalizeWord(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const word = cleanText(value);
  return word && ENGLISH_TERM.test(word) && !looksLikeSentence(word)
    && !/^(?:https?|www)$/.test(word) ? word : null;
}

function checkCount(count: number): void {
  if (count > MAX_ITEMS) throw new RangeError(ITEM_LIMIT_MESSAGE);
}

/** RFC-style quoted fields, including doubled quotes and embedded CR/LF. */
function delimitedRows(text: string, delimiter: ',' | '\t'): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let closedQuote = false;
  const malformed = () => new SyntaxError('CSV/TSV 引号格式不正确，请检查未闭合或未转义的双引号。');
  const finishCell = () => { row.push(cell); cell = ''; closedQuote = false; };
  const finishRow = () => {
    finishCell();
    if (row.some(value => value.trim())) {
      rows.push(row);
      // One additional row may be the header; enforce the data limit after selection.
      if (rows.length > MAX_ITEMS + 1) throw new RangeError(ITEM_LIMIT_MESSAGE);
    }
    row = [];
  };
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character !== '"') cell += character;
      else if (text[index + 1] === '"') { cell += '"'; index += 1; }
      else { quoted = false; closedQuote = true; }
      continue;
    }
    if (character === delimiter) { finishCell(); continue; }
    if (character === '\r' || character === '\n') {
      finishRow();
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      continue;
    }
    if (closedQuote) {
      if (character === ' ' || character === '\t') continue;
      throw malformed();
    }
    if (character === '"') {
      if (cell.trim()) throw malformed();
      cell = '';
      quoted = true;
    } else cell += character;
  }
  if (quoted) throw malformed();
  finishRow();
  return rows;
}

function headerColumn(row: readonly string[]): number {
  const columns = row.map(cleanText);
  for (const header of HEADERS) {
    const column = columns.indexOf(header);
    if (column >= 0) return column;
  }
  return -1;
}

function rowItems(rows: readonly string[][]): unknown[] {
  const header = rows.length ? headerColumn(rows[0]) : -1;
  const data = header >= 0 ? rows.slice(1) : rows;
  checkCount(data.length);
  return data.map(row => row[header >= 0 ? header : 0] ?? '');
}

function jsonItems(text: string): unknown[] {
  let decoded: unknown;
  try { decoded = JSON.parse(text); }
  catch { throw new SyntaxError('JSON 词表格式不正确，请提供字符串数组或包含 word、lemma、term 的对象数组。'); }
  if (decoded && typeof decoded === 'object' && !Array.isArray(decoded)) {
    decoded = (decoded as { words?: unknown }).words;
  }
  if (!Array.isArray(decoded)) throw new TypeError('JSON 词表需要数组，或 {"words": [...]} 对象。');
  if (!decoded.length) throw new Error('JSON 词表为空，请添加单词后再导入。');
  checkCount(decoded.length);
  return decoded.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const fields = Object.entries(item).map(([key, value]) => [key.trim().toLowerCase(), value] as const);
    for (const key of JSON_FIELDS) {
      const field = fields.find(([name, value]) => name === key && typeof value === 'string' && value.trim());
      if (field) return field[1];
    }
    return undefined;
  });
}

function textItems(text: string): string[] {
  const items: string[] = [];
  for (const line of text.split(/\r\n?|\n|\u2028|\u2029/)) {
    const pieces = line.split(/[,;]/).filter(piece => piece.trim());
    // Commas inside a sentence must not turn its short fragments into flashcards.
    // A bad single entry (such as a URL) must still leave the other list entries usable.
    const sentence = pieces.some(piece => {
      const value = cleanText(piece);
      return value.includes(' ') && looksLikeSentence(value);
    }) || (pieces.length > 1 && /^(?:hello|hi|hey)$/i.test(cleanText(pieces[0])) && /[!?]\s*$/.test(line));
    const candidates = sentence ? [line] : pieces;
    for (const candidate of candidates) {
      if (candidate.trim()) items.push(candidate);
      checkCount(items.length);
    }
  }
  return items;
}

/** Parse locally only. Counts exclude table headers and wholly blank text lines/rows. */
export function parseFlashcardWordList(text: string, format: FlashcardWordListFormat = 'auto'): ParsedFlashcardWordList {
  if (typeof text !== 'string') throw new TypeError('词表内容必须是文本。');
  if (text.length > MAX_BYTES || new TextEncoder().encode(text).byteLength > MAX_BYTES) {
    throw new RangeError('词表文本不能超过 2 MiB，请拆分后导入。');
  }
  const content = text.replace(/^\uFEFF/, '').trim();
  if (!content) throw new Error('词表为空，请添加单词后再导入。');
  if (!['auto', 'text', 'csv', 'tsv', 'json'].includes(format)) throw new TypeError('不支持的词表格式。');
  let items: unknown[];
  if (format === 'json' || (format === 'auto' && /^[\[{]/.test(content))) items = jsonItems(content);
  else if (format === 'tsv' || (format === 'auto' && content.includes('\t'))) items = rowItems(delimitedRows(content, '\t'));
  else if (format === 'csv') items = rowItems(delimitedRows(content, ','));
  else if (format === 'auto' && content.includes(',')) {
    const rows = delimitedRows(content, ',');
    // One comma-separated line may contain the literal terms "word" or "lemma".
    // Without a data row it is a text list; explicit CSV still accepts header-only files.
    const table = rows.length > 1 && (headerColumn(rows[0] ?? []) >= 0
      || (rows[0].length > 1 && rows.every(row => row.length === rows[0].length)));
    items = table ? rowItems(rows) : textItems(content);
  } else items = textItems(content);
  if (!items.length) throw new Error('词表为空，请添加单词后再导入。');
  checkCount(items.length);
  const words: string[] = [];
  const seen = new Set<string>();
  let duplicateCount = 0;
  let invalidCount = 0;
  for (const item of items) {
    const word = normalizeWord(item);
    if (!word) invalidCount += 1;
    else if (seen.has(word)) duplicateCount += 1;
    else { seen.add(word); words.push(word); }
  }
  return { words, duplicateCount, invalidCount, inputCount: items.length };
}
