import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DictionaryAdapter, SourceCatalog } from '../../packages/dictionary/contracts';
import { checkAbort } from '../../packages/dictionary/core';
import { inspectMdxFile, MdxDictionaryAdapter, MdxFormatError, mdxHash, MDX_MAX_FILE_BYTES,
  MDX_MAX_ENTRIES, type ImportedMdxManifest } from '../../packages/dictionary/server/mdxAdapter';
import type { DictionarySourceSettings } from './settings';

export { MDX_MAX_FILE_BYTES };
export interface DictionaryImportInput { bytes: Buffer; filename: string; language?: string; name?: string; signal?: AbortSignal }
export interface DictionaryImportResult {
  settings: DictionarySourceSettings;
  catalog: SourceCatalog;
  imported: { dictionaryId: string; name: string; entryCount: number };
  warning?: string;
}
export class DictionaryImportError extends Error {
  constructor(readonly status: 400 | 413 | 503, readonly code: string, message: string) {
    super(message); this.name = 'DictionaryImportError';
  }
}
const MAX_IMPORTS = 32;
const idPattern = /^mdx-[a-f0-9]{64}$/;
const languagePattern = /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/i;

function validManifest(value: unknown, id: string): value is ImportedMdxManifest {
  const manifest = value as ImportedMdxManifest;
  return !!manifest && manifest.format === 'dictionary-mdx-import.v1' && idPattern.test(id) && manifest.dictionaryId === id &&
    manifest.sha256 === id.slice(4) && typeof manifest.name === 'string' && !!manifest.name.trim() && manifest.name.length <= 160 &&
    typeof manifest.language === 'string' && languagePattern.test(manifest.language) &&
    Number.isInteger(manifest.bytes) && manifest.bytes > 0 && manifest.bytes <= MDX_MAX_FILE_BYTES &&
    Number.isInteger(manifest.entryCount) && manifest.entryCount > 0 && manifest.entryCount <= MDX_MAX_ENTRIES &&
    typeof manifest.filename === 'string' && manifest.filename.length <= 255;
}

/** Discover only generated directory IDs and fixed file names; browser file names never become paths. */
export function discoverImportedDictionaries(directory?: string): MdxDictionaryAdapter[] {
  if (!directory || !fs.existsSync(directory)) return [];
  const result: MdxDictionaryAdapter[] = [];
  let folders: fs.Dirent[];
  try { folders = fs.readdirSync(directory, { withFileTypes: true }); }
  catch { console.warn('[dictionary] Imported dictionary directory could not be read.'); return []; }
  for (const folder of folders.filter(item => item.isDirectory() && idPattern.test(item.name)).slice(0, MAX_IMPORTS)) {
    try {
      const file = path.join(directory, folder.name, 'manifest.json');
      if (fs.statSync(file).size > 65536) continue;
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!validManifest(manifest, folder.name)) continue;
      result.push(new MdxDictionaryAdapter({ file: path.join(directory, folder.name, 'dictionary.mdx'), manifest }));
    } catch { /* Invalid manifests are not executable adapters; a valid manifest with a missing pack stays unavailable. */ }
  }
  return result;
}

