import type { ProficiencyLevel } from '../types';
import type { DictionaryEntry } from './dictionaryClient';

export interface VocabularyCsvRow {
  word: string;
  phonetic: string;
  translation: string;
  proficiency: string;
}

export interface VocabularyExportProficiency {
  wordId: string;
  level: ProficiencyLevel;
  memoryScore: number;
}

const VOCABULARY_HEADERS = ['词汇', '英标', '翻译', '熟练度'] as const;

function escapeCsvCell(value: string): string {
  const safeValue = /^[\t\r ]*[=+\-@]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safeValue)
    ? `"${safeValue.replace(/"/g, '""')}"`
    : safeValue;
}

/** Build a UTF-8 CSV that opens cleanly in spreadsheet applications. */
export function buildVocabularyCsv(rows: readonly VocabularyCsvRow[]): string {
  const lines = [
    VOCABULARY_HEADERS,
    ...rows.map((row) => [row.word, row.phonetic, row.translation, row.proficiency]),
  ];

  return `\uFEFF${lines.map((line) => line.map(escapeCsvCell).join(',')).join('\r\n')}\r\n`;
}

export function buildVocabularyExportRows(
  proficiencies: readonly VocabularyExportProficiency[],
  dictionaryEntries: readonly (Pick<DictionaryEntry, 'phonetic' | 'basicMeaningsZh'> | null)[],
): VocabularyCsvRow[] {
  return proficiencies.map((proficiency, index) => {
    const entry = dictionaryEntries[index];
    const translation = (entry?.basicMeaningsZh ?? [])
      .map((meaning) => meaning.trim())
      .filter(Boolean)
      .slice(0, 2)
      .join('；');

    return {
      word: proficiency.wordId,
      phonetic: entry?.phonetic.trim() ?? '',
      translation,
      proficiency: formatVocabularyProficiency(proficiency.level, proficiency.memoryScore),
    };
  });
}

export function downloadVocabularyCsv(
  csv: string,
  filename = `english-ai-vocabulary-${new Date().toISOString().slice(0, 10)}.csv`,
): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
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
