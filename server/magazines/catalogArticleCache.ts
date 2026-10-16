import fs from 'node:fs/promises';
import type { Article, MagazineCatalogArticleStub } from '../../src/types';
import { getArticleCefrLevel } from '../../src/lib/articleLevel';

export type CatalogArticleSummary = Omit<MagazineCatalogArticleStub, 'sourceName' | 'issueLabel'>;
type CachedSummary = { signature: string; row: CatalogArticleSummary | null };
const summaries = new Map<string, CachedSummary>();
const pending = new Map<string, { signature: string; work: Promise<CatalogArticleSummary | null> }>();
const MAX_CACHED_SUMMARIES = 5_000;

/** File metadata detects enrichment updates, replacements and repaired files before reuse. */
async function readSummary(file: string): Promise<CatalogArticleSummary | null> {
  let signature: string;
  try {
    const stat = await fs.stat(file, { bigint: true });
    signature = `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch {
    summaries.delete(file);
    return null;
  }
  const cached = summaries.get(file);
  if (cached?.signature === signature) {
    summaries.delete(file);
    summaries.set(file, cached);
    return cached.row;
  }
  const existing = pending.get(file);
  if (existing?.signature === signature) return existing.work;
  const operation = { signature, work: Promise.resolve(null as CatalogArticleSummary | null) };
  operation.work = (async () => {
    let row: CatalogArticleSummary | null = null;
    try {
      const article = JSON.parse(await fs.readFile(file, 'utf8')) as Article;
      const level = getArticleCefrLevel(article);
      if (article.id && level && article.magazineIssueId && article.magazineSourceId) {
        row = { id: article.id, title: article.title, description: article.description,
          wordCount: article.content.join(' ').trim().split(/\s+/).filter(Boolean).length,
          level, sourceId: article.magazineSourceId, issueId: article.magazineIssueId, date: article.date || '' };
      }
    } catch { /* A damaged article must not prevent the rest of the catalog from opening. */ }
    if (pending.get(file) === operation) {
      summaries.delete(file);
      summaries.set(file, { signature, row });
      if (summaries.size > MAX_CACHED_SUMMARIES) summaries.delete(summaries.keys().next().value!);
    }
    return row;
  })();
  pending.set(file, operation);
  try { return await operation.work; }
  finally { if (pending.get(file) === operation) pending.delete(file); }
}

/** Bound disk work instead of opening thousands of full article files together. */
export async function loadCatalogArticleSummaries(files: readonly string[]): Promise<CatalogArticleSummary[]> {
  const rows: Array<CatalogArticleSummary | null> = new Array(files.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(32, files.length) }, async () => {
    while (next < files.length) {
      const index = next++;
      rows[index] = await readSummary(files[index]);
    }
  }));
  return rows.filter((row): row is CatalogArticleSummary => row !== null);
}
