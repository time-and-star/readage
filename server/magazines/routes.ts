import { Router } from 'express';
import { getSourceById, MAGAZINE_SOURCES } from './config';
import {
  loadArticle,
  loadCatalogArticlePage,
  loadIndex,
  loadIssueById,
  loadRecommendationCandidates,
} from './store';
import { loadMagazineLemmaIndex } from './lemmaIndex';
import { getSyncStatus, runMagazineSync, type SyncOptions } from './sync';
import { hydrateMagazineMedia } from './mediaUpgrade';
import { resolveArticleImage } from './assets';
import { loadMagazineGalleryPage, loadMagazineGalleryStream, parseGalleryStreamCursor } from './gallery';


interface SyncRequestError extends Error {
  code: 'INVALID_SYNC_REQUEST';
}

interface CatalogArticleRequestError extends Error {
  code: 'INVALID_ARTICLE_CATALOG_REQUEST';
}

interface GalleryRequestError extends Error {
  code: 'INVALID_GALLERY_REQUEST';
}

export function parseGalleryQuery(query: Record<string, unknown>): { offset: number; limit: number } {
  const invalid = (message: string): never => {
    const error = new Error(`Invalid gallery request: ${message}`) as GalleryRequestError;
    error.code = 'INVALID_GALLERY_REQUEST';
    throw error;
  };
  const number = (key: string, fallback: number): number => {
    const value = query[key];
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) invalid(`${key} must be a non-negative integer`);
    const result = Number(value);
    if (!Number.isSafeInteger(result)) invalid(`${key} is too large`);
    return result;
  };
  const offset = number('offset', 0);
  const requestedLimit = number('limit', 24);
  if (requestedLimit < 1) invalid('limit must be positive');
  return { offset, limit: Math.min(60, requestedLimit) };
}

export function parseGalleryStreamQuery(query: Record<string, unknown>): { cursor?: string; limit: number } {
  const { limit } = parseGalleryQuery({ limit: query.limit ?? '12' });
  const cursor = query.cursor;
  if (cursor !== undefined && typeof cursor !== 'string') {
    throw Object.assign(new Error('Invalid gallery request: cursor must be a single string'), { code: 'INVALID_GALLERY_REQUEST' });
  }
  parseGalleryStreamCursor(cursor as string | undefined);
  return { cursor: cursor as string | undefined, limit: Math.min(24, limit) };
}

function publicFailure(code: string, error: unknown, fallback: string) {
  console.error(`[magazines:${code}]`, error);
  return { ok: false, error: { code, message: fallback } };
}

function invalidSyncRequest(message: string): SyncRequestError {
  const error = new Error(`Invalid sync request: ${message}`) as SyncRequestError;
  error.code = 'INVALID_SYNC_REQUEST';
  return error;
}

function invalidCatalogArticleRequest(message: string): CatalogArticleRequestError {
  const error = new Error(`Invalid article catalog request: ${message}`) as CatalogArticleRequestError;
  error.code = 'INVALID_ARTICLE_CATALOG_REQUEST';
  return error;
}

function queryValue(query: Record<string, unknown>, key: string): string | undefined {
  const value = query[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw invalidCatalogArticleRequest(`${key} must be a single string`);
  }
  return value;
}

export function parseCatalogArticleQuery(query: Record<string, unknown>) {
  const rawLevel = queryValue(query, 'level')?.trim().toUpperCase();
  const levels = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
  if (!rawLevel || !levels.includes(rawLevel)) {
    throw invalidCatalogArticleRequest(`level must be one of ${levels.join(', ')}`);
  }

  const rawQuery = queryValue(query, 'q');
  const normalizedQuery = rawQuery?.trim();
  if (normalizedQuery && normalizedQuery.length > 120) {
    throw invalidCatalogArticleRequest('q must be at most 120 characters');
  }

  const rawLimit = queryValue(query, 'limit');
  const limit = rawLimit === undefined ? 24 : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 60) {
    throw invalidCatalogArticleRequest('limit must be an integer from 1 to 60');
  }

  const cursor = queryValue(query, 'cursor');
  if (cursor !== undefined && !/^(0|[1-9]\d*)$/.test(cursor)) {
    throw invalidCatalogArticleRequest('cursor must be a non-negative integer');
  }

  return {
    level: rawLevel,
    query: normalizedQuery,
    limit,
    cursor,
  };
}

