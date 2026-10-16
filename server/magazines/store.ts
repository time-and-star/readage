import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import type {
  Article,
  MagazineArticleStub,
  MagazineCatalogArticleStub,
  MagazineCatalogIndex,
  MagazineIssue,
  MagazineSourceSummary,
  MagazineSyncResult,
} from '../../src/types';
import { articleContentFingerprint } from '../../src/lib/articleContent';
import { issueFileKey, MAGAZINE_SOURCES, parseIssueId } from './config';
import { loadCatalogArticleSummaries } from './catalogArticleCache';
import {
  getRecommendationPoolRotationDate,
  selectDailyRecommendationStubIds,
} from '../../src/lib/recommendationPoolRotation';

const DATA_ROOT = path.join(process.cwd(), 'data', 'magazines');

function indexPath() {
  return path.join(DATA_ROOT, 'index.json');
}
function syncStatePath() {
  return path.join(DATA_ROOT, 'sync-state.json');
}
function issuePath(sourceId: string, issueLabel: string) {
  return path.join(DATA_ROOT, 'issues', `${issueFileKey(sourceId, issueLabel)}.json`);
}
function articleDir(sourceId: string, issueLabel: string) {
  return path.join(DATA_ROOT, 'articles', issueFileKey(sourceId, issueLabel));
}
function safeFileName(id: string): string {
  // Windows forbids ':' and other reserved chars in file names
  return id.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
}

function articlePath(articleId: string) {
  return path.join(DATA_ROOT, 'articles_by_id', `${safeFileName(articleId)}.json`);
}
function blobPath(sha: string, ext: string) {
  return path.join(DATA_ROOT, 'blobs', `${sha}.${ext}`);
}

export interface StoredIssuePayload {
  issue: MagazineIssue;
  articles: MagazineArticleStub[];
}

export interface SyncState {
  importedShas: Record<string, string>; // issueId -> remoteSha
  lastResult: MagazineSyncResult | null;
  lastRunAt: string | null;
}

/** Keep configured sources visible even when an older on-disk index is loaded. */
export function mergeConfiguredSourceSummaries(
  existing: MagazineSourceSummary[]
): MagazineSourceSummary[] {
  const byId = new Map(existing.map((source) => [source.id, source]));
  return MAGAZINE_SOURCES.map((source) => {
    const stored = byId.get(source.id);
    return {
      id: source.id,
      displayName: source.displayName,
      levelHint: source.levelHint,
      topic: source.topic,
      sourceKind: source.sourceKind,
      issueCount: stored?.issueCount ?? 0,
    };
  });
}

async function ensureDirs() {
  await fs.mkdir(path.join(DATA_ROOT, 'issues'), { recursive: true });
  await fs.mkdir(path.join(DATA_ROOT, 'articles'), { recursive: true });
  await fs.mkdir(path.join(DATA_ROOT, 'articles_by_id'), { recursive: true });
  await fs.mkdir(path.join(DATA_ROOT, 'blobs'), { recursive: true });
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

export async function readJsonFile<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw) as T;
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return fallback;
    throw error;
  }
}

