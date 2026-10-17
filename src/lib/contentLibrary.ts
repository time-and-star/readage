import { getApiAuthHeaders } from './apiAuth';
import { IS_ANDROID } from './platform/runtime';
import { nativeFiles, type NativePickedFile } from './platform/nativeFiles';
import { libraryOrigin, validateLibraryCatalog, type LibraryCatalog, type LibraryItem } from './contentLibraryProtocol';
export type { LibraryCatalog, LibraryItem } from './contentLibraryProtocol';

async function localRequest(operation: string, body: object, signal: AbortSignal) {
  const response = await fetch(`/api/library/${operation}`, { method: 'POST', headers: { ...getApiAuthHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  if (!response.ok) { const data = await response.json().catch(() => null); throw new Error(data?.error?.message || '无法连接资料服务器。'); }
  return response;
}
/** Native requests use an explicit bridge instead of weakening the WebView fetch boundary. */
async function nativeRequest<T>(operation: 'catalog' | 'file', serverUrl: string, item: LibraryItem | undefined, signal: AbortSignal): Promise<T> {
  const requestId = crypto.randomUUID();
  const cancel = () => { void nativeFiles.cancelDocument({ requestId }).catch(() => {}); };
  let rejectAbort: (reason: unknown) => void = () => {};
  const cancelled = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const abort = () => { cancel(); rejectAbort(signal.reason); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    return await Promise.race([nativeFiles.remoteLibrary({ operation, serverUrl, requestId, ...(item ? { sha256: item.sha256, bytes: item.bytes, filename: item.filename } : {}) }) as Promise<T>, cancelled]);
  } finally { signal.removeEventListener('abort', abort); }
}
export async function loadLibraryCatalog(serverUrl: string, signal: AbortSignal): Promise<LibraryCatalog> {
  const origin = libraryOrigin(serverUrl);
  const data = IS_ANDROID ? await nativeRequest('catalog', origin, undefined, signal) : await (await localRequest('catalog', { serverUrl: origin }, signal)).json();
  return validateLibraryCatalog(data);
}
export async function downloadLibraryFile(serverUrl: string, item: LibraryItem, signal: AbortSignal): Promise<{ file: File; picked?: NativePickedFile }> {
  const origin = libraryOrigin(serverUrl);
  if (IS_ANDROID) {
    const picked = await nativeRequest<NativePickedFile>('file', origin, item, signal);
    if (picked.sha256 !== item.sha256 || picked.handle !== item.sha256 || picked.bytes !== item.bytes) throw new Error('手机下载校验失败。');
    return { file: new File([], item.filename), picked };
  }
  const response = await localRequest('file', { serverUrl: origin, sha256: item.sha256, bytes: item.bytes }, signal);
  const blob = await response.blob(); signal.throwIfAborted();
  if (blob.size !== item.bytes) throw new Error('下载未完成，请重试。');
  // Server proxy verifies SHA-256; no WebCrypto secure-context dependency on LAN browsers.
  return { file: new File([blob], item.filename) };
}
