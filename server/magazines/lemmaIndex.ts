/**
 * Precomputed magazine lemma index for full-catalog Memory V2 ranking.
 * Built once, cached on disk, reused so interactive recommend avoids re-tokenizing
 * ~658 articles (~2s cold) on every click.
 */

import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import type { Article } from '../../src/types';
import { extractLearningUnits } from '../../src/lib/readingExposure';
import { getArticleLearningTerms } from '../../src/lib/readingLearningTerms';
import { getDataRoot, loadArticle, loadIndex, readJsonFile, writeFileAtomic } from './store';
import { getDictionaryContentVersion } from '../dictionary/service';
import { resolveDictionaryLearningWordIds } from '../dictionary/learningWordIds';

export interface MagazineLemmaIndexArticle {
  id: string;
  title: string;
  level?: string;
  topic?: string;
  sourceId?: string;
  wordCount?: number;
  /** Indices into `vocab`. */
  lemmaIndices: number[];
}

export interface MagazineLemmaIndex {
  version: number;
  fingerprint: string;
  builtAt: string;
  articleCount: number;
  vocab: string[];
  articles: MagazineLemmaIndexArticle[];
  /** Wall-clock build duration for diagnostics. */
  buildMs?: number;
}

// Bump when lemma extraction changes so persisted indexes are rebuilt.
const INDEX_VERSION = 4 as const;
let memoryCache: MagazineLemmaIndex | null = null;
let buildInflight: Promise<MagazineLemmaIndex> | null = null;

function lemmaIndexPath(): string {
  return path.join(getDataRoot(), 'lemma-index.json');
}

function extractLemmasFromArticle(article: Article): string[] {
  const all = new Set<string>();
  const terms = getArticleLearningTerms(article);
  for (const paragraph of article.content) {
    for (const unit of extractLearningUnits(paragraph, terms)) all.add(unit.wordId);
  }
  return Array.from(all);
}

async function computeCatalogFingerprint(): Promise<string> {
  const index = await loadIndex();
  const articlesDir = path.join(getDataRoot(), 'articles_by_id');
  let fileCount = 0;
  let newestMtimeMs = 0;
  try {
    const names = await fs.readdir(articlesDir);
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      fileCount += 1;
      try {
        const stat = await fs.stat(path.join(articlesDir, name));
        if (stat.mtimeMs > newestMtimeMs) newestMtimeMs = stat.mtimeMs;
      } catch {
        // ignore individual stat failures
      }
    }
  } catch {
    // empty catalog
  }

  const raw = [
    `v${INDEX_VERSION}`,
    getDictionaryContentVersion(),
    index.lastSyncAt || 'none',
    `issues:${index.issues.length}`,
    `files:${fileCount}`,
    `mtime:${Math.floor(newestMtimeMs)}`,
  ].join('|');
  return createHash('sha1').update(raw).digest('hex').slice(0, 16);
}

async function loadAllArticles(): Promise<Article[]> {
  const articlesDir = path.join(getDataRoot(), 'articles_by_id');
  let names: string[] = [];
  try {
    names = (await fs.readdir(articlesDir)).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }

  const articles: Article[] = [];
  // Read in modest batches to avoid huge peak memory spikes.
  const batchSize = 40;
  for (let i = 0; i < names.length; i += batchSize) {
    const batch = names.slice(i, i + batchSize);
    const loaded = await Promise.all(
      batch.map(async (name) => {
        try {
          const raw = await fs.readFile(path.join(articlesDir, name), 'utf8');
          return JSON.parse(raw) as Article;
        } catch {
          return null;
        }
      })
    );
    for (const article of loaded) {
      if (
        article?.id
        && Array.isArray(article.content)
        && article.content.length > 0
      ) {
        articles.push(article);
      }
    }
  }
  return articles;
}

