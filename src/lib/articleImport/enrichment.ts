import type {
  Article,
  ArticleLevelRating,
  ArticleTranslationResult,
  TranslationResult,
} from '../../types';
import { postTutor } from '../tutorClient';

export type EnrichPhase = 'idle' | 'translating' | 'rating' | 'parallel' | 'done' | 'error';

export interface EnrichProgress {
  phase: EnrichPhase;
  /** 1-based when translating; 0 otherwise. */
  paragraphIndex: number;
  paragraphTotal: number;
  message: string;
  /** Optional metrics for long-form (万字) imports. */
  wordCount?: number;
  charCount?: number;
}

export type TranslateMode = 'full_article' | 'paragraph_pool' | 'skipped';

export interface EnrichResult {
  paragraphTranslations: string[];
  levelRating: ArticleLevelRating;
  level: string;
  /** English word count of processed body. */
  wordCount: number;
  /** Character count of processed body. */
  charCount: number;
  /** True when rating body was truncated to MAX_RATING_CHARS. */
  ratingTruncated: boolean;
  /** True when some source paragraphs were split to fit translate limits. */
  paragraphsSplit: boolean;
  /** How paragraph translations were produced. */
  translateMode: TranslateMode;
}

/** Limits sized for ~10,000-word (万字) active-reading imports. */
export const IMPORT_LIMITS = {
  /** Maximum paragraph units accepted by one translate_article request. */
  MAX_PARAGRAPHS: 400,
  /** Must stay ≤ tutorValidation `message` limit. */
  MAX_CHARS_PER_PARAGRAPH: 6_000,
  /**
   * Must stay ≤ tutorValidation `articleContext` limit.
   * ~10k English words often span 55–100k characters depending on vocabulary length.
   */
  MAX_RATING_CHARS: 120_000,
  /**
   * Paragraph-level concurrency when article is > 120k chars (or full-translate fails).
   * Product rule: default is full-article one-shot; only oversized -> 2-way segment pool.
   */
  TRANSLATE_CONCURRENCY: 2,
  /**
   * Full article in ONE LLM call when total characters ≤ this limit (12 万字).
   * Must stay ≤ tutorValidation paragraphs/articleContext budget (120_000).
   */
  MAX_FULL_ARTICLE_TRANSLATE_CHARS: 120_000,
  /** Product target for long-form smoke tests. */
  TEN_THOUSAND_WORDS: 10_000,
} as const;

const {
  MAX_PARAGRAPHS,
  MAX_CHARS_PER_PARAGRAPH,
  MAX_RATING_CHARS,
  TRANSLATE_CONCURRENCY,
  MAX_FULL_ARTICLE_TRANSLATE_CHARS,
} = IMPORT_LIMITS;

