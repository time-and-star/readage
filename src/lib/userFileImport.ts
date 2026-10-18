import type { Article, ArticleMedia, ArticleSourceDocument } from '../types';
import { getApiAuthHeaders } from './apiAuth';
import { documentMaxBytes, documentSizeError } from './documentLimits';

export const FILE_IMPORT_MAX_BYTES = 64 * 1024 * 1024;
export const FILE_IMPORT_BATCH_SIZE = 80;
export const FILE_IMPORT_PREPARATION_LIMIT = 500;
export const FILE_IMPORT_TIMEOUT_MS = 120_000;

/** A changed chapter map must never reuse the learning identities of an older parse. */
export function fileImportBatchId(sourceId: string, format: string): string {
  return `file-${sourceId}${['epub', 'html', 'docx'].includes(format) ? '-s2' : ''}`;
}

interface ImportedFileArticle {
  title?: string;
  paragraphs: string[];
  media?: ArticleMedia[];
  sourceDocument?: ArticleSourceDocument;
}

export interface ImportedFileBatch {
  format: NonNullable<Article['importBatchFormat']>;
  sourceId: string;
  offset: number;
  totalCount: number;
  nextOffset: number | null;
  articles: ImportedFileArticle[];
}

export interface PreparedFileImport {
  file: File;
  format: ImportedFileBatch['format'];
  sourceId: string;
  startOffset: number;
  totalCount: number;
  nextOffset: number | null;
  articles: Article[];
}

/** The deadline covers upload, parsing and response decoding; cancellation also bounds a stuck transport. */
export async function requestUserFileBatch(file: File, offset: number, options: {
  signal?: AbortSignal;
  limit?: number;
  timeoutMs?: number;
  fetcher?: typeof fetch;
} = {}): Promise<ImportedFileBatch> {
  const limit = options.limit ?? FILE_IMPORT_BATCH_SIZE;
  if (!file.size) throw new Error('文件是空的。');
  if (file.size > documentMaxBytes(file.name)) throw new Error(documentSizeError(file.name));
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > FILE_IMPORT_BATCH_SIZE) {
    throw new Error('请输入有效的章节起点。');
  }
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const timeout = setTimeout(() => controller.abort(new Error('文件准备超时，请重试或选择较小的文件。')), options.timeoutMs ?? FILE_IMPORT_TIMEOUT_MS);
  let rejectAbort: (reason: unknown) => void = () => {};
  const cancelled = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(controller.signal.reason);
  controller.signal.addEventListener('abort', onAbort, { once: true });
  try {
    controller.signal.throwIfAborted();
    const response = await Promise.race([(options.fetcher ?? fetch)(`/api/import/file?offset=${offset}&limit=${limit}`, {
      method: 'POST', headers: { ...getApiAuthHeaders(), 'Content-Type': file.type || 'application/octet-stream',
        'X-Import-Filename': encodeURIComponent(file.name) }, body: file, signal: controller.signal,
    }), cancelled]);
    const data = await Promise.race([response.json(), cancelled]);
    controller.signal.throwIfAborted();
    if (!response.ok || data?.ok !== true) throw new Error(data?.error?.message || '文件准备失败，请重试。');
    const batch = data as ImportedFileBatch;
    const end = offset + (Array.isArray(batch.articles) ? batch.articles.length : 0);
    if (!/^[a-f\d]{64}$/.test(batch.sourceId || '') || !['epub', 'pdf', 'docx', 'html', 'text'].includes(batch.format)
      || batch.offset !== offset || !Number.isSafeInteger(batch.totalCount) || batch.totalCount < end
      || !batch.articles?.length || batch.articles.length > limit
      || batch.nextOffset !== (end < batch.totalCount ? end : null)
      || batch.articles.some(item => !item || !Array.isArray(item.paragraphs)
        || item.paragraphs.some(text => typeof text !== 'string')
        || (!item.paragraphs.some(text => text.trim()) && !item.sourceDocument))) {
      throw new Error('没有收到完整的章节，请重试。');
    }
    return batch;
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (error instanceof SyntaxError) throw new Error('文件解析结果不完整，请重试。');
    if (error instanceof TypeError) throw new Error('无法连接应用，请检查连接后重试。');
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', onAbort);
  }
}

/** A batch can only follow the same unchanged source and exact next chapter. Retries cannot duplicate it. */
export function appendPreparedFileBatch(current: PreparedFileImport | null, file: File, batch: ImportedFileBatch): PreparedFileImport {
  if (current && (current.file !== file || current.sourceId !== batch.sourceId || current.format !== batch.format
    || current.totalCount !== batch.totalCount || current.nextOffset !== batch.offset)) {
    throw new Error('文件或章节顺序已变化，请重新选择文件。已准备的内容仍保留。');
  }
  if ((current?.articles.length ?? 0) + batch.articles.length > FILE_IMPORT_PREPARATION_LIMIT) {
    throw new Error(`本次最多准备 ${FILE_IMPORT_PREPARATION_LIMIT} 篇，请先导入已准备的内容。`);
  }
  const date = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const title = (file.name.split(/[/\\]/).pop() || file.name).replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim().slice(0, 200) || 'Imported file';
  const batchId = fileImportBatchId(batch.sourceId, batch.format);
  const articles = batch.articles.map((item, index): Article => {
    const paragraphs = item.paragraphs.map(text => text.trim()).filter(Boolean);
    return {
      id: `${batchId}-${batch.offset + index}`,
      title: item.title?.trim() || 'Imported article',
      description: paragraphs.length ? `${paragraphs[0].slice(0, 90)}…` : 'PDF 原页', date,
      status: 'In Progress', source: 'user_input', content: paragraphs,
      media: item.media, sourceDocument: item.sourceDocument, keyWords: [],
      importEnrichmentStatus: paragraphs.length ? 'pending' : 'ready',
      importBatchId: batchId, importBatchTitle: title, importBatchFormat: batch.format,
    };
  });
  return { file, format: batch.format, sourceId: batch.sourceId, totalCount: batch.totalCount,
    startOffset: current?.startOffset ?? batch.offset, nextOffset: batch.nextOffset,
    articles: [...(current?.articles ?? []), ...articles] };
}