export function parseSyncRequest(body: unknown): SyncOptions {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw invalidSyncRequest('body must be a JSON object');
  }

  const value = body as Record<string, unknown>;
  let sources: string[] | undefined;
  if (Object.prototype.hasOwnProperty.call(value, 'sources')) {
    if (!Array.isArray(value.sources) || value.sources.length === 0) {
      throw invalidSyncRequest('sources must be a non-empty array');
    }
    if (value.sources.length > MAGAZINE_SOURCES.length) {
      throw invalidSyncRequest(`sources may contain at most ${MAGAZINE_SOURCES.length} items`);
    }

    const deduplicated = new Set<string>();
    for (const source of value.sources) {
      if (typeof source !== 'string' || !getSourceById(source)) {
        throw invalidSyncRequest(`unknown source: ${String(source)}`);
      }
      deduplicated.add(source);
    }
    sources = [...deduplicated];
  }

  let maxIssuesPerSource: number | undefined;
  if (Object.prototype.hasOwnProperty.call(value, 'maxIssuesPerSource')) {
    const requested = value.maxIssuesPerSource;
    if (!Number.isSafeInteger(requested) || (requested as number) < 1 || (requested as number) > 30) {
      throw invalidSyncRequest('maxIssuesPerSource must be an integer from 1 to 30');
    }
    maxIssuesPerSource = requested as number;
  }

  return { sources, maxIssuesPerSource };
}

