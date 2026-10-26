import type { Article } from '../types';
import { libraryOrigin, type LibraryItem } from './contentLibraryProtocol';
import { fileImportBatchId } from './userFileImport';

export const OFFICIAL_LIBRARY_ORIGIN = 'https://readage.xyz';

export interface LibraryEntry {
  intent: 'import' | 'updates' | 'local';
  /** Explicit official-library navigation, independent of the saved custom server. */
  official?: boolean;
  kind?: 'book' | 'magazine';
  sourceId?: string;
  resourceId?: string;
}
export function resolveLibraryServer(options: { saved?: string; configured?: string; development?: boolean; android?: boolean }): string {
  const fallback = options.development && !options.android ? 'http://127.0.0.1:4175' : OFFICIAL_LIBRARY_ORIGIN;
  const configured = options.configured?.trim() || fallback;
  for (const candidate of [options.saved, configured, fallback]) {
    if (!candidate) continue;
    try {
      const origin = libraryOrigin(candidate);
      if (candidate === options.saved && origin.startsWith('http:') && !options.development && configured.startsWith('https:')) continue;
      if (!options.android || origin.startsWith('https:')) return origin;
    } catch { /* Ignore obsolete developer settings. */ }
  }
  return OFFICIAL_LIBRARY_ORIGIN;
}
export function initialLibraryServer(): string {
  const environment = (import.meta as ImportMeta & { env?: Record<string, string | boolean | undefined> }).env;
  let saved = ''; try { saved = localStorage.getItem('readage.library.server') || ''; } catch { /* Storage may be unavailable. */ }
  return resolveLibraryServer({ saved, configured: String(environment?.VITE_READAGE_LIBRARY_URL || ''), development: environment?.DEV === true, android: environment?.VITE_APP_PLATFORM === 'android' });
}
/** File aliases must use the parser's canonical format to find the saved chapter identities. */
function libraryBatchId(item: Pick<LibraryItem, 'sha256' | 'filename'>): string {
  const extension = item.filename.split('.').pop()?.toLowerCase() || '';
  return fileImportBatchId(item.sha256, ['htm', 'xhtml'].includes(extension) ? 'html' : extension);
}
export function libraryEditionState(item: LibraryItem, history: readonly Article[], serverUrl?: string): 'new' | 'revision' | 'partial' | 'saved' {
  const currentBatch = libraryBatchId(item);
  const same = history.filter(article => (article.language || 'en').split('-')[0] === item.language
    && (article.importBatchId === currentBatch || article.importBatchId === `${currentBatch}-${item.language}`));
  if (same.length) {
    const total = same.find(article => article.distribution?.totalCount)?.distribution?.totalCount;
    return total && new Set(same.map(article => article.id)).size < total ? 'partial' : 'saved';
  }
  return history.some(article => (article.language || 'en').split('-')[0] === item.language
    && (article.importBatchId === `file-${item.sha256}` || article.importBatchId === `file-${item.sha256}-${item.language}`
      || article.distribution?.resourceId === item.id && article.distribution.version !== item.sha256
        && (!serverUrl || (() => { try { return libraryOrigin(article.distribution.serverUrl) === libraryOrigin(serverUrl); } catch { return false; } })()))) ? 'revision' : 'new';
}
export function selectLibraryItems(items: readonly LibraryItem[], history: readonly Article[], entry: LibraryEntry, availableOnly: boolean) {
  return items.filter(item => (!entry.kind || item.kind === entry.kind) && (!entry.sourceId || item.id.startsWith(`${entry.sourceId}:`))
    && (!entry.resourceId || item.id === entry.resourceId) && (!availableOnly || libraryEditionState(item, history) !== 'saved'));
}
/** Resume at the first missing chapter, including imports that began in the middle. */
export function nextLibraryOffset(item: LibraryItem, history: readonly Article[]): number {
  const currentBatch = libraryBatchId(item);
  const indices = new Set(history.filter(article => (article.language || 'en').split('-')[0] === item.language
    && (article.importBatchId === currentBatch || article.importBatchId === `${currentBatch}-${item.language}`))
    .map(article => Number(article.id.match(/-(\d+)$/)?.[1])).filter(Number.isSafeInteger));
  let offset = 0; while (indices.has(offset)) offset++;
  return offset;
}