export function createDictionaryImporter(options: {
  directory: string;
  findSource(id: string): DictionaryAdapter | undefined;
  install(adapter: DictionaryAdapter): Promise<unknown>;
  snapshot(): { settings: DictionarySourceSettings; catalog: SourceCatalog; warning?: string };
}) {
  let queued: Promise<unknown> = Promise.resolve();
  async function importOne(input: DictionaryImportInput): Promise<DictionaryImportResult> {
    checkAbort(input.signal);
    const filename = input.filename?.split(/[\\/]/).pop()?.trim();
    let language = input.language?.trim() || 'en';
    if (!filename || filename.length > 255 || !/\.mdx$/i.test(filename) || /[\x00-\x1f]/.test(filename)) {
      throw new DictionaryImportError(400, 'INVALID_DICTIONARY_FILE', '请选择 .mdx 词典文件。');
    }
    try {
      if (language.length > 64 || !languagePattern.test(language)) throw new Error('Invalid language.');
      language = Intl.getCanonicalLocales(language)[0];
    } catch { throw new DictionaryImportError(400, 'INVALID_DICTIONARY_LANGUAGE', '词典语言标识无效。'); }
    if (input.name !== undefined && (!input.name.trim() || input.name.trim().length > 160 || /[\x00-\x1f]/.test(input.name))) {
      throw new DictionaryImportError(400, 'INVALID_DICTIONARY_NAME', '词典名称须为 1–160 个字符。');
    }
    if (!Buffer.isBuffer(input.bytes) || !input.bytes.length) throw new DictionaryImportError(400, 'EMPTY_DICTIONARY_FILE', '词典文件为空。');
    if (input.bytes.length > MDX_MAX_FILE_BYTES) throw new DictionaryImportError(413, 'DICTIONARY_TOO_LARGE', 'MDX 文件最大支持 256 MB。');
    const sha256 = mdxHash(input.bytes);
    const dictionaryId = `mdx-${sha256}`;
    const installed = options.findSource(dictionaryId);
    if (installed) {
      if (installed.getStatus?.().available === false || installed instanceof MdxDictionaryAdapter && !installed.verifyStoredFile()) {
        throw new DictionaryImportError(503, 'DICTIONARY_ALREADY_INSTALLED_UNAVAILABLE', '已安装的词典文件缺失或损坏，请恢复词典文件后重启服务。');
      }
      if (installed.metadata.languages[0].toLowerCase() !== language.toLowerCase()) {
        throw new DictionaryImportError(400, 'DICTIONARY_LANGUAGE_MISMATCH', `这份词典已以 ${installed.metadata.languages[0]} 安装，请使用相同的语言标识。`);
      }
      return { ...options.snapshot(), imported: { dictionaryId, name: installed.metadata.name,
        entryCount: installed instanceof MdxDictionaryAdapter ? installed.count : 0 } };
    }
    if (options.snapshot().catalog.sources.filter(source => source.id.startsWith('mdx-')).length >= MAX_IMPORTS) {
      throw new DictionaryImportError(400, 'DICTIONARY_IMPORT_LIMIT', '目前最多支持导入 32 部 MDX 词典。');
    }
    const directory = path.resolve(options.directory);
    const staging = path.join(directory, `.import-${randomUUID()}`);
    const destination = path.join(directory, dictionaryId);
    let committed = false;
    let adapter: MdxDictionaryAdapter | undefined;
    async function cleanup(folder: string) {
      if (path.dirname(path.resolve(folder)) !== directory) throw new Error('Unsafe import cleanup target.');
      for (const name of ['dictionary.mdx', 'manifest.json']) await fs.promises.unlink(path.join(folder, name)).catch(() => {});
      await fs.promises.rmdir(folder).catch(() => {});
    }
    try {
      await fs.promises.mkdir(staging, { recursive: true });
      checkAbort(input.signal);
      const file = path.join(staging, 'dictionary.mdx');
      const handle = await fs.promises.open(file, 'wx', 0o600);
      try { await handle.writeFile(input.bytes); await handle.sync(); } finally { await handle.close(); }
      checkAbort(input.signal);
      const inspected = inspectMdxFile(file);
      if (inspected.sha256 !== sha256) throw new MdxFormatError();
      checkAbort(input.signal);
      const manifest: ImportedMdxManifest = { format: 'dictionary-mdx-import.v1', dictionaryId,
        name: (input.name?.trim() || inspected.title || filename.replace(/\.mdx$/i, '')).slice(0, 160), language,
        sha256, bytes: input.bytes.length, entryCount: inspected.entryCount, filename };
      const manifestFile = await fs.promises.open(path.join(staging, 'manifest.json'), 'wx', 0o600);
      try { await manifestFile.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'); await manifestFile.sync(); }
      finally { await manifestFile.close(); }
      checkAbort(input.signal);
      await fs.promises.rename(staging, destination);
      committed = true;
      checkAbort(input.signal);
      adapter = new MdxDictionaryAdapter({ file: path.join(destination, 'dictionary.mdx'), manifest });
      await options.install(adapter);
      return { ...options.snapshot(), imported: { dictionaryId, name: manifest.name, entryCount: manifest.entryCount },
        warning: 'MDX 已导入；独立 MDD 资源、外部样式和脚本暂不加载。' };
    } catch (error) {
      adapter?.dispose();
      if (committed) await cleanup(destination);
      if (input.signal?.aborted) throw input.signal.reason ?? new DOMException('Aborted', 'AbortError');
      if (error instanceof DictionaryImportError) throw error;
      if (error instanceof MdxFormatError) throw new DictionaryImportError(400, 'INVALID_MDX', error.message);
      throw new DictionaryImportError(503, 'DICTIONARY_IMPORT_STORAGE_UNAVAILABLE', '词典无法保存，当前词典配置保持不变。');
    } finally { await cleanup(staging); }
  }
  return {
    import(input: DictionaryImportInput): Promise<DictionaryImportResult> {
      const operation = queued.then(() => importOne(input));
      queued = operation.catch(() => {});
      return operation;
    },
  };
}