export async function writeFileAtomic(file: string, data: string | Uint8Array): Promise<void> {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const temporaryFile = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`
  );

  try {
    await fs.writeFile(temporaryFile, data);
    await fs.rename(temporaryFile, file);
  } catch (error) {
    await fs.rm(temporaryFile, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await ensureDirs();
  await writeFileAtomic(file, JSON.stringify(value, null, 2));
}

export async function loadSyncState(): Promise<SyncState> {
  return readJsonFile<SyncState>(syncStatePath(), {
    importedShas: {},
    lastResult: null,
    lastRunAt: null,
  });
}

export async function saveSyncState(state: SyncState): Promise<void> {
  await writeJson(syncStatePath(), state);
}

export async function loadIndex(): Promise<MagazineCatalogIndex> {
  const empty: MagazineCatalogIndex = {
    lastSyncAt: null,
    sources: MAGAZINE_SOURCES.map((s) => ({
      id: s.id,
      displayName: s.displayName,
      levelHint: s.levelHint,
      topic: s.topic,
      sourceKind: s.sourceKind,
      issueCount: 0,
    })),
    issues: [],
  };
  const index = await readJsonFile(indexPath(), empty);
  return {
    ...index,
    sources: mergeConfiguredSourceSummaries(index.sources),
  };
}

export async function saveIndex(index: MagazineCatalogIndex): Promise<void> {
  await writeJson(indexPath(), index);
}

export async function rebuildIndexFromIssues(issues: MagazineIssue[], lastSyncAt: string | null): Promise<MagazineCatalogIndex> {
  const counts = new Map<string, number>();
  for (const issue of issues) {
    counts.set(issue.sourceId, (counts.get(issue.sourceId) || 0) + 1);
  }
  const sources: MagazineSourceSummary[] = MAGAZINE_SOURCES.map((s) => ({
    id: s.id,
    displayName: s.displayName,
    levelHint: s.levelHint,
    topic: s.topic,
    sourceKind: s.sourceKind,
    issueCount: counts.get(s.id) || 0,
  }));
  const index: MagazineCatalogIndex = {
    lastSyncAt,
    sources,
    issues: [...issues].sort((a, b) => (b.issueLabel > a.issueLabel ? 1 : -1)),
  };
  await saveIndex(index);
  return index;
}

export async function saveIssuePayload(payload: StoredIssuePayload, articles: Article[]): Promise<void> {
  await writeJson(issuePath(payload.issue.sourceId, payload.issue.issueLabel), payload);
  const dir = articleDir(payload.issue.sourceId, payload.issue.issueLabel);
  await fs.mkdir(dir, { recursive: true });
  for (const article of articles) {
    await writeJson(path.join(dir, `${safeFileName(article.id)}.json`), article);
    await writeJson(articlePath(article.id), article);
  }
}

export async function loadIssuePayload(sourceId: string, issueLabel: string): Promise<StoredIssuePayload | null> {
  return readJsonFile<StoredIssuePayload | null>(issuePath(sourceId, issueLabel), null);
}

export async function loadIssueById(issueId: string): Promise<StoredIssuePayload | null> {
  const parsed = parseIssueId(issueId);
  if (!parsed) return null;

  // Only resolve file paths for issue IDs already present in the trusted catalog.
  const index = await loadIndex();
  const issue = index.issues.find((candidate) => candidate.id === issueId);
  if (!issue) return null;

  return loadIssuePayload(issue.sourceId, issue.issueLabel);
}

export async function loadArticle(articleId: string): Promise<Article | null> {
  return readJsonFile<Article | null>(articlePath(articleId), null);
}

export interface CatalogArticlePageOptions {
  level: string;
  query?: string;
  limit: number;
  cursor?: string;
}

export interface CatalogArticlePage {
  articles: MagazineCatalogArticleStub[];
  total: number;
  nextCursor: string | null;
}

async function loadCatalogIndexFromRoot(dataRoot: string): Promise<MagazineCatalogIndex> {
  return readJsonFile<MagazineCatalogIndex>(path.join(dataRoot, 'index.json'), {
    lastSyncAt: null,
    sources: [],
    issues: [],
  });
}

/**
 * Returns compact, article-level catalog rows from the current article files.
 * The enrichment process updates these files after import, unlike issue stubs.
 */
export async function loadCatalogArticlePage(
  options: CatalogArticlePageOptions,
  dataRoot = DATA_ROOT
): Promise<CatalogArticlePage> {
  const index = await loadCatalogIndexFromRoot(dataRoot);
  const sourceNames = new Map(index.sources.map((source) => [source.id, source.displayName]));
  const issues = new Map(index.issues.map((issue) => [issue.id, issue]));
  const normalizedQuery = options.query?.trim().toLocaleLowerCase() || '';
  const offset = Math.max(0, Number.parseInt(options.cursor || '0', 10) || 0);
  const directory = path.join(dataRoot, 'articles_by_id');

  let names: string[] = [];
  try {
    names = (await fs.readdir(directory)).filter((name) => name.endsWith('.json'));
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return { articles: [], total: 0, nextCursor: null };
    }
    throw error;
  }

  const summaries = await loadCatalogArticleSummaries(names.map(name => path.join(directory, name)));
  const rows = summaries.flatMap((article): MagazineCatalogArticleStub[] => {
    if (article.level !== options.level) return [];
    const issue = issues.get(article.issueId);
    const sourceName = sourceNames.get(article.sourceId) || article.sourceId;
    const issueLabel = issue?.issueLabel || article.date || article.issueId;
    const haystack = [article.title, article.description, sourceName, issueLabel].join(' ').toLocaleLowerCase();
    if (normalizedQuery && !haystack.includes(normalizedQuery)) return [];
    return [{ ...article, sourceName, issueLabel, date: article.date || issue?.publishedAt || issueLabel }];
  });

  rows.sort((a, b) => {
    const byDate = b.date.localeCompare(a.date);
    return byDate || a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
  });

  const articles = rows.slice(offset, offset + options.limit);
  const nextOffset = offset + articles.length;
  return {
    articles,
    total: rows.length,
    nextCursor: nextOffset < rows.length ? String(nextOffset) : null,
  };
}

const DEFAULT_RECOMMENDATION_CANDIDATE_LIMIT = 48;
const MIN_RECOMMENDATION_WORD_COUNT = 80;
/** Max eligible stubs considered before daily rotation picks the active pool. */
const DEFAULT_RECOMMENDATION_UNIVERSE_CAP = 320;

export interface RecommendationCandidatesResult {
  articles: Article[];
  /** Local calendar day key that seeded this pool (YYYY-MM-DD). */
  rotationDate: string;
  limit: number;
  /** Size of the eligible universe before daily sampling. */
  universeSize: number;
}

export interface LoadRecommendationCandidatesOptions {
  limit?: number;
  /** Inject for tests / admin overrides. Defaults to today's local date. */
  rotationDate?: string;
  /** Max stubs scanned across ready issues (default 320). */
  universeCap?: number;
  now?: Date;
}

/**
 * Load a daily-rotating recommendation pool from magazine issues.
 *
 * 1. Collect eligible stubs across ready issues (capped universe).
 * 2. Seed-shuffle by local calendar date so the set changes every day.
 * 3. Materialize full articles for the first `limit` valid bodies.
 */
export async function loadRecommendationCandidates(
  limitOrOptions: number | LoadRecommendationCandidatesOptions = DEFAULT_RECOMMENDATION_CANDIDATE_LIMIT
): Promise<RecommendationCandidatesResult> {
  const options: LoadRecommendationCandidatesOptions =
    typeof limitOrOptions === 'number' ? { limit: limitOrOptions } : limitOrOptions;

  const cappedLimit = Math.max(
    1,
    Math.min(120, Math.floor(options.limit ?? DEFAULT_RECOMMENDATION_CANDIDATE_LIMIT) || DEFAULT_RECOMMENDATION_CANDIDATE_LIMIT)
  );
  const universeCap = Math.max(
    cappedLimit,
    Math.min(
      800,
      Math.floor(options.universeCap ?? DEFAULT_RECOMMENDATION_UNIVERSE_CAP) || DEFAULT_RECOMMENDATION_UNIVERSE_CAP
    )
  );
  const rotationDate =
    options.rotationDate
    || getRecommendationPoolRotationDate(options.now ?? new Date());

  const index = await loadIndex();
  const readyIssues = [...index.issues]
    .filter((issue) => issue.status === 'ready' && issue.articleCount > 0)
    .sort((a, b) => {
      const byLabel = (b.issueLabel || '').localeCompare(a.issueLabel || '');
      if (byLabel !== 0) return byLabel;
      return (b.importedAt || '').localeCompare(a.importedAt || '');
    });

  // Build a broad eligible universe (not only the newest 48) so daily rotation
  // can surface different issues/sources over time.
  const universeStubs: Array<{
    id: string;
    wordCount?: number;
    issueId?: string;
    sourceId?: string;
  }> = [];
  const seenStubIds = new Set<string>();

  for (const issue of readyIssues) {
    if (universeStubs.length >= universeCap) break;
    const payload = await loadIssuePayload(issue.sourceId, issue.issueLabel);
    if (!payload?.articles?.length) continue;

    const stubs = [...payload.articles].sort(
      (a, b) => (b.wordCount ?? 0) - (a.wordCount ?? 0)
    );

    for (const stub of stubs) {
      if (universeStubs.length >= universeCap) break;
      if (seenStubIds.has(stub.id)) continue;
      if ((stub.wordCount ?? 0) > 0 && (stub.wordCount ?? 0) < MIN_RECOMMENDATION_WORD_COUNT) {
        continue;
      }
      seenStubIds.add(stub.id);
      universeStubs.push({
        id: stub.id,
        wordCount: stub.wordCount,
        issueId: issue.id,
        sourceId: issue.sourceId,
      });
    }
  }

  // Oversample ids so invalid/empty bodies can be skipped without shrinking the day pool.
  const orderedIds = selectDailyRecommendationStubIds(
    universeStubs,
    Math.min(universeStubs.length, cappedLimit * 3),
    rotationDate
  );

  const articles: Article[] = [];
  const loadedIds = new Set<string>();
  const seenContentFingerprints = new Set<string>();

  for (const articleId of orderedIds) {
    if (articles.length >= cappedLimit) break;
    if (loadedIds.has(articleId)) continue;
    loadedIds.add(articleId);

    const article = await loadArticle(articleId);
    if (!article?.id || !Array.isArray(article.content) || article.content.length === 0) {
      continue;
    }
    const textLen = article.content.join(' ').trim().length;
    if (textLen < MIN_RECOMMENDATION_WORD_COUNT) continue;

    // The same article is often present in several rolling issue snapshots.
    // IDs differ by issue, so deduplicate only after loading the canonical body.
    const fingerprint = articleContentFingerprint(article);
    if (fingerprint && seenContentFingerprints.has(fingerprint)) continue;
    if (fingerprint) seenContentFingerprints.add(fingerprint);

    articles.push(article);
  }

  return {
    articles,
    rotationDate,
    limit: cappedLimit,
    universeSize: universeStubs.length,
  };
}

export async function blobExists(sha: string, ext: string): Promise<boolean> {
  try {
    await fs.access(blobPath(sha, ext));
    return true;
  } catch {
    return false;
  }
}

export async function writeBlob(sha: string, ext: string, buffer: Buffer): Promise<string> {
  const file = blobPath(sha, ext);
  await ensureDirs();
  await writeFileAtomic(file, buffer);
  return file;
}

export async function readBlob(sha: string, ext: string): Promise<Buffer> {
  return fs.readFile(blobPath(sha, ext));
}

export function getDataRoot(): string {
  return DATA_ROOT;
}