export function createMagazineRouter(): Router {
  const router = Router();

  router.get('/gallery/stream', async (req, res) => {
    try {
      const page = await loadMagazineGalleryStream(parseGalleryStreamQuery(req.query));
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({ ok: true, ...page });
    } catch (error) {
      if ((error as GalleryRequestError).code === 'INVALID_GALLERY_REQUEST') {
        res.status(400).json({ ok: false, error: { code: 'INVALID_GALLERY_REQUEST', message: '图片浏览参数无效，请重新打开画廊。' } });
        return;
      }
      res.status(500).json(publicFailure('GALLERY_FAILED', error, '杂志图片暂时无法加载，请稍后重试。'));
    }
  });

  router.get('/gallery', async (req, res) => {
    try {
      const page = await loadMagazineGalleryPage(parseGalleryQuery(req.query));
      res.setHeader('Cache-Control', 'private, max-age=60');
      res.json({ ok: true, ...page });
    } catch (error) {
      if ((error as GalleryRequestError).code === 'INVALID_GALLERY_REQUEST') {
        res.status(400).json({ ok: false, error: { code: 'INVALID_GALLERY_REQUEST', message: '图片分页参数无效。' } });
        return;
      }
      res.status(500).json(publicFailure('GALLERY_FAILED', error, '杂志图片暂时无法加载，请稍后重试。'));
    }
  });

  router.get('/assets/:name', async (req, res) => {
    const file = await resolveArticleImage(req.params.name);
    if (!file) return res.sendStatus(404);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(file, (error) => {
      if (error && !res.headersSent) res.sendStatus(404);
    });
  });

  router.get('/sources', async (_req, res) => {
    try {
      const index = await loadIndex();
      res.json({
        ok: true,
        lastSyncAt: index.lastSyncAt,
        sources: index.sources.length ? index.sources : MAGAZINE_SOURCES.map((s) => ({
          id: s.id,
          displayName: s.displayName,
          levelHint: s.levelHint,
          topic: s.topic,
          issueCount: 0,
        })),
      });
    } catch (err) {
      res.status(500).json(publicFailure('CATALOG_FAILED', err, '文章目录暂时不可用，请稍后重试。'));
    }
  });

  router.get('/issues', async (req, res) => {
    try {
      const source = typeof req.query.source === 'string' ? req.query.source : undefined;
      const index = await loadIndex();
      let issues = index.issues;
      if (source) issues = issues.filter((i) => i.sourceId === source);
      res.json({ ok: true, lastSyncAt: index.lastSyncAt, issues });
    } catch (err) {
      res.status(500).json(publicFailure('ISSUES_FAILED', err, '期刊列表暂时不可用，请稍后重试。'));
    }
  });

  router.get('/issues/:issueId', async (req, res) => {
    try {
      // Express already decodes route parameters once. Do not decode attacker-controlled IDs again.
      const issueId = req.params.issueId;
      const payload = await loadIssueById(issueId);
      if (!payload) {
        return res.status(404).json({
          ok: false,
          error: { code: 'NOT_FOUND', message: `Issue not found: ${issueId}` },
        });
      }
      res.json({ ok: true, issue: payload.issue, articles: payload.articles });
    } catch (err) {
      res.status(500).json(publicFailure('ISSUE_FAILED', err, '期刊内容暂时不可用，请稍后重试。'));
    }
  });

  router.get('/articles', async (req, res) => {
    try {
      const query = parseCatalogArticleQuery(req.query as Record<string, unknown>);
      const page = await loadCatalogArticlePage(query);
      res.json({ ok: true, ...page });
    } catch (err) {
      const error = err as Error & { code?: string };
      if (error.code === 'INVALID_ARTICLE_CATALOG_REQUEST') {
        return res.status(400).json({
          ok: false,
          error: { code: error.code, message: error.message },
        });
      }
      res.status(500).json(publicFailure('ARTICLE_CATALOG_FAILED', error, '文章目录暂时不可用，请稍后重试。'));
    }
  });

  router.get('/articles/:articleId', async (req, res) => {
    try {
      const articleId = req.params.articleId;
      const article = await loadArticle(articleId);
      if (!article) {
        return res.status(404).json({
          ok: false,
          error: { code: 'NOT_FOUND', message: `Article not found: ${articleId}` },
        });
      }
      res.json({ ok: true, article: await hydrateMagazineMedia(article) });
    } catch (err) {
      res.status(500).json(publicFailure('ARTICLE_FAILED', err, '文章暂时不可用，请稍后重试。'));
    }
  });

  /**
   * Full articles for the interactive recommendation feed (Memory V2 ranking pool).
   * Query: ?limit=48 (1–120)
   * Pool members rotate once per local calendar day (stable within the day).
   */
  router.get('/recommendation-candidates', async (req, res) => {
    try {
      const rawLimit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 48;
      const limit = Number.isFinite(rawLimit) ? rawLimit : 48;
      const result = await loadRecommendationCandidates(limit);
      res.json({
        ok: true,
        count: result.articles.length,
        rotationDate: result.rotationDate,
        universeSize: result.universeSize,
        limit: result.limit,
        articles: result.articles,
      });
    } catch (err) {
      res.status(500).json(publicFailure('RECOMMENDATION_POOL_FAILED', err, '推荐内容暂时不可用，请稍后重试。'));
    }
  });

  /**
   * Compact full-catalog lemma index for client-side Memory V2 ranking.
   * Built once per catalog fingerprint (~2s cold), then served from disk/memory.
   * Query: ?rebuild=1 to force rebuild.
   */
  router.get('/lemma-index', async (req, res) => {
    try {
      const forceRebuild =
        req.query.rebuild === '1'
        || req.query.rebuild === 'true';
      const started = Date.now();
      const index = await loadMagazineLemmaIndex({ forceRebuild });
      res.json({
        ok: true,
        loadMs: Date.now() - started,
        index,
      });
    } catch (err) {
      res.status(500).json(publicFailure('LEMMA_INDEX_FAILED', err, '推荐索引暂时不可用，请稍后重试。'));
    }
  });

  router.get('/sync/status', (_req, res) => {
    res.json({ ok: true, ...getSyncStatus() });
  });

  router.post('/sync', async (req, res) => {
    try {
      const { sources, maxIssuesPerSource } = parseSyncRequest(req.body);

      // Run async so client can poll status; also return result when short
      const status = getSyncStatus();
      if (status.running) {
        return res.status(409).json({
          ok: false,
          error: { code: 'SYNC_IN_PROGRESS', message: 'Sync already running' },
          ...status,
        });
      }

      // Fire and continue — client polls /sync/status
      void runMagazineSync({ sources, maxIssuesPerSource })
        .then((result) => {
          console.log('[magazines] sync finished', result);
        })
        .catch((err) => {
          console.error('[magazines] sync failed', err);
        });

      res.status(202).json({
        ok: true,
        message: 'Sync started',
        ...getSyncStatus(),
      });
    } catch (err) {
      const e = err as Error & { code?: string };
      const code = e.code || 'SYNC_FAILED';
      const statusCode = code === 'SYNC_IN_PROGRESS' ? 409 : code === 'INVALID_SYNC_REQUEST' ? 400 : 500;
      res.status(statusCode).json({
        ok: false,
        error: {
          code,
          message: statusCode >= 500 ? '同步暂时失败，请稍后重试。' : e.message || 'Sync failed',
        },
      });
    }
  });

  return router;
}
