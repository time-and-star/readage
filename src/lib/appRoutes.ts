export type AppRoute =
  | { kind: 'recommendation' }
  | { kind: 'flashcards' }
  | { kind: 'reading'; articleId: string }
  | { kind: 'library' }
  | { kind: 'learning' }
  | { kind: 'dictionary-settings' }
  | { kind: 'dictionary-trial'; language?: 'fr' | 'ja' }
  | { kind: 'learning-records'; articleId?: string };

export const APP_HISTORY_STATE_KEY = '__englishAiHistory';

type AppHistoryState = {
  [APP_HISTORY_STATE_KEY]?: {
    index?: unknown;
    previousPath?: unknown;
  };
};

export function readAppHistoryIndex(state: unknown): number | null {
  if (!state || typeof state !== 'object') return null;
  const marker = (state as AppHistoryState)[APP_HISTORY_STATE_KEY];
  if (!marker || typeof marker !== 'object') return null;
  return typeof marker.index === 'number'
    && Number.isInteger(marker.index)
    && marker.index >= 0
    ? marker.index
    : null;
}

export function readAppHistoryPreviousPath(state: unknown): string | null {
  if (!state || typeof state !== 'object') return null;
  const path = (state as AppHistoryState)[APP_HISTORY_STATE_KEY]?.previousPath;
  return typeof path === 'string' && path.startsWith('/') ? path : null;
}

export function withAppHistoryIndex(state: unknown, index: number, previousPath?: string): Record<string, unknown> {
  const base = state && typeof state === 'object'
    ? { ...(state as Record<string, unknown>) }
    : {};
  const parent = previousPath ?? readAppHistoryPreviousPath(state);
  base[APP_HISTORY_STATE_KEY] = { index, ...(parent ? { previousPath: parent } : {}) };
  return base;
}

const SIMPLE_ROUTE_PATHS = {
  recommendation: '/recommend',
  flashcards: '/learning/flashcards',
  library: '/library',
  learning: '/learning',
  'dictionary-settings': '/settings/dictionaries',
  'dictionary-trial': '/settings/dictionaries/try/fr',
} as const;

function normalizePathname(pathname: string): string {
  const path = pathname.trim() || '/';
  if (path === '/') return path;
  return path.replace(/\/+$/, '') || '/';
}

export function parseAppPath(pathname: string): AppRoute {
  const path = normalizePathname(pathname);
  if (path === '/') return { kind: 'library' };
  // Retired test links use the learning page; App canonicalizes with replaceState.
  if (path === '/assessment') return { kind: 'learning' };
  // Keep word-card bookmarks while moving their canonical location into Learning.
  if (path === '/flashcards') return { kind: 'flashcards' };
  // Reading records now live under Learning; preserve saved history links.
  if (path === '/history') return { kind: 'learning-records' };
  if (path === '/learning/articles') return { kind: 'learning-records' };
  if (path === '/settings/dictionaries/try/ja') return { kind: 'dictionary-trial', language: 'ja' };
  if (path.startsWith('/learning/articles/')) {
    const encodedId = path.slice('/learning/articles/'.length);
    if (!encodedId || encodedId.includes('/')) return { kind: 'learning' };
    try {
      const articleId = decodeURIComponent(encodedId);
      return articleId ? { kind: 'learning-records', articleId } : { kind: 'learning' };
    } catch { return { kind: 'learning' }; }
  }

  for (const [kind, routePath] of Object.entries(SIMPLE_ROUTE_PATHS)) {
    if (path === routePath) return { kind } as AppRoute;
  }

  if (path.startsWith('/read/')) {
    const encodedArticleId = path.slice('/read/'.length);
    if (!encodedArticleId || encodedArticleId.includes('/')) {
      return { kind: 'library' };
    }

    try {
      const articleId = decodeURIComponent(encodedArticleId);
      return articleId ? { kind: 'reading', articleId } : { kind: 'library' };
    } catch {
      return { kind: 'library' };
    }
  }

  return { kind: 'library' };
}

export function buildAppPath(route: AppRoute): string {
  if (route.kind === 'dictionary-trial') {
    return `/settings/dictionaries/try/${route.language ?? 'fr'}`;
  }
  if (route.kind === 'learning-records') {
    return route.articleId ? `/learning/articles/${encodeURIComponent(route.articleId)}` : '/learning/articles';
  }
  if (route.kind === 'reading') {
    return `/read/${encodeURIComponent(route.articleId)}`;
  }
  return SIMPLE_ROUTE_PATHS[route.kind];
}

/** Root and retired welcome links open the library immediately. */
export function resolveInitialAppRoute(
  pathname: string
): AppRoute {
  return parseAppPath(pathname);
}
