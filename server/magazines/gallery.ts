import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { Article, MagazineCatalogIndex, MagazineGalleryItem, MagazineIssue } from '../../src/types';
import { issueFileKey } from './config';
import { getDataRoot, readJsonFile, type StoredIssuePayload } from './store';
import { applyMediaEntry, hydrateMagazineMedia } from './mediaUpgrade';
import { resolveArticleImage } from './assets';

const FILE_CONCURRENCY = 8;
const CACHE_TTL_MS = 10 * 60_000;
const LOCAL_IMAGE = /^\/api\/magazines\/assets\/([a-f0-9]{64}\.(?:jpg|png|gif|webp))$/;
const NON_STORY_TITLE = /^(magazine articles|contents|table of contents|cover|masthead|advertisements?)$/i;

interface MediaManifest {
  version: number;
  sourceSha: string;
  articles: Record<string, Parameters<typeof applyMediaEntry>[1]>;
}

interface GalleryCache {
  signature: string;
  expiresAt: number;
  items: MagazineGalleryItem[];
}

const galleryCache = new Map<string, GalleryCache>();
const pendingGalleries = new Map<string, Promise<MagazineGalleryItem[]>>();

export interface MagazineGalleryPage {
  items: MagazineGalleryItem[];
  total: number;
  nextOffset: number | null;
}

