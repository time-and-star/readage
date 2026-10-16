import { DICTIONARY_PROTOCOL_VERSION, type SourceCatalog } from '../../packages/dictionary/contracts';
import { getApiAuthHeaders, getJsonApiHeaders } from './apiAuth';

export interface DictionarySettings {
  version: 'dictionary-settings.v1';
  revision: string;
  enabledSources: string[];
  sourceOrder: string[];
  defaultSource: string;
}

export interface DictionarySettingsSnapshot {
  settings: DictionarySettings;
  catalog: SourceCatalog;
  warning?: string;
}

export const MAX_DICTIONARY_IMPORT_BYTES = 256 * 1024 * 1024;
export const MAX_DICTIONARY_PACK_BYTES = 512 * 1024 * 1024;
export interface DictionaryImportSnapshot extends Omit<DictionarySettingsSnapshot, 'warning'> {
  imported: { dictionaryId: string; name: string; entryCount: number };
  importWarning?: string;
}
export interface DictionaryImportOptions { language?: string; name?: string; signal?: AbortSignal }

export function validateDictionaryImportFile(file: Pick<File, 'name' | 'size'>): void {
  if (!/\.(?:mdx|nwdict|pack|zip)$/i.test(file.name)) throw new DictionarySettingsError('请选择 MDX 或离线词典包（.mdx、.nwdict、.pack、.zip）。', 400, 'INVALID_IMPORT_FORMAT');
  if (!file.size) throw new DictionarySettingsError('词典文件为空，请重新选择。', 400, 'EMPTY_IMPORT');
  const max = /\.mdx$/i.test(file.name) ? MAX_DICTIONARY_IMPORT_BYTES : MAX_DICTIONARY_PACK_BYTES;
  if (file.size > max) throw new DictionarySettingsError(`词典文件超过 ${max / 1024 / 1024} MB，请选择较小的文件。`, 413, 'IMPORT_TOO_LARGE');
}

export type DictionarySettingsUpdate = Pick<DictionarySettings, 'enabledSources' | 'sourceOrder' | 'defaultSource'> & {
  expectedRevision: string;
};

export class DictionarySettingsError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = 'DictionarySettingsError';
  }
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function validateSnapshot(value: unknown): DictionarySettingsSnapshot {
  const body = value as { ok?: boolean; settings?: DictionarySettings; catalog?: SourceCatalog; warning?: unknown } | null;
  const settings = body?.settings;
  if (body?.ok !== true || settings?.version !== 'dictionary-settings.v1' || typeof settings.revision !== 'string'
    || !isStringList(settings.enabledSources) || !isStringList(settings.sourceOrder) || typeof settings.defaultSource !== 'string'
    || body.catalog?.protocolVersion !== DICTIONARY_PROTOCOL_VERSION || !Array.isArray(body.catalog.sources)) {
    throw new DictionarySettingsError('词典设置响应无效，请重试。', 502, 'INVALID_RESPONSE');
  }
  return { settings, catalog: body.catalog, ...(typeof body.warning === 'string' ? { warning: body.warning } : {}) };
}

export function createDictionarySettingsClient(options: { baseUrl?: string; fetcher?: typeof fetch } = {}) {
  const base = `${(options.baseUrl ?? '').replace(/\/$/, '')}/api/dictionary/v1`;
  const endpoint = `${base}/settings`;
  const fetcher = options.fetcher ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  async function readResponse(response: Response, signal?: AbortSignal, importing = false): Promise<unknown> {
    let body: unknown;
    try { body = await response.json(); }
    catch {
      signal?.throwIfAborted();
      throw new DictionarySettingsError(`无法读取词典${importing ? '导入' : '设置'}响应（${response.status}）。`, response.status);
    }
    signal?.throwIfAborted();
    if (!response.ok) {
      const error = (body as { error?: { message?: string; code?: string } })?.error;
      const message = response.status === 409 ? importing ? error?.message ?? '词典已存在或设置发生变化，请重新加载后再试。' : '设置已在其他窗口修改，请重新加载后再保存。'
        : response.status === 401 || response.status === 403 ? '当前无法修改词典设置，请检查访问权限。'
          : response.status === 413 ? error?.message ?? 'MDX 最大支持 256 MB，离线词典包最大支持 512 MB。'
          : error?.message ?? `词典设置请求失败（${response.status}）。`;
      throw new DictionarySettingsError(message, response.status, error?.code);
    }
    return body;
  }
  async function request(signal?: AbortSignal, update?: DictionarySettingsUpdate): Promise<DictionarySettingsSnapshot> {
    signal?.throwIfAborted();
    const response = await fetcher(endpoint, {
      method: update ? 'PUT' : 'GET',
      headers: update ? getJsonApiHeaders() : getApiAuthHeaders(),
      ...(update ? { body: JSON.stringify(update) } : {}),
      ...(update ? { keepalive: true } : {}),
      signal,
      credentials: 'same-origin',
      redirect: 'error',
    });
    return validateSnapshot(await readResponse(response, signal));
  }
  async function importFile(file: File, importOptions: DictionaryImportOptions = {}): Promise<DictionaryImportSnapshot> {
    importOptions.signal?.throwIfAborted();
    validateDictionaryImportFile(file);
    let language: string;
    try { language = Intl.getCanonicalLocales(importOptions.language?.trim() || 'en')[0]; }
    catch { throw new DictionarySettingsError('词条语言无效，请使用 en、ja 等语言标识。', 400, 'INVALID_IMPORT_LANGUAGE'); }
    const name = importOptions.name?.trim();
    if (name && name.length > 128) throw new DictionarySettingsError('词典名称请保持在 128 个字符以内。', 400, 'INVALID_IMPORT_NAME');
    const response = await fetcher(`${base}/import`, { method: 'POST',
      headers: { ...getApiAuthHeaders(), 'Content-Type': 'application/octet-stream',
        'X-Import-Filename': encodeURIComponent(file.name), 'X-Dictionary-Language': language,
        ...(name ? { 'X-Dictionary-Name': encodeURIComponent(name) } : {}) },
      body: file, signal: importOptions.signal, credentials: 'same-origin', redirect: 'error' });
    const body = await readResponse(response, importOptions.signal, true);
    const { warning, ...snapshot } = validateSnapshot(body);
    const imported = (body as { imported?: DictionaryImportSnapshot['imported'] }).imported;
    if (!imported || typeof imported.dictionaryId !== 'string' || typeof imported.name !== 'string'
      || !Number.isSafeInteger(imported.entryCount) || imported.entryCount < 1) {
      throw new DictionarySettingsError('词典导入响应无效，请重新加载查看结果。', 502, 'INVALID_RESPONSE');
    }
    // Import compatibility notices do not mean the persisted settings need repair.
    return { ...snapshot, imported, ...(warning ? { importWarning: warning } : {}) };
  }
  return {
    load: (signal?: AbortSignal) => request(signal),
    save: (update: DictionarySettingsUpdate, signal?: AbortSignal) => request(signal, update),
    importFile,
  };
}

