import { Capacitor, registerPlugin } from '@capacitor/core';
import { FILE_IMPORT_BATCH_SIZE, FILE_IMPORT_TIMEOUT_MS, type ImportedFileBatch } from '../userFileImport';
import { documentMaxBytes, documentSizeError } from '../documentLimits';
import type { DictionaryImportOptions, DictionaryImportSnapshot } from '../dictionarySettingsClient';
import type { LibraryDownloadProgress } from '../contentLibrary';

export interface NativePickedFile {
  handle: string;
  name: string;
  mimeType?: string;
  bytes: number;
  sha256: string;
  /** Durable desktop-compatible resource identity; the temporary picker URI is never returned. */
  url?: string;
  path?: string;
}
export interface NativeFilesPlugin {
  addListener(name: 'libraryDownloadProgress', listener: (event: LibraryDownloadProgress & { requestId: string }) => void): Promise<{ remove(): Promise<void> }>;
  remoteLibrary(options: { operation: 'catalog' | 'file'; serverUrl: string; requestId: string; sha256?: string; bytes?: number; filename?: string }): Promise<unknown>;
  pickFile(options: { kind: 'document' | 'backup' | 'dictionary' }): Promise<NativePickedFile | { cancelled: true }>;
  readText(options: { handle: string }): Promise<{ text: string }>;
  parseDocument(options: { handle: string; filename: string; offset: number; limit: number; requestId?: string }): Promise<ImportedFileBatch>;
  cancelDocument(options: { requestId: string }): Promise<{ cancelled: true }>;
  releaseFile(options: { handle: string }): Promise<{ released: true }>;
  resolveAsset(options: { url: string }): Promise<{ path: string }>;
  paths(): Promise<{ root: string }>;
  pdfInfo(options: { url: string }): Promise<{ pageCount: number }>;
  renderPdfPage(options: { url: string; page?: number; scale?: number }): Promise<{ path: string; width: number; height: number; pageCount: number }>;
  exportBundle(options: { profileId: string; filename?: string }): Promise<{ saved?: true; cancelled?: true }>;
  exportSnapshot(options: { profileId: string; filename?: string; previous?: boolean }): Promise<{ saved?: true; cancelled?: true }>;
  saveText(options: { text: string; filename: string; mimeType: 'text/csv' }): Promise<{ saved?: true; cancelled?: true }>;
  restoreBundle(options: { handle: string; profileId: string; revision: number }): Promise<{ revision: number; settings: Record<string, string> }>;
  prepareBundle(options: { handle: string }): Promise<import('../localDataBackup').LocalDataBackup>;
  prepareSnapshot(options: { handle: string }): Promise<import('../localDataBackup').LocalDataBackup>;
  restoreSnapshot(options: { handle: string; profileId: string; revision: number }): Promise<{ revision: number; settings: Record<string, string> }>;
  installDictionary(options: { handle: string }): Promise<{ dictionaryId: string; entryCount: number; contentVersion: string }>;
  importMdx(options: { handle: string; filename: string; language: string; name?: string }): Promise<{ dictionaryId: string; name: string; entryCount: number; contentVersion: string; transactionToken?: string }>;
  finishMdxInstall(options: { transactionToken: string; rollback?: boolean }): Promise<{ finished: true }>;
}
export const nativeFiles = registerPlugin<NativeFilesPlugin>('ReadageFiles');
let privateRoot: string | undefined;

export async function initializeNativeFiles(): Promise<void> {
  const result = await nativeFiles.paths();
  if (!result.root?.startsWith('/')) throw new Error('手机私有文件目录无效。');
  privateRoot = result.root.replace(/\/$/, '');
}

export async function pickNativeFile(kind: 'document' | 'backup' | 'dictionary'): Promise<NativePickedFile | null> {
  const file = await nativeFiles.pickFile({ kind });
  if ('cancelled' in file) return null;
  if (!/^[a-f\d]{64}$/.test(file.handle) || !Number.isSafeInteger(file.bytes) || file.bytes <= 0) {
    throw new Error('手机返回的文件信息无效。');
  }
  return file;
}

