import type { MagazineIssue, MagazineSourceMeta, MagazineSyncResult, MagazineSyncStatus } from '../../src/types';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
  getMaxIssuesPerSource,
  getSourceById,
  MAGAZINE_SOURCES,
  makeIssueId,
} from './config';
import { discoverIssues, downloadFile } from './github';
import { discoverNewsInLevelsIssues, parseNewsInLevelsArticle } from './newsInLevels';
import { discoverFullTextIssues, materializeFullTextArticle, parseFullTextArticle, type FullTextFeedEntry } from './fullTextFeeds';
import { resolveArticleImage, imageExtension } from './assets';
import { articlesToStubs, buildIssueMeta, chaptersToArticles } from './normalize';
import { parseEpubBuffer } from './parseEpub';
import { parsePdfBuffer } from './parsePdf';
import {
  blobExists,
  loadIndex,
  loadArticle,
  loadIssuePayload,
  loadSyncState,
  readBlob,
  rebuildIndexFromIssues,
  saveIssuePayload,
  saveSyncState,
  writeBlob,
} from './store';

let running = false;
let progress: string | null = null;
let lastRunAt: string | null = null;
let lastResult: MagazineSyncResult | null = null;

export function getSyncStatus(): MagazineSyncStatus {
  return {
    running,
    lastRunAt,
    lastResult,
    progress,
  };
}

export interface SyncOptions {
  sources?: string[];
  maxIssuesPerSource?: number;
}

/** Matching feed fingerprints alone cannot prove that the offline files still exist. */
async function completeFullTextCache(issue: MagazineIssue, entry: FullTextFeedEntry, source: MagazineSourceMeta): Promise<boolean> {
  try {
    if (!(await blobExists(entry.sha, 'html')) || (await readBlob(entry.sha, 'html')).toString('utf8') !== entry.html) return false;
    const payload = await loadIssuePayload(source.id, issue.issueLabel);
    if (!payload || payload.articles.length !== 1) return false;
    const expectedId = `mag:${source.id}:${issue.issueLabel}:article-1`;
    if (payload.articles[0].id !== expectedId) return false;
    const article = await loadArticle(expectedId);
    const parsed = parseFullTextArticle(entry, source);
    if (!article || article.title !== entry.title || article.date !== entry.publishedAt.slice(0, 10)
      || JSON.stringify(article.content) !== JSON.stringify(parsed.paragraphs) || article.media?.length !== parsed.images.length) return false;
    for (let index = 0; index < parsed.images.length; index++) {
      const media = article.media![index], reference = parsed.images[index];
      const name = media.src.match(/^\/api\/magazines\/assets\/([a-f0-9]{64}\.(?:jpg|png|gif|webp))$/)?.[1];
      if (!name || media.caption !== reference.caption || media.alt !== reference.alt || media.afterParagraphIndex !== reference.afterParagraphIndex) return false;
      const file = await resolveArticleImage(name);
      if (!file) return false;
      const bytes = await fs.readFile(file);
      if (createHash('sha256').update(bytes).digest('hex') !== name.slice(0, 64) || imageExtension(bytes) !== name.split('.').pop()) return false;
    }
    return true;
  } catch { return false; }
}

