import type { ProficiencyLevel } from '../types';

export interface VocabularyCsvRow {
  word: string;
  phonetic: string;
  translation: string;
  proficiency: string;
}

const VOCABULARY_HEADERS = ['词汇', '英标', '翻译', '熟练度'] as const;

function escapeCsvCell(value: string): string {
  return /[",\r\n]/.test(value)
    ? `"${value.replace(/"/g, '""')}"`
    : value;
}

/** Build a UTF-8 CSV that opens cleanly in spreadsheet applications. */
export function buildVocabularyCsv(rows: readonly VocabularyCsvRow[]): string {
  const lines = [
    VOCABULARY_HEADERS,
    ...rows.map((row) => [row.word, row.phonetic, row.translation, row.proficiency]),
  ];

  return `\uFEFF${lines.map((line) => line.map(escapeCsvCell).join(',')).join('\r\n')}\r\n`;
}

export function formatVocabularyProficiency(
  level: ProficiencyLevel,
  memoryScore: number,
): string {
  const score = Number.isFinite(memoryScore)
    ? Math.max(0, Math.min(100, Math.round(memoryScore)))
    : 0;
  return `L${level}（${score}分）`;
}