/** Native bytes stay outside the WebView; only the selected, bounded chapter batch crosses the bridge. */
export async function requestNativeDocumentBatch(file: NativePickedFile, offset: number, options: {
  signal?: AbortSignal; limit?: number; timeoutMs?: number;
  plugin?: Pick<NativeFilesPlugin, 'parseDocument'> & Partial<Pick<NativeFilesPlugin, 'cancelDocument'>>;
} = {}): Promise<ImportedFileBatch> {
  const limit = options.limit ?? FILE_IMPORT_BATCH_SIZE;
  if (!/^[a-f\d]{64}$/.test(file.handle) || file.sha256 !== file.handle || !Number.isSafeInteger(file.bytes) || file.bytes < 1) throw new Error('手机返回的文件信息无效。');
  if (file.bytes > documentMaxBytes(file.name)) throw new Error(documentSizeError(file.name));
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > FILE_IMPORT_BATCH_SIZE) throw new Error('请输入有效的章节起点。');
  options.signal?.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const requestId = crypto.randomUUID(), plugin = options.plugin ?? nativeFiles;
  const cancel = () => { void plugin.cancelDocument?.({ requestId }).catch(() => undefined); };
  try {
    const batch = await new Promise<ImportedFileBatch>((resolve, reject) => {
      abort = () => { cancel(); reject(options.signal?.reason ?? new DOMException('文件准备已取消。', 'AbortError')); };
      options.signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => { cancel(); reject(new Error('文件准备超时，请重试或选择较小的文件。')); }, options.timeoutMs ?? FILE_IMPORT_TIMEOUT_MS);
      plugin.parseDocument({ handle: file.handle, filename: file.name, offset, limit, requestId }).then(resolve, reject);
    });
    options.signal?.throwIfAborted();
    const end = offset + (Array.isArray(batch?.articles) ? batch.articles.length : 0);
    let textSize = 0;
    if (batch?.sourceId !== file.handle || !['epub', 'pdf', 'docx', 'html', 'text'].includes(batch?.format)
      || batch.offset !== offset || !Number.isSafeInteger(batch.totalCount) || batch.totalCount < end
      || !batch.articles?.length || batch.articles.length > limit || batch.nextOffset !== (end < batch.totalCount ? end : null)
      || batch.articles.some((article, index) => {
        if (!article || !Array.isArray(article.paragraphs) || article.paragraphs.some(text => {
          if (typeof text !== 'string') return true; textSize += text.length; return false;
        }) || textSize > 64 * 1024 * 1024) return true;
        const source = article.sourceDocument;
        if (source && (batch.format !== 'pdf' || source.format !== 'pdf' || source.src !== `/api/import/documents/${file.handle}.pdf`
          || source.pageNumber !== offset + index + 1 || source.pageCount !== batch.totalCount)) return true;
        if (!article.paragraphs.some(text => text.trim()) && !source) return true;
        return article.media !== undefined && (!Array.isArray(article.media) || article.media.length > 256 || article.media.some(image =>
          !image || !/^\/api\/import\/images\/[a-f\d]{64}\.(png|jpg|gif|webp)$/.test(image.src)
          || !Number.isInteger(image.afterParagraphIndex) || image.afterParagraphIndex < -1 || image.afterParagraphIndex >= article.paragraphs.length));
      })) throw new Error('没有收到完整的章节、页或插图，请重新准备文件。');
    return batch;
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) options.signal?.removeEventListener('abort', abort);
  }
}

/** Resolve only presentation URLs; keep the original /api/ identity in the SQLite archive. */
export function nativeAssetUrl(url: string): string {
  if (!Capacitor.isNativePlatform() || !privateRoot) return url;
  const pdf = /^\/api\/import\/documents\/([a-f\d]{64}\.pdf)$/.exec(url);
  const image = /^\/api\/(import\/images|magazines\/assets)\/([a-f\d]{64}\.(?:png|jpg|gif|webp))$/.exec(url);
  if (pdf) return Capacitor.convertFileSrc(`${privateRoot}/documents/${pdf[1]}`);
  if (image) return Capacitor.convertFileSrc(`${privateRoot}/${image[1] === 'import/images' ? 'document_images' : 'assets'}/${image[2]}`);
  return url;
}

export async function resolveNativeAsset(url: string): Promise<string> {
  return Capacitor.convertFileSrc((await nativeFiles.resolveAsset({ url })).path);
}

export async function installNativeDictionary(): Promise<{ dictionaryId: string; entryCount: number; contentVersion: string } | null> {
  const file = await pickNativeFile('dictionary');
  if (!file) return null;
  try { return await nativeFiles.installDictionary({ handle: file.handle }); }
  finally { await nativeFiles.releaseFile({ handle: file.handle }).catch(() => undefined); }
}

/** The explicit preview/import flow mirrors Node and rolls a new MDX source back if settings fail. */
export async function importNativeDictionary(file: NativePickedFile, options: DictionaryImportOptions = {}): Promise<DictionaryImportSnapshot> {
  options.signal?.throwIfAborted();
  const { dictionarySettingsClient } = await import('../dictionarySettingsClient');
  const { clearNativeDictionaryIdentityCache } = await import('./nativeDictionary');
  const mdx = /\.mdx$/i.test(file.name);
  const installed = mdx ? await nativeFiles.importMdx({ handle: file.handle, filename: file.name,
    language: Intl.getCanonicalLocales(options.language?.trim() || 'en')[0], ...(options.name?.trim() ? { name: options.name.trim() } : {}) })
    : await nativeFiles.installDictionary({ handle: file.handle });
  const token = 'transactionToken' in installed && typeof installed.transactionToken === 'string' ? installed.transactionToken : undefined;
  let committed = false;
  try {
    options.signal?.throwIfAborted(); clearNativeDictionaryIdentityCache();
    let snapshot = await dictionarySettingsClient.load(options.signal);
    if (mdx && token && !snapshot.settings.enabledSources.includes(installed.dictionaryId)) {
      snapshot = await dictionarySettingsClient.save({ ...snapshot.settings,
        enabledSources: [...snapshot.settings.enabledSources, installed.dictionaryId], expectedRevision: snapshot.settings.revision }, options.signal);
    }
    committed = true;
    if (token) await nativeFiles.finishMdxInstall({ transactionToken: token });
    return { settings: snapshot.settings, catalog: snapshot.catalog, imported: { dictionaryId: installed.dictionaryId,
      name: 'name' in installed && typeof installed.name === 'string' ? installed.name : snapshot.catalog.sources.find(source => source.id === installed.dictionaryId)?.name || installed.dictionaryId,
      entryCount: installed.entryCount }, ...(mdx ? { importWarning: 'MDX 已导入；独立 MDD 资源、外部样式和脚本暂不加载。' } : {}) };
  } catch (error) {
    if (token && !committed) await nativeFiles.finishMdxInstall({ transactionToken: token, rollback: true });
    throw error;
  }
}
