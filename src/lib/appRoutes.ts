export type AppRoute =
  | { kind: 'landing' }
  | { kind: 'recommendation' }
  | { kind: 'reading'; articleId: string }
  | { kind: 'library' }
  | { kind: 'learning' }
  | { kind: 'history' };

export const APP_HISTORY_STATE_KEY = '__englishAiHistory';

type AppHistoryState = {
  [APP_HISTORY_STATE_KEY]?: {
    index?: unknown;
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

export function withAppHistoryIndex(state: unknown, index: number): Record<string, unknown> {
  const base = state && typeof state === 'object'
    ? { ...(state as Record<string, unknown>) }
    : {};
  base[APP_HISTORY_STATE_KEY] = { index };
  return base;
}

const SIMPLE_ROUTE_PATHS = {
  landing: '/',
  recommendation: '/recommend',
  library: '/library',
  learning: '/learning',
  history: '/history',
} as const;

function normalizePathname(pathname: string): string {
  const path = pathname.trim() || '/';
  if (path === '/') return path;
  return path.replace(/\/+$/, '') || '/';
}

export function parseAppPath(pathname: string): AppRoute {
  const path = normalizePathname(pathname);
  // Retired test links use the learning page; App canonicalizes with replaceState.
  if (path === '/assessment') return { kind: 'learning' };

  for (const [kind, routePath] of Object.entries(SIMPLE_ROUTE_PATHS)) {
    if (path === routePath) return { kind } as AppRoute;
  }

  if (path.startsWith('/read/')) {
    const encodedArticleId = path.slice('/read/'.length);
    if (!encodedArticleId || encodedArticleId.includes('/')) {
      return { kind: 'landing' };
    }

    try {
      const articleId = decodeURIComponent(encodedArticleId);
      return articleId ? { kind: 'reading', articleId } : { kind: 'landing' };
    } catch {
      return { kind: 'landing' };
    }
  }

  return { kind: 'landing' };
}

export function buildAppPath(route: AppRoute): string {
  if (route.kind === 'reading') {
    return `/read/${encodeURIComponent(route.articleId)}`;
  }
  return SIMPLE_ROUTE_PATHS[route.kind];
}

/** The public landing page remains the root route for every visitor. */
export function resolveInitialAppRoute(
  pathname: string
): AppRoute {
  return parseAppPath(pathname);
}