/**
 * Run async work over items with a fixed concurrency pool.
 * Results stay index-aligned with `items`.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  onItemDone?: (completed: number, total: number) => void
): Promise<R[]> {
  const total = items.length;
  const results = new Array<R>(total);
  if (total === 0) return results;

  const limit = Math.max(1, Math.min(concurrency, total));
  let nextIndex = 0;
  let completed = 0;

  async function runOne(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= total) return;
      results[index] = await worker(items[index], index);
      completed += 1;
      onItemDone?.(completed, total);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => runOne()));
  return results;
}

/** Count whitespace-separated English tokens. */
export function countWords(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

export function countChars(text: string): number {
  return text.length;
}

/** Split pasted text into paragraphs for import. */
export function splitArticleParagraphs(text: string): string[] {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  const byDouble = normalized
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (byDouble.length > 1) {
    return expandParagraphs(byDouble);
  }

  const bySingle = normalized
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (bySingle.length > 1) {
    return expandParagraphs(bySingle);
  }

  return expandParagraphs([normalized]);
}

/**
 * Split any paragraph that exceeds the per-call translate budget so 万字 bodies
 * are not silently clipped mid-paragraph.
 */
export function splitOversizedParagraph(
  text: string,
  maxChars = MAX_CHARS_PER_PARAGRAPH
): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= maxChars) return [trimmed];

  const chunks: string[] = [];
  // Prefer sentence boundaries; fall back to hard cuts.
  const sentences = trimmed.match(/[^.!?]+[.!?]+["']?|\S+$/g) || [trimmed];
  let buf = '';

  const flush = () => {
    if (buf.trim()) chunks.push(buf.trim());
    buf = '';
  };

  for (const sentence of sentences) {
    const piece = sentence.trim();
    if (!piece) continue;

    if (piece.length > maxChars) {
      flush();
      for (let i = 0; i < piece.length; i += maxChars) {
        chunks.push(piece.slice(i, i + maxChars));
      }
      continue;
    }

    const next = buf ? `${buf} ${piece}` : piece;
    if (next.length > maxChars) {
      flush();
      buf = piece;
    } else {
      buf = next;
    }
  }
  flush();
  return chunks.length ? chunks : [trimmed.slice(0, maxChars)];
}

function expandParagraphs(paragraphs: string[]): string[] {
  return paragraphs.flatMap((paragraph) => splitOversizedParagraph(paragraph));
}

/**
 * Normalize article.content into bounded translate units without dropping source paragraphs.
 * `sourceParagraphIndexes` maps each processing unit back to the immutable source content.
 */
export function prepareImportParagraphs(content: string[]): {
  paragraphs: string[];
  sourceParagraphIndexes: number[];
  sourceParagraphCount: number;
  paragraphsSplit: boolean;
  wordCount: number;
  charCount: number;
} {
  let paragraphsSplit = false;
  const paragraphs: string[] = [];
  const sourceParagraphIndexes: number[] = [];

  content.forEach((sourceParagraph, sourceIndex) => {
    const trimmed = sourceParagraph.trim();
    if (!trimmed) return;

    const parts = splitOversizedParagraph(trimmed);
    if (parts.length > 1) paragraphsSplit = true;
    for (const part of parts) {
      paragraphs.push(part);
      sourceParagraphIndexes.push(sourceIndex);
    }
  });

  const body = paragraphs.join('\n\n');
  return {
    paragraphs,
    sourceParagraphIndexes,
    sourceParagraphCount: content.length,
    paragraphsSplit,
    wordCount: countWords(body),
    charCount: countChars(body),
  };
}

function alignTranslationsToSourceParagraphs(
  translations: string[],
  prepared: Pick<
    ReturnType<typeof prepareImportParagraphs>,
    'sourceParagraphIndexes' | 'sourceParagraphCount'
  >
): string[] {
  const translationsBySource = Array.from(
    { length: prepared.sourceParagraphCount },
    () => [] as string[]
  );

  translations.forEach((translation, unitIndex) => {
    const sourceIndex = prepared.sourceParagraphIndexes[unitIndex];
    if (sourceIndex === undefined) return;
    translationsBySource[sourceIndex].push(translation);
  });

  return translationsBySource.map((parts) => parts.join('\n\n'));
}

type EnrichableArticle = Pick<Article, 'content'> &
  Partial<Pick<Article, 'paragraphTranslations' | 'levelRating' | 'source' | 'rewriteTargetLevel'>>;

function isUsableTranslation(t: unknown): boolean {
  return (
    typeof t === 'string'
    && t.trim().length > 0
    && !t.includes('翻译失败')
    && !t.includes('翻译为空')
  );
}

/** True when every source paragraph has a non-empty Chinese translation. */
export function hasCompleteParagraphTranslations(
  article: Pick<Article, 'content'> & Partial<Pick<Article, 'paragraphTranslations'>>
): boolean {
  const n = article.content?.length ?? 0;
  if (n === 0) return false;
  const translations = article.paragraphTranslations;
  return (
    Array.isArray(translations)
    && translations.length === n
    && translations.every(isUsableTranslation)
  );
}

/**
 * Single official grade: CEFR + rationale required
 * (bare magazine `level` hints without summary still need AI rating).
 */
export function hasOfficialLevelRating(
  article: Partial<Pick<Article, 'levelRating'>>
): boolean {
  return Boolean(article.levelRating?.level && article.levelRating?.summary);
}

/**
 * Whether import still needs work (missing translations and/or official rating).
 */
export function needsImportEnrichment(article: EnrichableArticle): boolean {
  if ((article.content?.length ?? 0) === 0) return false;
  return !hasCompleteParagraphTranslations(article) || !hasOfficialLevelRating(article);
}

/** Plan which enrichment steps remain; preserves already-complete fields. */
export interface EnrichmentPlan {
  needTranslation: boolean;
  needRating: boolean;
  existingTranslations?: string[];
  existingLevelRating?: ArticleLevelRating;
}

export function planImportEnrichment(article: EnrichableArticle): EnrichmentPlan {
  const translationsDone = hasCompleteParagraphTranslations(article);
  const ratingDone = hasOfficialLevelRating(article);
  return {
    needTranslation: !translationsDone,
    needRating: !ratingDone,
    existingTranslations: translationsDone ? article.paragraphTranslations : undefined,
    existingLevelRating: ratingDone ? article.levelRating : undefined,
  };
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

type ParagraphPoolReason = 'oversized' | 'too_many_paragraphs' | 'full_failed' | 'forced';

async function translateParagraphsConcurrent(
  paragraphs: string[],
  options: {
    title: string;
    targetLanguage: string;
    concurrency: number;
    reason: ParagraphPoolReason;
    fetcher?: typeof fetch;
    onProgress?: (progress: EnrichProgress) => void;
    wordCount: number;
    charCount: number;
  }
): Promise<string[]> {
  const total = paragraphs.length;
  const {
    concurrency,
    targetLanguage,
    fetcher,
    onProgress,
    title,
    wordCount,
    charCount,
    reason,
  } = options;

  const reasonLabel =
    reason === 'oversized'
      ? '\u8d85\u957f\u6587\u7ae0'
      : reason === 'too_many_paragraphs'
        ? '\u6bb5\u843d\u8d85\u8fc7\u5355\u6b21\u5168\u6587\u7ffb\u8bd1\u4e0a\u9650'
        : reason === 'full_failed'
          ? '\u5168\u6587\u7ffb\u8bd1\u5931\u8d25'
          : '\u5f3a\u5236\u5206\u6bb5';

  onProgress?.({
    phase: 'translating',
    paragraphIndex: 0,
    paragraphTotal: total,
    message: `${reasonLabel}，${concurrency} 路段并发 0/${total}…`,
    wordCount,
    charCount,
  });

  return mapPool(
    paragraphs,
    concurrency,
    async (paragraph, i) => {
      const source = clip(paragraph, MAX_CHARS_PER_PARAGRAPH);
      try {
        const response = await postTutor<TranslationResult>(
          {
            intent: 'translate',
            message: source,
            targetLanguage,
            paragraphIndex: i + 1,
            paragraphTotal: total,
            topic: title,
          },
          fetcher
        );
        const translated = response.result.translatedText?.trim() || '';
        return translated || `（第 ${i + 1} 段翻译为空）`;
      } catch (error) {
        const reasonText = error instanceof Error ? error.message : '翻译失败';
        return `（第 ${i + 1} 段翻译失败：${reasonText}）`;
      }
    },
    (completed, totalCount) => {
      onProgress?.({
        phase: 'translating',
        paragraphIndex: completed,
        paragraphTotal: totalCount,
        message: `${reasonLabel}，${concurrency} 路段并发 ${completed}/${totalCount}…`,
        wordCount,
        charCount,
      });
    }
  );
}

async function runTranslation(
  paragraphs: string[],
  prepared: { wordCount: number; charCount: number; paragraphsSplit: boolean },
  options: {
    title: string;
    targetLanguage: string;
    paragraphConcurrency: number;
    forceParagraphPool?: boolean;
    fetcher?: typeof fetch;
    onProgress?: (progress: EnrichProgress) => void;
    /** When true, progress messages note that rating runs in parallel. */
    parallelWithRating?: boolean;
  }
): Promise<{ paragraphTranslations: string[]; translateMode: TranslateMode }> {
  const total = paragraphs.length;
  const {
    title,
    targetLanguage,
    paragraphConcurrency,
    forceParagraphPool,
    fetcher,
    onProgress,
    parallelWithRating,
  } = options;
  const parallelNote = parallelWithRating ? '（与评级并行）' : '';

  const isOversized = prepared.charCount > MAX_FULL_ARTICLE_TRANSLATE_CHARS;
  const hasTooManyParagraphs = total > MAX_PARAGRAPHS;
  const canFullArticle = !forceParagraphPool && !isOversized && !hasTooManyParagraphs;

  if (canFullArticle) {
    onProgress?.({
      phase: parallelWithRating ? 'parallel' : 'translating',
      paragraphIndex: 0,
      paragraphTotal: total,
      message: `正在全文一次翻译（强制 ${total} 段对齐）${parallelNote}…`,
      wordCount: prepared.wordCount,
      charCount: prepared.charCount,
    });

    try {
      const response = await postTutor<ArticleTranslationResult>(
        {
          intent: 'translate_article',
          paragraphs,
          paragraphTotal: total,
          targetLanguage,
          topic: title,
        },
        fetcher
      );
      const translations = response.result.translations || [];
      if (translations.length !== total) {
        throw new Error(
          `段落数不匹配：模型返回 ${translations.length} 段，需要 ${total} 段`
        );
      }
      const paragraphTranslations = translations.map(
        (t, i) => (typeof t === 'string' && t.trim() ? t.trim() : `（第 ${i + 1} 段翻译为空）`)
      );
      onProgress?.({
        phase: parallelWithRating ? 'parallel' : 'translating',
        paragraphIndex: total,
        paragraphTotal: total,
        message: `全文翻译完成（${total} 段对齐）${parallelNote}`,
        wordCount: prepared.wordCount,
        charCount: prepared.charCount,
      });
      return { paragraphTranslations, translateMode: 'full_article' };
    } catch {
      const paragraphTranslations = await translateParagraphsConcurrent(paragraphs, {
        title,
        targetLanguage,
        concurrency: paragraphConcurrency,
        reason: 'full_failed',
        fetcher,
        onProgress,
        wordCount: prepared.wordCount,
        charCount: prepared.charCount,
      });
      return { paragraphTranslations, translateMode: 'paragraph_pool' };
    }
  }

  const paragraphTranslations = await translateParagraphsConcurrent(paragraphs, {
    title,
    targetLanguage,
    concurrency: paragraphConcurrency,
    reason: forceParagraphPool
      ? 'forced'
      : hasTooManyParagraphs
        ? 'too_many_paragraphs'
        : 'oversized',
    fetcher,
    onProgress,
    wordCount: prepared.wordCount,
    charCount: prepared.charCount,
  });
  return { paragraphTranslations, translateMode: 'paragraph_pool' };
}

async function runRating(
  paragraphs: string[],
  prepared: { wordCount: number; charCount: number },
  options: {
    title: string;
    sourceLevel?: string;
    fetcher?: typeof fetch;
    onProgress?: (progress: EnrichProgress) => void;
    parallelWithTranslation?: boolean;
  }
): Promise<{ levelRating: ArticleLevelRating; ratingTruncated: boolean }> {
  const fullBody = paragraphs.join('\n\n');
  const ratingBody = clip(fullBody, MAX_RATING_CHARS);
  const ratingTruncated = ratingBody.length < fullBody.length;
  const parallelNote = options.parallelWithTranslation ? '（与翻译并行）' : '';

  options.onProgress?.({
    phase: options.parallelWithTranslation ? 'parallel' : 'rating',
    paragraphIndex: 0,
    paragraphTotal: paragraphs.length,
    message: ratingTruncated
      ? `正在 CEFR 评级（已截断至 ${MAX_RATING_CHARS} 字符）${parallelNote}…`
      : `正在 CEFR 评级${parallelNote}…`,
    wordCount: prepared.wordCount,
    charCount: prepared.charCount,
  });

  try {
    const response = await postTutor<ArticleLevelRating>(
      {
        intent: 'rate_article',
        articleContext: ratingBody,
        topic: options.title,
      },
      options.fetcher
    );
    let levelRating = response.result;
    if (ratingTruncated) {
      levelRating = {
        ...levelRating,
        summary: `${levelRating.summary}（注：正文超过 ${MAX_RATING_CHARS} 字符，评级基于截断样本。）`,
      };
    }
    return { levelRating, ratingTruncated };
  } catch (error) {
    const reason = error instanceof Error ? error.message : '评级失败';
    return {
      levelRating: {
        level: options.sourceLevel?.trim() || 'B1',
        difficultyScore: 50,
        summary: `AI 评级失败（${reason}），保留文章原始等级 ${options.sourceLevel?.trim() || 'B1'}。可稍后重新导入。`,
      },
      ratingTruncated,
    };
  }
}

/**
 * Import enrichment: translation + CEFR rating.
 * - Default: full-article translate (≤120k chars); else 2-way paragraph pool.
 * - Translate and rate run **in parallel** when both are needed (rating uses English source).
 * - Article-level queue concurrency is independent (queue.ts).
 */
export async function enrichArticleOnImport(
  article: Pick<Article, 'title' | 'content'> & Partial<Pick<Article, 'level'>>,
  options?: {
    targetLanguage?: string;
    onProgress?: (progress: EnrichProgress) => void;
    /** Skip paragraph translation (rate only). */
    skipTranslation?: boolean;
    /** Skip CEFR rating (translate only). */
    skipRating?: boolean;
    /**
     * Override paragraph-pool concurrency
     * (default 2 when >120k chars or full-article translate fails).
     */
    translateConcurrency?: number;
    /** Force fallback paragraph pool (skip full-article path). */
    forceParagraphPool?: boolean;
    fetcher?: typeof fetch;
  }
): Promise<EnrichResult> {
  const prepared = prepareImportParagraphs(article.content);
  const paragraphs = prepared.paragraphs;
  const total = paragraphs.length;
  const onProgress = options?.onProgress;
  const fetcher = options?.fetcher;
  const targetLanguage = options?.targetLanguage || 'Chinese';
  const paragraphConcurrency = options?.translateConcurrency ?? TRANSLATE_CONCURRENCY;

  if (total === 0) {
    throw new Error('文章没有可处理的段落。');
  }

  const needTranslate = !options?.skipTranslation;
  const needRating = !options?.skipRating;
  const parallel = needTranslate && needRating;

  if (parallel) {
    onProgress?.({
      phase: 'parallel',
      paragraphIndex: 0,
      paragraphTotal: total,
      message: '翻译与 CEFR 评级并行中…',
      wordCount: prepared.wordCount,
      charCount: prepared.charCount,
    });
  }

  const translatePromise = needTranslate
    ? runTranslation(paragraphs, prepared, {
        title: article.title,
        targetLanguage,
        paragraphConcurrency,
        forceParagraphPool: options?.forceParagraphPool,
        fetcher,
        onProgress,
        parallelWithRating: parallel,
      })
    : Promise.resolve({
        paragraphTranslations: paragraphs.map(() => ''),
        translateMode: 'skipped' as TranslateMode,
      });

  const ratingPromise = needRating
    ? runRating(paragraphs, prepared, {
        title: article.title,
        sourceLevel: article.level,
        fetcher,
        onProgress,
        parallelWithTranslation: parallel,
      })
    : Promise.resolve({
        levelRating: {
          level: article.level?.trim() || 'B1',
          difficultyScore: 50,
          summary: '未能完成 AI 评级，暂用默认 B1。',
        } satisfies ArticleLevelRating,
        ratingTruncated: false,
      });

  const [translateResult, ratingResult] = await Promise.all([
    translatePromise,
    ratingPromise,
  ]);

  onProgress?.({
    phase: 'done',
    paragraphIndex: total,
    paragraphTotal: total,
    message: parallel
      ? '导入完成（翻译 + 评级已并行）'
      : '导入 enrichment 完成',
    wordCount: prepared.wordCount,
    charCount: prepared.charCount,
  });

  return {
    paragraphTranslations: alignTranslationsToSourceParagraphs(
      translateResult.paragraphTranslations,
      prepared
    ),
    levelRating: ratingResult.levelRating,
    level: ratingResult.levelRating.level,
    wordCount: prepared.wordCount,
    charCount: prepared.charCount,
    ratingTruncated: ratingResult.ratingTruncated,
    paragraphsSplit: prepared.paragraphsSplit,
    translateMode: translateResult.translateMode,
  };
}

/** Merge enrichment fields onto an article draft. */
export function applyEnrichmentToArticle<T extends Article>(
  article: T,
  enrichment: EnrichResult
): T {
  return {
    ...article,
    // Source content is canonical and immutable; processing units are never persisted over it.
    content: article.content,
    paragraphTranslations: enrichment.paragraphTranslations,
    levelRating: enrichment.levelRating,
    level: enrichment.level,
  };
}