export const dictionarySettingsClient = createDictionarySettingsClient();

export function dictionarySettingsEqual(left: DictionarySettings, right: DictionarySettings): boolean {
  return left.defaultSource === right.defaultSource
    && JSON.stringify(left.enabledSources) === JSON.stringify(right.enabledSources)
    && JSON.stringify(left.sourceOrder) === JSON.stringify(right.sourceOrder);
}

export function setDictionaryEnabled(settings: DictionarySettings, id: string, enabled: boolean): DictionarySettings {
  if (!settings.sourceOrder.includes(id)) return settings;
  const selected = new Set(settings.enabledSources);
  if (enabled) selected.add(id);
  else selected.delete(id);
  if (!selected.size) return settings;
  const enabledSources = settings.sourceOrder.filter(sourceId => selected.has(sourceId));
  return { ...settings, enabledSources,
    defaultSource: selected.has(settings.defaultSource) ? settings.defaultSource : enabledSources[0] };
}

export function moveDictionarySource(settings: DictionarySettings, id: string, direction: -1 | 1): DictionarySettings {
  const index = settings.sourceOrder.indexOf(id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= settings.sourceOrder.length) return settings;
  const sourceOrder = [...settings.sourceOrder];
  [sourceOrder[index], sourceOrder[target]] = [sourceOrder[target], sourceOrder[index]];
  return setDictionarySourceOrder(settings, sourceOrder);
}

/** Accept a complete ordering only; dragging must never remove or duplicate an installed source. */
export function setDictionarySourceOrder(settings: DictionarySettings, sourceOrder: string[]): DictionarySettings {
  if (sourceOrder.length !== settings.sourceOrder.length || new Set(sourceOrder).size !== sourceOrder.length
    || sourceOrder.some(id => !settings.sourceOrder.includes(id))) return settings;
  if (sourceOrder.every((id, index) => id === settings.sourceOrder[index])) return settings;
  const selected = new Set(settings.enabledSources);
  return { ...settings, sourceOrder: [...sourceOrder], enabledSources: sourceOrder.filter(id => selected.has(id)) };
}

export function reorderDictionarySource(settings: DictionarySettings, id: string, targetId: string,
  placement: 'before' | 'after'): DictionarySettings {
  if (id === targetId || !settings.sourceOrder.includes(id) || !settings.sourceOrder.includes(targetId)) return settings;
  const sourceOrder = settings.sourceOrder.filter(sourceId => sourceId !== id);
  const targetIndex = sourceOrder.indexOf(targetId) + (placement === 'after' ? 1 : 0);
  sourceOrder.splice(targetIndex, 0, id);
  return setDictionarySourceOrder(settings, sourceOrder);
}

export function retainDictionaryDraftAfterImport(draft: DictionarySettings, before: DictionarySettings,
  imported: DictionarySettings): DictionarySettings {
  if (dictionarySettingsEqual(draft, before)) return imported;
  const registered = new Set(imported.sourceOrder);
  const sourceOrder = [...draft.sourceOrder.filter(id => registered.has(id)), ...imported.sourceOrder.filter(id => !draft.sourceOrder.includes(id))];
  const oldSources = new Set(before.sourceOrder);
  const enabled = new Set([...draft.enabledSources.filter(id => registered.has(id)), ...imported.enabledSources.filter(id => !oldSources.has(id))]);
  const enabledSources = sourceOrder.filter(id => enabled.has(id));
  return { ...imported, sourceOrder, enabledSources,
    defaultSource: enabled.has(draft.defaultSource) ? draft.defaultSource : imported.defaultSource };
}
