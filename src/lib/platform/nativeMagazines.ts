import { registerPlugin } from '@capacitor/core';
import { resolveLearningWordIds } from '../dictionaryClient';
import { shouldTrackMemoryWord } from '../memoryV2/stopWords';
import type { MagazineLemmaIndex } from '../magazineLemmaIndex';

/** Ranking uses the same canonical word identities as reading and vocabulary cards. */
export async function normalizeNativeLemmaIndex(index: MagazineLemmaIndex, resolve = resolveLearningWordIds): Promise<MagazineLemmaIndex> {
  if (!Array.isArray(index.vocab) || !Array.isArray(index.articles)) throw new Error('外刊词汇索引无效。');
  const canonical = await resolve(index.vocab);
  const vocabulary: string[] = [], positions = new Map<string, number>();
  const remap = canonical.map(word => {
    if (!word || !shouldTrackMemoryWord(word)) return -1;
    if (!positions.has(word)) { positions.set(word, vocabulary.length); vocabulary.push(word); }
    return positions.get(word)!;
  });
  return { ...index, vocab: vocabulary, articles: index.articles.map(article => ({ ...article,
    lemmaIndices: [...new Set(article.lemmaIndices.map(position => remap[position]).filter(position => Number.isInteger(position) && position >= 0))] })) };
}

export interface NativeMagazinesPlugin {
  request(options: { route: string; method: string; body?: Record<string, unknown> }): Promise<{ status: number; body: Record<string, unknown> }>;
}
const plugin = registerPlugin<NativeMagazinesPlugin>('ReadageMagazines');

/** Catalog reads stay on disk; only POST /sync asks the native worker to download. */
export function createNativeMagazineFetch(native: NativeMagazinesPlugin = plugin, origin = 'https://localhost'): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const signal = init?.signal ?? request?.signal;
    signal?.throwIfAborted();
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, origin);
    if (url.origin !== origin || url.username || url.password || url.hash || !url.pathname.startsWith('/api/magazines/')) {
      throw new Error('外刊请求无效。');
    }
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
    const sync = method === 'POST' && url.pathname === '/api/magazines/sync';
    if (method !== 'GET' && !sync) return new Response(JSON.stringify({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: '外刊操作不支持此请求方式。' } }), { status: 405, headers: { 'Content-Type': 'application/json' } });
    let body: Record<string, unknown> | undefined;
    if (sync) {
      const raw = init?.body ?? (request ? await request.clone().text() : '{}');
      if (typeof raw !== 'string' || raw.length > 4096) throw new Error('外刊更新参数无效。');
      body = JSON.parse(raw);
      if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error('外刊更新参数无效。');
    }
    signal?.throwIfAborted();
    const result = await native.request({ route: url.pathname + url.search, method, ...(body ? { body } : {}) });
    signal?.throwIfAborted();
    if (!result || !Number.isInteger(result.status) || result.status < 200 || result.status > 599 || !result.body) throw new Error('外刊返回内容无效。');
    if (url.pathname === '/api/magazines/lemma-index' && result.status === 200 && result.body.ok === true) {
      result.body = { ...result.body, index: await normalizeNativeLemmaIndex(result.body.index as MagazineLemmaIndex) };
      signal?.throwIfAborted();
    }
    return new Response(JSON.stringify(result.body), { status: result.status, headers: { 'Content-Type': 'application/json' } });
  };
}
export const nativeMagazineFetch = createNativeMagazineFetch();
