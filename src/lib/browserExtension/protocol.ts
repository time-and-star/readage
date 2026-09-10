/** Shared, data-only contract between the extension and the learning app. */
export const EXTENSION_CHANNEL = 'readage-extension-v1';
export const DEFAULT_SERVICE_ORIGIN = 'http://localhost:3000';
export const MAX_SYNC_BATCH = 50;

export interface LookupEvent {
  version: 1;
  id: string;
  query: string;
  lemma: string;
  occurredAt: string;
  timezone: string;
  sourceId: string;
}

export function normalizeSelectedWord(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const word = value.trim().replace(/[‘’]/g, "'").toLowerCase();
  return word.length <= 80 && /^[a-z]+(?:['-][a-z]+)*$/.test(word) ? word : null;
}

export function normalizeServiceOrigin(value: string): string {
  const url = new URL(value.trim());
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('请输入 HTTPS 站点地址，或本机 http://localhost:3000，不包含路径。');
  }
  return url.origin;
}

export async function sourcePageId(value: string): Promise<string> {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('此页面不支持查词。');
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url.origin + url.pathname));
  return 'web:' + [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function parseLookupEvent(value: unknown, now = Date.now()): LookupEvent {
  if (!value || typeof value !== 'object') throw new Error('无效的查词记录。');
  const row = value as LookupEvent;
  if (row.version !== 1 || typeof row.id !== 'string'
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(row.id)
    || normalizeSelectedWord(row.query) !== row.query || normalizeSelectedWord(row.lemma) !== row.lemma
    || typeof row.sourceId !== 'string' || !/^web:[a-f0-9]{64}$/.test(row.sourceId)
    || typeof row.occurredAt !== 'string' || !Number.isFinite(Date.parse(row.occurredAt))
    || new Date(row.occurredAt).toISOString() !== row.occurredAt
    || Date.parse(row.occurredAt) < Date.UTC(2020, 0, 1) || Date.parse(row.occurredAt) > now + 300_000
    || typeof row.timezone !== 'string' || row.timezone.length > 100) {
    throw new Error('无效的查词记录。');
  }
  new Intl.DateTimeFormat('en', { timeZone: row.timezone }).format();
  return { version: 1, id: row.id, query: row.query, lemma: row.lemma,
    occurredAt: row.occurredAt, timezone: row.timezone, sourceId: row.sourceId };
}

export function parseLookupBatch(value: unknown): LookupEvent[] {
  if (!Array.isArray(value) || value.length > MAX_SYNC_BATCH) throw new Error('无效的同步批次。');
  return value.map(row => parseLookupEvent(row));
}
