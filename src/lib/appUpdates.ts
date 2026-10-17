import { getApiAuthHeaders } from './apiAuth';
import { IS_ANDROID, IS_DESKTOP } from './platform/runtime';
import { nativeAppUpdates } from './platform/nativeAppUpdates';
import { patchStatus } from './webPatches';
import { UPDATE_ORIGIN, validateUpdateManifest, type InstalledVersion } from '../../website/update-protocol.mjs';

export const APP_VERSION: InstalledVersion = {
  platform: IS_ANDROID ? 'android' : IS_DESKTOP ? 'windows' : 'web',
  version: typeof __READAGE_APP_VERSION__ === 'string' ? __READAGE_APP_VERSION__ : '0.0.0',
  build: typeof __READAGE_APP_BUILD__ === 'number' ? __READAGE_APP_BUILD__ : 0,
};
export async function installedAppVersion(): Promise<InstalledVersion> {
  const patch = await patchStatus();
  const current = IS_ANDROID ? await nativeAppUpdates.version() : APP_VERSION;
  if (!/^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(current.version) || !Number.isSafeInteger(current.build) || current.build < (IS_ANDROID ? 1 : 0)) throw new Error('无法读取已安装版本。');
  return { ...current, platform: APP_VERSION.platform, shellVersion: patch.shellVersion || current.version,
    ...(patch.enabled ? { version: patch.version || current.version, runtime: patch.runtime, revision: patch.revision || 0, rejectedRevision: patch.rejectedRevision || 0 } : {}) };
}
export async function loadAppUpdates(signal: AbortSignal) {
  signal.throwIfAborted();
  if (!IS_ANDROID) {
    const response = await fetch('/api/app-updates/check', { method: 'POST', headers: getApiAuthHeaders(), signal });
    if (!response.ok) throw new Error('暂时无法连接官网检查更新，请稍后重试。');
    return validateUpdateManifest(await response.json());
  }
  const requestId = crypto.randomUUID();
  let rejectAbort: (reason: unknown) => void = () => {};
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const cancel = () => { void nativeAppUpdates.cancel({ requestId }).catch(() => {}); rejectAbort(signal.reason); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    signal.throwIfAborted();
    return validateUpdateManifest(await Promise.race([nativeAppUpdates.check({ requestId }), aborted]));
  } finally { signal.removeEventListener('abort', cancel); }
}
export async function openAppDownload() {
  if (IS_ANDROID) await nativeAppUpdates.openDownload();
  else {
    const link = document.createElement('a');
    link.href = UPDATE_ORIGIN + '/#download'; link.target = '_blank'; link.rel = 'noopener noreferrer';
    link.click();
  }
}
