import fs from 'fs/promises';
import path from 'path';
import type { Article, ArticleMedia, MagazineCatalogIndex, MagazineIssue } from '../../src/types';
import { issueFileKey, getSourceById } from './config';
import { parseEpubBuffer } from './parseEpub';
import { chaptersToArticles } from './normalize';
import { getDataRoot, readJsonFile, writeFileAtomic } from './store';
import { saveArticleImage } from './assets';

interface MediaEntry {
  media: ArticleMedia[];
  /** Original paragraph anchors permit safe reuse if cached prose was later edited. */
  anchors: Array<string | null>;
}

interface IssueMediaManifest {
  version: 1;
  sourceSha: string;
  articles: Record<string, MediaEntry>;
}

const pendingIssues = new Map<string, Promise<IssueMediaManifest>>();

async function readIssueMedia(issue: MagazineIssue, dataRoot: string): Promise<IssueMediaManifest | null> {
  const file = path.join(dataRoot, 'media_by_issue', `${issueFileKey(issue.sourceId, issue.issueLabel)}.json`);
  const cached = await readJsonFile<IssueMediaManifest | null>(file, null);
  return cached?.version === 1 && cached.sourceSha === issue.remoteSha ? cached : null;
}

async function getIssueMedia(issue: MagazineIssue, dataRoot: string): Promise<IssueMediaManifest> {
  const sha = issue.remoteSha!;
  const cacheKey = `${dataRoot}:${issue.id}:${sha}`;
  const pending = pendingIssues.get(cacheKey);
  if (pending) return pending;

  const operation = (async () => {
    const file = path.join(dataRoot, 'media_by_issue', `${issueFileKey(issue.sourceId, issue.issueLabel)}.json`);
    const cached = await readIssueMedia(issue, dataRoot);
    if (cached) return cached;

    // Migration reads the retained source locally; it never downloads anything.
    const buffer = await fs.readFile(path.join(dataRoot, 'blobs', `${sha}.epub`));
    const source = getSourceById(issue.sourceId);
    if (!source) throw new Error('Unknown magazine source');
    const chapters = await parseEpubBuffer(buffer, {
      saveImage: (image) => saveArticleImage(image, dataRoot),
    });
    const manifest: IssueMediaManifest = { version: 1, sourceSha: sha, articles: {} };
    for (const article of chaptersToArticles(chapters, source, issue.issueLabel)) {
      const media = article.media || [];
      manifest.articles[article.id] = {
        media,
        anchors: media.map((image) => image.afterParagraphIndex < 0
          ? null : article.content[image.afterParagraphIndex] || null),
      };
    }
    await writeFileAtomic(file, JSON.stringify(manifest));
    return manifest;
  })();
  pendingIssues.set(cacheKey, operation);
  try {
    return await operation;
  } finally {
    // Disk manifests provide the durable cache without keeping entire issues in RAM.
    pendingIssues.delete(cacheKey);
  }
}

export function applyMediaEntry(article: Article, entry: MediaEntry): Article {
  const media = entry.media.flatMap((image, index) => {
    if (image.afterParagraphIndex < 0) return [{ ...image, afterParagraphIndex: -1 }];
    const anchor = entry.anchors[index];
    if (!anchor) return [];
    const afterParagraphIndex = article.content[image.afterParagraphIndex] === anchor
      ? image.afterParagraphIndex : article.content.indexOf(anchor);
    return afterParagraphIndex >= 0 ? [{ ...image, afterParagraphIndex }] : [];
  });
  return { ...article, media };
}

/** Add missing media without rewriting stored prose, translations, or learning state. */
export async function hydrateMagazineMedia(article: Article, dataRoot = getDataRoot(),
  options: { restoreMissing?: boolean } = {}): Promise<Article> {
  if (Array.isArray(article.media) || !article.magazineIssueId || article.source !== 'magazine') return article;
  const index = await readJsonFile<MagazineCatalogIndex | null>(path.join(dataRoot, 'index.json'), null);
  const issue = index?.issues.find((candidate) => candidate.id === article.magazineIssueId);
  if (!issue) return article;
  if (issue.format !== 'epub') return { ...article, media: [] };
  if (!/^[a-f\d]{40,64}$/i.test(issue.remoteSha || '')) return article;
  try {
    // Article opening can reuse existing illustrations without waiting for a whole EPUB migration.
    const manifest = options.restoreMissing === false || process.env.READGE_OFFLINE === '1'
      ? await readIssueMedia(issue, dataRoot) : await getIssueMedia(issue, dataRoot);
    if (!manifest) return article;
    const entry = manifest.articles[article.id];
    return entry ? applyMediaEntry(article, entry) : { ...article, media: [] };
  } catch (error) {
    // A missing old source blob must not prevent an existing article from opening.
    console.warn(`[magazines:media] Could not restore images for ${issue.id}:`, error instanceof Error ? error.message : error);
    return article;
  }
}