export async function runMagazineSync(options: SyncOptions = {}): Promise<MagazineSyncResult> {
  if (running) {
    const err = new Error('Magazine sync already in progress');
    (err as Error & { code?: string }).code = 'SYNC_IN_PROGRESS';
    throw err;
  }

  running = true;
  progress = 'starting';
  const startedAt = new Date().toISOString();
  lastRunAt = startedAt;

  const maxIssues = getMaxIssuesPerSource(options.maxIssuesPerSource);
  const sourceIds = options.sources?.length
    ? options.sources
    : MAGAZINE_SOURCES.map((s) => s.id);

  const result: MagazineSyncResult = {
    ok: true,
    startedAt,
    finishedAt: '',
    importedIssues: 0,
    skippedIssues: 0,
    failedIssues: 0,
    errors: [],
    perSource: {},
  };

  try {
    const syncState = await loadSyncState();
    const existingIndex = await loadIndex();
    const issueMap = new Map<string, MagazineIssue>();
    for (const issue of existingIndex.issues) {
      issueMap.set(issue.id, issue);
    }

    for (const sourceId of sourceIds) {
      const source = getSourceById(sourceId);
      if (!source) {
        result.errors.push(`Unknown source: ${sourceId}`);
        continue;
      }
      result.perSource[sourceId] = { imported: 0, skipped: 0, failed: 0 };
      progress = `discovering ${source.displayName}`;

      let candidates;
      try {
        candidates = source.provider === 'news_in_levels'
          ? await discoverNewsInLevelsIssues(source, maxIssues)
          : source.provider === 'rss_fulltext'
            ? await discoverFullTextIssues(source, maxIssues)
          : source.repoDir
            ? await discoverIssues(source.repoDir, maxIssues)
            : (() => {
                throw new Error(`GitHub source ${source.id} is missing repoDir`);
              })();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push(`${sourceId}: discover failed: ${message}`);
        result.failedIssues += 1;
        result.perSource[sourceId].failed += 1;
        result.ok = false;
        continue;
      }

      for (const candidate of candidates) {
        const issueId = makeIssueId(source.id, candidate.issueLabel);
        const sha = candidate.preferredFile.sha;
        progress = `processing ${issueId}`;

        const cachedIssue = issueMap.get(issueId);
        if (syncState.importedShas[issueId] === sha && cachedIssue?.status === 'ready'
          && (!candidate.feedEntry || await completeFullTextCache(cachedIssue, candidate.feedEntry, source))) {
          result.skippedIssues += 1;
          result.perSource[sourceId].skipped += 1;
          continue;
        }

        try {
          const ext = candidate.format;
          let buffer: Buffer;
          if (candidate.format === 'html') {
            if (!candidate.content) throw new Error('Web source returned an empty HTML page');
            buffer = Buffer.from(candidate.content, 'utf8');
            if (candidate.feedEntry) await writeBlob(sha, ext, buffer);
          } else if (await blobExists(sha, ext)) {
            buffer = await readBlob(sha, ext);
          } else {
            if (!candidate.preferredFile.download_url) {
              throw new Error('No download_url for file');
            }
            progress = `downloading ${issueId}`;
            buffer = await downloadFile(candidate.preferredFile.download_url);
            await writeBlob(sha, ext, buffer);
          }

          progress = `parsing ${issueId}`;
          const chapters = candidate.feedEntry
            ? [await materializeFullTextArticle(candidate.feedEntry, source)]
            : candidate.format === 'html'
            ? (() => {
                const parsed = parseNewsInLevelsArticle(buffer.toString('utf8'));
                return [{
                  title: parsed.title,
                  paragraphs: parsed.paragraphs,
                  wordCount: parsed.paragraphs.join(' ').split(/\s+/).filter(Boolean).length,
                }];
              })()
            : candidate.format === 'epub'
              ? await parseEpubBuffer(buffer)
              : await parsePdfBuffer(buffer);

          const status = candidate.format === 'pdf' || chapters.length === 0 ? 'partial' : 'ready';
          if (chapters.length === 0) {
            throw new Error('No articles extracted from file');
          }

          const articles = chaptersToArticles(chapters, source, candidate.issueLabel);
          if (candidate.feedEntry) articles.forEach(article => { article.date = candidate.feedEntry!.publishedAt.slice(0, 10); });
          const issue = buildIssueMeta({
            source,
            issueLabel: candidate.issueLabel,
            format: candidate.format,
            remotePath: candidate.preferredFile.path,
            remoteSha: sha,
            articleCount: articles.length,
            status: status as MagazineIssue['status'],
            title: candidate.feedEntry?.title,
            publishedAt: candidate.feedEntry?.publishedAt,
          });

          await saveIssuePayload(
            { issue, articles: articlesToStubs(articles) },
            articles
          );

          issueMap.set(issue.id, issue);
          syncState.importedShas[issueId] = sha;
          result.importedIssues += 1;
          result.perSource[sourceId].imported += 1;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          result.errors.push(`${issueId}: ${message}`);
          result.failedIssues += 1;
          result.perSource[sourceId].failed += 1;
          result.ok = false;

          const failedIssue = buildIssueMeta({
            source,
            issueLabel: candidate.issueLabel,
            format: candidate.format,
            remotePath: candidate.preferredFile.path,
            remoteSha: sha,
            articleCount: 0,
            status: 'failed',
            errorMessage: message,
          });
          // A temporary feed/image failure must not hide the last readable cache.
          if (!issueMap.has(failedIssue.id)) issueMap.set(failedIssue.id, failedIssue);
        }
      }
    }

    const finishedAt = new Date().toISOString();
    result.finishedAt = finishedAt;
    lastResult = result;
    syncState.lastResult = result;
    syncState.lastRunAt = finishedAt;
    await saveSyncState(syncState);
    await rebuildIndexFromIssues([...issueMap.values()], finishedAt);
    // Catalog fingerprint changed — rebuild/load lemma index in the background
    // so full-catalog recommend stays warm after sync.
    void import('./lemmaIndex')
      .then(({ warmMagazineLemmaIndex }) => warmMagazineLemmaIndex('sync'))
      .catch((err) => {
        console.error('[magazines] post-sync lemma warm failed', err);
      });
    progress = null;
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.ok = false;
    result.errors.push(message);
    result.finishedAt = new Date().toISOString();
    lastResult = result;
    progress = null;
    throw err;
  } finally {
    running = false;
    if (!result.finishedAt) result.finishedAt = new Date().toISOString();
    lastResult = result;
  }
}

/** Load last result from disk on boot so status survives restarts. */
export async function hydrateSyncStatusFromDisk(): Promise<void> {
  try {
    const state = await loadSyncState();
    lastRunAt = state.lastRunAt;
    lastResult = state.lastResult;
  } catch {
    // ignore
  }
}
