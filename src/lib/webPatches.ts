import { IS_ANDROID } from './platform/runtime';
import { nativeAppUpdates } from './platform/nativeAppUpdates';
import { getJsonApiHeaders } from './apiAuth';

export interface PatchStatus {
  enabled: boolean;
  runtime?: string;
  id?: string;
  revision?: number;
  rejectedRevision?: number;
  version?: string;
  pending?: string;
  pendingRevision?: number;
  shellVersion?: string;
  trial?: boolean;
  phase?: string;
  completed?: number;
  total?: number;
  downloadedBytes?: number;
  reusedBytes?: number;
}
async function request<T>(action: string, value: object = {}, signal?: AbortSignal): Promise<T> {
  const response = await fetch('/api/app-updates/' + action, { method: 'POST', headers: getJsonApiHeaders(), body: JSON.stringify(value), signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || '小更新操作失败，请重试。');
  return data;
}
export async function patchStatus(): Promise<PatchStatus> {
  try { return IS_ANDROID ? await nativeAppUpdates.patchStatus() : await request<PatchStatus>('status', {}, AbortSignal.timeout(5000)); }
  catch { return { enabled: false }; }
}
export async function preparePatch(revision: number, signal: AbortSignal): Promise<PatchStatus> {
  signal.throwIfAborted();
  if (!IS_ANDROID) return request('prepare', { revision }, signal);
  const cancel = () => { void nativeAppUpdates.cancelPatch().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try { return await nativeAppUpdates.preparePatch({ revision }); }
  finally { signal.removeEventListener('abort', cancel); }
}
export async function activatePatch(id: string) {
  // Both transports persist queued learning writes before changing the web generation.
  const [{ flushPendingPersistentWrites }, { flushLocalDatabaseWrites }] = await Promise.all([import('./storage'), import('./localDatabase')]);
  await flushPendingPersistentWrites(); await flushLocalDatabaseWrites();
  if (IS_ANDROID) await nativeAppUpdates.activatePatch({ id });
  else { await request('activate', { id }); window.location.reload(); }
}
export async function patchReady(id: string) {
  if (IS_ANDROID) await nativeAppUpdates.patchReady({ id });
  else await request('ready', { id });
}