/** Atomic imports change these directory stamps, including new image manifests. */
async function librarySignature(dataRoot: string): Promise<string> {
  const stamps = await Promise.all(['index.json', 'issues', 'articles_by_id', 'media_by_issue', 'assets'].map(async name => {
    try {
      const stat = await fs.stat(path.join(dataRoot, name));
      return `${name}:${stat.mtimeMs}:${stat.size}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return `${name}:missing`;
      throw error;
    }
  }));
  return stamps.join('|');
}

async function readMediaManifest(issue: MagazineIssue, dataRoot: string): Promise<MediaManifest | null> {
  const manifest = await readJsonFile<MediaManifest | null>(path.join(dataRoot, 'media_by_issue',
    `${issueFileKey(issue.sourceId, issue.issueLabel)}.json`), null).catch(() => null);
  return manifest?.version === 1 && manifest.sourceSha === issue.remoteSha
    && manifest.articles && typeof manifest.articles === 'object' ? manifest : null;
}

async function loadIssueStories(
  issue: MagazineIssue, sourceName: string, dataRoot: string,
  existingImages = new Map<string, Promise<string | null>>()
): Promise<MagazineGalleryItem[][]> {
  const payload = await readJsonFile<StoredIssuePayload | null>(path.join(dataRoot, 'issues',
    `${issueFileKey(issue.sourceId, issue.issueLabel)}.json`), null).catch(() => null);
  const stubs = (Array.isArray(payload?.articles) ? payload.articles : []).filter(stub =>
    stub && typeof stub.id === 'string' && typeof stub.title === 'string'
    && (stub.wordCount ?? 80) >= 80 && !NON_STORY_TITLE.test(stub.title.trim()));
  if (!stubs.length) return [];
  let manifest = await readMediaManifest(issue, dataRoot);
  let triedMigration = Boolean(manifest);
  const seenArticles = new Set<string>();
  const stories: MagazineGalleryItem[][] = [];
  for (let offset = 0; offset < stubs.length; offset += FILE_CONCURRENCY) {
    const articles = await Promise.all(stubs.slice(offset, offset + FILE_CONCURRENCY).map(async stub => {
      const filename = stub.id.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
      const stored = await readJsonFile<Article | null>(path.join(dataRoot, 'articles_by_id', `${filename}.json`), null)
        .catch(() => null);
      return stored?.id === stub.id && stored.magazineIssueId === issue.id
        && Array.isArray(stored.content) && stored.content.length ? stored : null;
    }));
    if (!triedMigration) {
      const legacyArticle = articles.find(article => article && !Array.isArray(article.media));
      if (legacyArticle) {
        await hydrateMagazineMedia(legacyArticle, dataRoot);
        manifest = await readMediaManifest(issue, dataRoot);
        triedMigration = true;
      }
    }
    const pictures = await Promise.all(articles.map(async stored => {
      if (!stored || seenArticles.has(stored.id)) return [];
      seenArticles.add(stored.id);
      const entry = manifest?.articles[stored.id];
      let article = stored;
      if (!Array.isArray(stored.media) && entry) {
        try { article = applyMediaEntry(stored, entry); } catch { return []; }
      }
      const items: MagazineGalleryItem[] = [];
      const seenInArticle = new Set<string>();
      for (const image of Array.isArray(article.media) ? article.media : []) {
        if (!image || typeof image.src !== 'string') continue;
        const match = LOCAL_IMAGE.exec(image.src);
        if (!match || seenInArticle.has(image.src)
          || /advertisement|logo|tracking|spacer/i.test(image.alt || '')) continue;
        let resolution = existingImages.get(image.src);
        if (!resolution) {
          resolution = resolveArticleImage(match[1], dataRoot);
          existingImages.set(image.src, resolution);
        }
        if (!await resolution) {
          existingImages.delete(image.src);
          continue;
        }
        seenInArticle.add(image.src);
        items.push({ articleId: article.id, title: article.title, image, sourceName, issueLabel: issue.issueLabel });
      }
      return items;
    }));
    stories.push(...pictures.filter(items => items.length));
  }
  return stories;
}

async function scanGallery(dataRoot: string): Promise<MagazineGalleryItem[]> {
  const index = await readJsonFile<MagazineCatalogIndex | null>(path.join(dataRoot, 'index.json'), null);
  if (!index) return [];
  const sourceNames = new Map(index.sources.map(source => [source.id, source.displayName]));
  const issues = [...index.issues].filter(issue => issue.status === 'ready' && issue.format === 'epub')
    .sort((a, b) => (b.publishedAt || b.issueLabel).localeCompare(a.publishedAt || a.issueLabel)
      || a.id.localeCompare(b.id));
  const groups = new Map<string, MagazineGalleryItem[][]>();
  const seenArticles = new Set<string>();
  const existingImages = new Map<string, Promise<string | null>>();

  // Issues are sequential to bound EPUB migration memory. Article JSON reads are
  // batched; a legacy issue is hydrated once and its manifest is then reused.
  for (const issue of issues) {
    const stories = await loadIssueStories(issue, sourceNames.get(issue.sourceId) || issue.sourceId, dataRoot, existingImages);
    const uniqueStories = stories.filter(pictures => {
      if (seenArticles.has(pictures[0].articleId)) return false;
      seenArticles.add(pictures[0].articleId);
      return true;
    });
    if (!uniqueStories.length) continue;
    if (!groups.has(issue.sourceId)) groups.set(issue.sourceId, []);
    groups.get(issue.sourceId)!.push(...uniqueStories);
  }

  // First show one picture per story, alternating publications. Additional
  // illustrations follow later, so an illustrated story cannot fill the entry.
  const sources = [...groups.values()];
  const output: MagazineGalleryItem[] = [];
  const usedImages = new Set<string>();
  let remaining = true;
  while (remaining) {
    remaining = false;
    const longest = Math.max(0, ...sources.map(stories => stories.length));
    for (let position = 0; position < longest; position += 1) {
      for (const stories of sources) {
        const pictures = stories[position];
        if (!pictures) continue;
        let item = pictures.shift();
        while (item && usedImages.has(item.image.src)) item = pictures.shift();
        if (item) {
          usedImages.add(item.image.src);
          output.push(item);
        }
        if (pictures.length) remaining = true;
      }
    }
  }
  return output;
}

/** All eligible retained local images; gallery loading never downloads issues. */
export async function loadMagazineGallery(dataRoot = getDataRoot()): Promise<MagazineGalleryItem[]> {
  const root = path.resolve(dataRoot);
  const pending = pendingGalleries.get(root);
  if (pending) return pending;
  const operation = (async () => {
    const signature = await librarySignature(root);
    const cached = galleryCache.get(root);
    if (cached?.signature === signature && cached.expiresAt > Date.now()) return cached.items;
    const items = await scanGallery(root);
    // A first scan may create old-issue media manifests; cache the resulting state.
    const finalSignature = await librarySignature(root);
    const inputChanged = signature.split('|').slice(0, 3).join('|') !== finalSignature.split('|').slice(0, 3).join('|');
    galleryCache.set(root, { signature: inputChanged ? signature : finalSignature, items, expiresAt: Date.now() + CACHE_TTL_MS });
    if (galleryCache.size > 12) galleryCache.delete(galleryCache.keys().next().value!);
    return items;
  })();
  pendingGalleries.set(root, operation);
  try { return await operation; } finally { pendingGalleries.delete(root); }
}

export async function loadMagazineGalleryPage(
  options: { offset?: number; limit?: number } = {}, dataRoot = getDataRoot()
): Promise<MagazineGalleryPage> {
  const offset = Number.isSafeInteger(options.offset) && options.offset! >= 0 ? options.offset! : 0;
  const limit = Number.isSafeInteger(options.limit) ? Math.max(1, Math.min(60, options.limit!)) : 24;
  const gallery = await loadMagazineGallery(dataRoot);
  const items = gallery.slice(offset, offset + limit);
  const next = offset + items.length;
  return { items, total: gallery.length, nextOffset: next < gallery.length ? next : null };
}

interface StreamCursor {
  v: 1;
  seed: string;
  catalog: string;
  round: number;
  source: number;
  positions: Array<[number, number]>;
  recent: string[];
}

interface IssueGalleryCache {
  signature: string;
  expiresAt: number;
  stories: MagazineGalleryItem[][];
}

const issueGalleryCache = new Map<string, IssueGalleryCache>();
const pendingIssueGalleries = new Map<string, Promise<MagazineGalleryItem[][]>>();
const RECENT_STREAM_IMAGES = 64;

function invalidStreamCursor(): never {
  throw Object.assign(new Error('Invalid gallery request: malformed stream cursor'), { code: 'INVALID_GALLERY_REQUEST' });
}

/** A compact stateless cursor carries only offsets and a bounded recent window. */
export function parseGalleryStreamCursor(cursor?: string): StreamCursor | null {
  if (cursor === undefined) return null;
  if (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]{1,4096}$/.test(cursor)) invalidStreamCursor();
  let value: StreamCursor;
  try { value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { invalidStreamCursor(); }
  const integer = (number: unknown, max: number) => Number.isSafeInteger(number) && Number(number) >= 0 && Number(number) <= max;
  if (!value || value.v !== 1 || typeof value.seed !== 'string' || typeof value.catalog !== 'string'
    || !/^[a-f0-9]{16}$/.test(value.seed) || !/^[a-f0-9]{16}$/.test(value.catalog)
    || !integer(value.round, 1_000_000_000) || !integer(value.source, 63)
    || !Array.isArray(value.positions) || !value.positions.length || value.positions.length > 64
    || !value.positions.every(position => Array.isArray(position) && position.length === 2
      && position.every(offset => integer(offset, 10_000_000)))
    || !Array.isArray(value.recent) || value.recent.length > RECENT_STREAM_IMAGES
    || !value.recent.every(hash => typeof hash === 'string' && /^[a-f0-9]{24}$/.test(hash))) invalidStreamCursor();
  return value;
}

function shuffled<T>(values: T[], seed: string, key: (value: T) => string): T[] {
  return values.map(value => ({ value, rank: createHash('sha256').update(`${seed}:${key(value)}`).digest('hex') }))
    .sort((a, b) => a.rank.localeCompare(b.rank)).map(entry => entry.value);
}

async function loadStreamIssueStories(
  issue: MagazineIssue, sourceName: string, dataRoot: string, signature: string
): Promise<MagazineGalleryItem[][]> {
  const key = `${dataRoot}:${issue.id}`;
  const cached = issueGalleryCache.get(key);
  if (cached?.signature === signature && cached.expiresAt > Date.now()) return cached.stories;
  const pendingKey = `${key}:${signature}`;
  const pending = pendingIssueGalleries.get(pendingKey);
  if (pending) return pending;
  const operation = (async () => {
    const stories = await loadIssueStories(issue, sourceName, dataRoot);
    issueGalleryCache.set(key, { signature, stories, expiresAt: Date.now() + CACHE_TTL_MS });
    if (issueGalleryCache.size > 24) issueGalleryCache.delete(issueGalleryCache.keys().next().value!);
    return stories;
  })();
  pendingIssueGalleries.set(pendingKey, operation);
  try { return await operation; } finally { pendingIssueGalleries.delete(pendingKey); }
}

export interface MagazineGalleryStreamPage {
  items: MagazineGalleryItem[];
  nextCursor: string | null;
}

/**
 * Read the issues reached by this page only, alternating publications. Each new
 * session and completed round changes the order; no full-library scan is needed.
 */
export async function loadMagazineGalleryStream(
  options: { cursor?: string; limit?: number } = {}, dataRoot = getDataRoot()
): Promise<MagazineGalleryStreamPage> {
  let state = parseGalleryStreamCursor(options.cursor);
  const limit = Number.isSafeInteger(options.limit) ? Math.max(1, Math.min(24, options.limit!)) : 12;
  const root = path.resolve(dataRoot);
  const index = await readJsonFile<MagazineCatalogIndex | null>(path.join(root, 'index.json'), null);
  const issues = (index?.issues || []).filter(issue => issue.status === 'ready' && issue.format === 'epub');
  if (!issues.length) return { items: [], nextCursor: null };
  const sourceNames = new Map((index?.sources || []).map(source => [source.id, source.displayName]));
  const bySource = new Map<string, MagazineIssue[]>();
  for (const issue of issues) {
    if (!bySource.has(issue.sourceId)) bySource.set(issue.sourceId, []);
    bySource.get(issue.sourceId)!.push(issue);
  }
  const catalog = createHash('sha256').update(issues.map(issue => `${issue.id}:${issue.remoteSha || ''}`).sort().join('|'))
    .digest('hex').slice(0, 16);
  if (!state) state = { v: 1, seed: randomBytes(8).toString('hex'), catalog, round: 0, source: 0,
    positions: Array.from(bySource, () => [0, 0]), recent: [] };
  if (state.catalog !== catalog) {
    state.catalog = catalog;
    state.round = 0;
    state.source = 0;
    state.positions = Array.from(bySource, () => [0, 0]);
  }
  if (state.positions.length !== bySource.size || state.source >= bySource.size) invalidStreamCursor();
  const signature = await librarySignature(root);
  let schedule: MagazineIssue[][] = [];
  const refreshSchedule = () => {
    const seed = `${state!.seed}:${state!.round}`;
    schedule = shuffled([...bySource.keys()], seed, source => source)
      .map(source => shuffled(bySource.get(source)!, seed, issue => issue.id));
  };
  refreshSchedule();
  const loaded = new Map<string, MagazineGalleryItem[][]>();
  const ordered = new Map<string, MagazineGalleryItem[]>();
  const items: MagazineGalleryItem[] = [];
  let sawPicture = state.recent.length > 0;
  let emittedInRound = 0;
  let wholeRound = state.positions.every(position => position[0] === 0 && position[1] === 0);
  const maxSteps = Math.max(128, (issues.length + limit) * 16);
  for (let step = 0; items.length < limit && step < maxSteps; step += 1) {
    if (state.positions.every((position, source) => position[0] >= schedule[source].length)) {
      if (!sawPicture) return { items, nextCursor: null };
      // Small collections eventually exhaust the recent window. Keep the last
      // picture where alternatives exist; a one-picture library may repeat it.
      if (!emittedInRound && wholeRound) state.recent = state.recent.length > 1 ? state.recent.slice(-1) : [];
      state.round = state.round >= 1_000_000_000 ? 0 : state.round + 1;
      state.source = 0;
      state.positions = schedule.map(() => [0, 0]);
      sawPicture = false;
      emittedInRound = 0;
      wholeRound = true;
      ordered.clear();
      refreshSchedule();
    }
    const source = state.source;
    state.source = (source + 1) % schedule.length;
    const position = state.positions[source];
    const issue = schedule[source][position[0]];
    if (!issue) continue;
    let pictures = ordered.get(issue.id);
    if (!pictures) {
      let stories = loaded.get(issue.id);
      if (!stories) {
        stories = await loadStreamIssueStories(issue, sourceNames.get(issue.sourceId) || issue.sourceId, root, signature);
        loaded.set(issue.id, stories);
      }
      const shuffledStories = shuffled(stories, `${state.seed}:${state.round}:${issue.id}`, story => story[0].articleId);
      const depth = Math.max(0, ...shuffledStories.map(story => story.length));
      const seen = new Set<string>();
      pictures = Array.from({ length: depth }, (_, image) => shuffledStories.flatMap(story => story[image] || [])).flat()
        .filter(item => {
          if (seen.has(item.image.src)) return false;
          seen.add(item.image.src);
          return true;
        });
      ordered.set(issue.id, pictures);
    }
    if (pictures.length) sawPicture = true;
    const picture = pictures[position[1]];
    if (!picture) {
      position[0] += 1;
      position[1] = 0;
      continue;
    }
    position[1] += 1;
    const hash = createHash('sha256').update(picture.image.src).digest('hex').slice(0, 24);
    if (state.recent.includes(hash)) continue;
    items.push(picture);
    emittedInRound += 1;
    state.recent.push(hash);
    if (state.recent.length > RECENT_STREAM_IMAGES) state.recent.shift();
  }
  return { items, nextCursor: Buffer.from(JSON.stringify(state)).toString('base64url') };
}
