import type { Article, ArticleProgressRow, LearningEvent } from '../types';
import type { ArticleWordEvidence } from './memoryV2/types';
import { toLemma } from './proficiency.legacy';
import { groupUserLibrary } from './userLibrary';

export interface ReadingStudyWord {
  wordId: string;
  articleIds: string[];
  surfaceForms: string[];
}

export interface ReadingStudyChapter {
  article: Article;
  number: number;
  started: boolean;
  lastOpenedAt?: string;
  words: ReadingStudyWord[];
}

export interface ReadingStudyItem {
  id: string;
  title: string;
  kind: 'article' | 'book' | 'document';
  unit: '章' | '页' | '篇';
  chapters: ReadingStudyChapter[];
  currentChapter: ReadingStudyChapter;
  completedCount: number;
  completed: boolean;
  lastOpenedAt?: string;
  words: ReadingStudyWord[];
}

/** Lookup evidence survives the short activity feed and daily raw-event cleanup. */
export function buildReadingStudyItems(
  progress: readonly ArticleProgressRow[],
  evidence: readonly ArticleWordEvidence[],
  events: readonly LearningEvent[],
  aliases: Readonly<Record<string, string>> = {},
): ReadingStudyItem[] {
  const wordsByArticle = new Map<string, Map<string, ReadingStudyWord>>();
  const addWord = (articleId: string | undefined, surface: string | undefined) => {
    const normalized = toLemma(surface ?? '');
    if (!articleId || !normalized) return;
    const wordId = aliases[normalized] || normalized;
    let words = wordsByArticle.get(articleId);
    if (!words) { words = new Map(); wordsByArticle.set(articleId, words); }
    const existing = words.get(wordId);
    if (existing) {
      if (!existing.surfaceForms.includes(normalized)) existing.surfaceForms.push(normalized);
    } else {
      words.set(wordId, { wordId, articleIds: [articleId], surfaceForms: [normalized] });
    }
  };
  evidence.forEach(row => {
    if (row.clickedOccurrenceCount > 0) addWord(row.articleId, row.wordId);
  });
  events.forEach(event => {
    if (event.type === 'click' || event.type === 'grammar_query' || event.type === 'add_review') {
      addWord(event.articleId, event.lemma);
    }
  });

  const progressById = new Map(progress.map(row => [row.article.id, row]));
  const items: ReadingStudyItem[] = [];
  for (const group of groupUserLibrary(progress.map(row => row.article))) {
    const articles = group.kind === 'file' ? group.file.articles : [group.article];
    const chapters = articles.map((article, index): ReadingStudyChapter => {
      const row = progressById.get(article.id)!;
      const words = [...(wordsByArticle.get(article.id)?.values() ?? [])]
        .sort((a, b) => a.wordId.localeCompare(b.wordId));
      return {
        article, number: index + 1, words,
        lastOpenedAt: row.lastOpenedAt || article.lastOpenedAt || article.completedAt,
        // Imported files start with In Progress even for unopened chapters.
        started: row.hasSession || Boolean(article.lastOpenedAt)
          || article.status === 'Completed' || words.length > 0,
      };
    });
    const started = chapters.filter(chapter => chapter.started);
    if (!started.length) continue;
    const currentChapter = started.slice().sort((a, b) =>
      (Date.parse(b.lastOpenedAt ?? '') || 0) - (Date.parse(a.lastOpenedAt ?? '') || 0)
      || b.number - a.number,
    )[0];
    const combinedWords = new Map<string, ReadingStudyWord>();
    chapters.forEach(chapter => chapter.words.forEach(word => {
      const previous = combinedWords.get(word.wordId);
      combinedWords.set(word.wordId, {
        wordId: word.wordId,
        articleIds: [...new Set([...(previous?.articleIds ?? []), ...word.articleIds])],
        surfaceForms: [...new Set([...(previous?.surfaceForms ?? []), ...word.surfaceForms])],
      });
    }));
    const completedCount = chapters.filter(chapter => chapter.article.status === 'Completed').length;
    const format = group.kind === 'file' ? group.file.format : undefined;
    items.push({
      id: articles[0].id,
      title: group.kind === 'file' ? group.file.title : articles[0].title,
      kind: group.kind === 'article' ? 'article' : format === 'epub' ? 'book' : 'document',
      unit: format === 'epub' ? '章' : format === 'pdf' ? '页' : '篇',
      chapters, currentChapter, completedCount,
      completed: completedCount === chapters.length,
      lastOpenedAt: currentChapter.lastOpenedAt,
      words: [...combinedWords.values()].sort((a, b) => a.wordId.localeCompare(b.wordId)),
    });
  }
  return items.sort((a, b) =>
    (Date.parse(b.lastOpenedAt ?? '') || 0) - (Date.parse(a.lastOpenedAt ?? '') || 0),
  );
}

/** Only show a source sentence when the recorded word/form actually occurs in it. */
export function findStudyWordContext(
  word: ReadingStudyWord,
  chapters: readonly ReadingStudyChapter[],
): { article: Article; sentence: string } | null {
  const forms = [...new Set([word.wordId, ...word.surfaceForms])]
    .map(form => form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(`\\b(?:${forms.join('|')})\\b`, 'i');
  for (const chapter of chapters) {
    if (!word.articleIds.includes(chapter.article.id)) continue;
    for (const paragraph of chapter.article.content) {
      if (!pattern.test(paragraph)) continue;
      const sentences = typeof Intl.Segmenter === 'function'
        ? Array.from(new Intl.Segmenter('en', { granularity: 'sentence' }).segment(paragraph), part => part.segment)
        : paragraph.match(/[^.!?]+[.!?]*/g) ?? [paragraph];
      const sentence = sentences.find(text => pattern.test(text));
      if (sentence) return { article: chapter.article, sentence: sentence.trim() };
    }
  }
  return null;
}