export async function buildMagazineLemmaIndex(): Promise<MagazineLemmaIndex> {
  const started = Date.now();
  const fingerprint = await computeCatalogFingerprint();
  const articles = await loadAllArticles();

  const vocabSet = new Set<string>();
  const perArticleLemmas: Array<{
    article: Article;
    lemmas: string[];
  }> = [];

  for (const article of articles) {
    const lemmas = extractLemmasFromArticle(article);
    for (const lemma of lemmas) vocabSet.add(lemma);
    perArticleLemmas.push({ article, lemmas });
  }

  const surfaces = Array.from(vocabSet);
  const resolved = await resolveDictionaryLearningWordIds(surfaces);
  const canonicalBySurface = new Map(surfaces.map((word, index) => [word, resolved[index]]));
  for (const row of perArticleLemmas) {
    row.lemmas = [...new Set(row.lemmas.map((word) => canonicalBySurface.get(word) ?? word))];
  }
  const vocab = [...new Set(resolved)].sort((a, b) => a.localeCompare(b));
  const vocabIndex = new Map(vocab.map((word, i) => [word, i]));

  const indexArticles: MagazineLemmaIndexArticle[] = perArticleLemmas.map(({ article, lemmas }) => {
    const wordCount = article.content.join(' ').trim().split(/\s+/).filter(Boolean).length;
    return {
      id: article.id,
      title: article.title,
      level: article.level,
      topic: article.topic,
      sourceId: article.magazineSourceId,
      wordCount,
      lemmaIndices: lemmas
        .map((lemma) => vocabIndex.get(lemma))
        .filter((idx): idx is number => typeof idx === 'number'),
    };
  });

  // Stable order for deterministic daily rotation overlays.
  indexArticles.sort((a, b) => a.id.localeCompare(b.id));

  const result: MagazineLemmaIndex = {
    version: INDEX_VERSION,
    fingerprint,
    builtAt: new Date().toISOString(),
    articleCount: indexArticles.length,
    vocab,
    articles: indexArticles,
    buildMs: Date.now() - started,
  };

  await writeFileAtomic(lemmaIndexPath(), `${JSON.stringify(result)}\n`);
  memoryCache = result;
  return result;
}

export async function loadMagazineLemmaIndex(
  options?: { forceRebuild?: boolean }
): Promise<MagazineLemmaIndex> {
  if (!options?.forceRebuild && memoryCache) {
    const fingerprint = await computeCatalogFingerprint();
    if (memoryCache.fingerprint === fingerprint) {
      return memoryCache;
    }
  }

  if (!options?.forceRebuild) {
    const disk = await readJsonFile<MagazineLemmaIndex | null>(lemmaIndexPath(), null);
    if (disk?.version === INDEX_VERSION && Array.isArray(disk.vocab) && Array.isArray(disk.articles)) {
      const fingerprint = await computeCatalogFingerprint();
      if (disk.fingerprint === fingerprint) {
        memoryCache = disk;
        return disk;
      }
    }
  }

  if (buildInflight && !options?.forceRebuild) {
    return buildInflight;
  }

  buildInflight = buildMagazineLemmaIndex().finally(() => {
    buildInflight = null;
  });
  return buildInflight;
}

/** Expand compact row → lemma strings (shared vocab). */
export function expandLemmaIndexArticle(
  index: MagazineLemmaIndex,
  row: MagazineLemmaIndexArticle
): string[] {
  const lemmas: string[] = [];
  for (const idx of row.lemmaIndices) {
    const word = index.vocab[idx];
    if (word) lemmas.push(word);
  }
  return lemmas;
}

export async function loadMagazineArticleById(articleId: string): Promise<Article | null> {
  return loadArticle(articleId);
}

/** Test helper */
export function clearMagazineLemmaIndexMemoryCache(): void {
  memoryCache = null;
  buildInflight = null;
}

/**
 * Non-blocking boot/sync prewarm: build or load the full-catalog lemma index so
 * the first Recommend click does not pay the ~3s cold-build cost.
 */
export async function warmMagazineLemmaIndex(
  reason: 'boot' | 'sync' | 'manual' = 'boot'
): Promise<MagazineLemmaIndex | null> {
  const started = Date.now();
  try {
    const index = await loadMagazineLemmaIndex();
    console.log(
      `[magazines] lemma index warm (${reason}): ${index.articleCount} articles, ` +
        `vocab=${index.vocab.length}, ${Date.now() - started}ms` +
        (index.buildMs != null ? ` (lastBuild=${index.buildMs}ms)` : '')
    );
    return index;
  } catch (error) {
    console.error(`[magazines] lemma index warm failed (${reason})`, error);
    return null;
  }
}
