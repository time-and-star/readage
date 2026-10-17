import { documentMaxBytes, EPUB_DOCUMENT_MAX_BYTES } from './documentLimits';
export const LIBRARY_FILE_MAX_BYTES = EPUB_DOCUMENT_MAX_BYTES;
export interface LibraryItem {
  id: string; kind: 'book' | 'magazine'; title: string; filename: string; language: 'en' | 'fr' | 'ja';
  sha256: string; bytes: number; updatedAt: string; downloadPath: string; sourceUrl?: string;
}
export interface LibraryCatalog {
  schemaVersion: 1; updatedAt: string | null;
  sync: { running: boolean; lastAttemptAt: string | null; lastSuccessAt: string | null; error: string | null };
  items: LibraryItem[];
}
/** Explicit user-selected server, fixed paths only; no credentials, queries or redirects. */
export function libraryOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('请输入完整的资料服务器 HTTPS 地址。'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
    || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) {
    throw new Error('请输入服务器 HTTPS 地址，不含路径。电脑本地检测可用 http://127.0.0.1:4175。');
  }
  return url.origin;
}
export function validateLibraryCatalog(value: unknown): LibraryCatalog {
  const data = value as LibraryCatalog;
  const dateOrNull = (value: unknown) => value === null || (typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)));
  if (!data || data.schemaVersion !== 1 || !Array.isArray(data.items) || data.items.length > 2000 || !data.sync
    || typeof data.sync.running !== 'boolean' || !dateOrNull(data.updatedAt)
    || !dateOrNull(data.sync.lastAttemptAt) || !dateOrNull(data.sync.lastSuccessAt)
    || !(data.sync.error === null || (typeof data.sync.error === 'string' && data.sync.error.length <= 3000))
    || data.items.some(item => !item || typeof item.id !== 'string' || item.id.length > 200
      || !['book', 'magazine'].includes(item.kind) || !['en', 'fr', 'ja'].includes(item.language)
      || typeof item.title !== 'string' || !item.title.trim() || item.title.length > 240
      || typeof item.filename !== 'string' || /[\\/\x00-\x1f]/.test(item.filename) || item.filename.length > 180
      || !/\.(epub|pdf|docx|html?|xhtml|txt|md|text)$/i.test(item.filename)
      || !/^[a-f0-9]{64}$/.test(item.sha256) || item.downloadPath !== `/api/library/files/${item.sha256}`
      || !Number.isSafeInteger(item.bytes) || item.bytes < 1 || item.bytes > documentMaxBytes(item.filename)
      || !Number.isFinite(Date.parse(item.updatedAt)))
    || new Set(data.items.map(item => item.id)).size !== data.items.length) throw new Error('服务器资料目录不完整或格式不支持。');
  return data;
}
