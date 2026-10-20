import { getApiAuthHeaders } from './apiAuth';
import { IS_ANDROID } from './platform/runtime';
import { nativeFiles, type NativeFilesPlugin, type NativePickedFile } from './platform/nativeFiles';
import { libraryOrigin, validateLibraryCatalog, type LibraryCatalog, type LibraryItem } from './contentLibraryProtocol';
export type { LibraryCatalog, LibraryItem } from './contentLibraryProtocol';
export interface LibraryDownloadProgress {
  phase: 'connecting' | 'downloading' | 'verifying' | 'downloaded';
  receivedBytes: number;
  totalBytes: number;
}
export type LibraryProgressListener = (progress: LibraryDownloadProgress) => void;

async function localRequest(operation: string, body: object, signal: AbortSignal) {
  const response = await fetch(`/api/library/${operation}`, { method: 'POST', headers: { ...getApiAuthHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  if (!response.ok) { const data = await response.json().catch(() => null); throw new Error(data?.error?.message || '无法连接资料服务器。'); }
  return response;
}
/** Native requests use an explicit bridge instead of weakening the WebView fetch boundary. */
export async function requestNativeLibrary<T>(operation: 'catalog' | 'file', serverUrl: string, item: LibraryItem | undefined, signal: AbortSignal,
  onProgress?: LibraryProgressListener, plugin: Pick<NativeFilesPlugin, 'remoteLibrary' | 'cancelDocument' | 'addListener'> = nativeFiles): Promise<T> {
  const requestId = crypto.randomUUID();
  const cancel = () => { void plugin.cancelDocument({ requestId }).catch(() => {}); };
  let rejectAbort: (reason: unknown) => void = () => {};
  const cancelled = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const abort = () => { cancel(); rejectAbort(signal.reason); };
  signal.addEventListener('abort', abort, { once: true });
  let listener: { remove(): Promise<void> } | undefined;
  let listenerRemoved = false;
  const removeListener = async (value: { remove(): Promise<void> }) => { if (!listenerRemoved) { listenerRemoved = true; await value.remove().catch(() => {}); } };
  try {
    signal.throwIfAborted();
    if (onProgress && item) {
      let pendingListener: Promise<{ remove(): Promise<void> } | undefined>;
      try {
        pendingListener = plugin.addListener('libraryDownloadProgress', event => {
          if (event.requestId !== requestId || signal.aborted || !['connecting', 'downloading', 'verifying'].includes(event.phase)
            || !Number.isSafeInteger(event.receivedBytes) || event.receivedBytes < 0 || event.receivedBytes > item.bytes || event.totalBytes !== item.bytes) return;
          onProgress({ phase: event.phase, receivedBytes: event.receivedBytes, totalBytes: item.bytes });
        });
      } catch { pendingListener = Promise.resolve(undefined); }
      // A late listener registration must also be removed when cancellation wins.
      pendingListener.then(value => { if (value && signal.aborted) void removeListener(value); }, () => {});
      listener = await Promise.race([pendingListener.catch(() => undefined), cancelled]);
    }
    signal.throwIfAborted();
    const result = await Promise.race([plugin.remoteLibrary({ operation, serverUrl, requestId, ...(item ? { sha256: item.sha256, bytes: item.bytes, filename: item.filename } : {}) }) as Promise<T>, cancelled]);
    signal.throwIfAborted(); return result;
  } finally { signal.removeEventListener('abort', abort); if (listener) await removeListener(listener); }
}
export async function loadLibraryCatalog(serverUrl: string, signal: AbortSignal): Promise<LibraryCatalog> {
  const origin = libraryOrigin(serverUrl);
  const data = IS_ANDROID ? await requestNativeLibrary('catalog', origin, undefined, signal) : await (await localRequest('catalog', { serverUrl: origin }, signal)).json();
  return validateLibraryCatalog(data);
}
export async function downloadLibraryFile(serverUrl: string, item: LibraryItem, signal: AbortSignal, onProgress?: LibraryProgressListener): Promise<{ file: File; picked?: NativePickedFile }> {
  const origin = libraryOrigin(serverUrl);
  signal.throwIfAborted();
  onProgress?.({ phase: 'connecting', receivedBytes: 0, totalBytes: item.bytes });
  if (IS_ANDROID) {
    const picked = await requestNativeLibrary<NativePickedFile>('file', origin, item, signal, onProgress);
    if (picked.sha256 !== item.sha256 || picked.handle !== item.sha256 || picked.bytes !== item.bytes) throw new Error('手机下载校验失败。');
    onProgress?.({ phase: 'downloaded', receivedBytes: item.bytes, totalBytes: item.bytes });
    return { file: new File([], item.filename), picked };
  }
  const requestId = crypto.randomUUID(), polling = new AbortController();
  const pollSignal = AbortSignal.any([signal, polling.signal]);
  let remoteProgress = false;
  const poll = async () => {
    while (!pollSignal.aborted) {
      try {
        const response = await localRequest('progress', { requestId }, pollSignal);
        const progress = await response.json() as LibraryDownloadProgress;
        if (pollSignal.aborted) return;
        if (['connecting', 'downloading', 'verifying'].includes(progress.phase) && Number.isSafeInteger(progress.receivedBytes)
          && progress.receivedBytes >= 0 && progress.receivedBytes <= item.bytes && progress.totalBytes === item.bytes) {
          remoteProgress ||= progress.phase !== 'connecting'; onProgress?.(progress);
        }
      } catch { /* Missing progress never stops the verified file transfer. */ }
      if (pollSignal.aborted) return;
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); pollSignal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, 500); pollSignal.addEventListener('abort', done, { once: true });
      });
    }
  };
  const progressTask = onProgress ? poll() : Promise.resolve();
  try {
    const response = await localRequest('file', { serverUrl: origin, sha256: item.sha256, bytes: item.bytes, requestId }, signal);
    // The proxy verifies the upstream bytes before returning this response.
    polling.abort(); await progressTask;
    const chunks: Uint8Array[] = []; let receivedBytes = 0;
    if (response.body) {
      const reader = response.body.getReader();
      const cancel = () => { void reader.cancel().catch(() => {}); };
      signal.addEventListener('abort', cancel, { once: true });
      try {
        while (true) {
          signal.throwIfAborted(); const { done, value } = await reader.read(); signal.throwIfAborted();
          if (done) break;
          receivedBytes += value.length;
          if (receivedBytes > item.bytes) throw new Error('下载文件大小不一致，请刷新目录后重试。');
          chunks.push(value);
          if (!remoteProgress) onProgress?.({ phase: 'downloading', receivedBytes, totalBytes: item.bytes });
        }
      } finally { signal.removeEventListener('abort', cancel); await reader.cancel().catch(() => {}); reader.releaseLock(); }
    } else {
      const buffer = new Uint8Array(await response.arrayBuffer()); chunks.push(buffer); receivedBytes = buffer.length;
    }
    signal.throwIfAborted();
    if (receivedBytes !== item.bytes) throw new Error('下载未完成，请重试。');
    onProgress?.({ phase: 'downloaded', receivedBytes, totalBytes: item.bytes });
    return { file: new File(chunks, item.filename) };
  } finally { polling.abort(); await progressTask; }
}
