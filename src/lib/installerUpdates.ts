import { IS_ANDROID, IS_DESKTOP } from './platform/runtime';
import { nativeAppUpdates } from './platform/nativeAppUpdates';
import type { UpdateRelease } from '../../website/update-protocol.mjs';

export interface InstallerStatus {
  phase: 'idle' | 'preparing' | 'downloading' | 'waiting' | 'paused' | 'applying' | 'verifying' | 'ready' | 'error';
  version?: string;
  downloadedBytes: number;
  totalBytes: number;
  packageBytes?: number;
  mode?: 'full' | 'delta';
  error?: string;
  fallbackReason?: string;
  release?: UpdateRelease;
  speedBytesPerSecond?: number;
  etaSeconds?: number;
}
export type InstallerAction = 'download' | 'pause' | 'resume' | 'cancel' | 'install';
export interface InstallerIdentity { build: number; sha256: string }
interface InstallerBridge {
  status(): Promise<InstallerStatus>;
  download(version: string, expected?: InstallerIdentity): Promise<InstallerStatus>;
  pause(): Promise<unknown>;
  resume(): Promise<InstallerStatus>;
  cancel(): Promise<void>;
  install(version: string): Promise<void>;
}
declare global { interface Window { readageInstaller?: InstallerBridge } }
function bridge(): InstallerBridge {
  if (IS_ANDROID) return { status: () => nativeAppUpdates.installerStatus(), download: (version, expected) => nativeAppUpdates.downloadInstaller({ version, ...expected }),
    pause: () => nativeAppUpdates.pauseInstaller(), resume: () => nativeAppUpdates.resumeInstaller(),
    cancel: () => nativeAppUpdates.cancelInstaller(), install: version => nativeAppUpdates.installInstaller({ version }) };
  if (IS_DESKTOP && window.readageInstaller) return window.readageInstaller;
  throw new Error('此版本需要更新本机服务。请使用已下载的安装包更新 ReadAge，学习数据会保留。');
}
export const CAN_INSTALL_IN_APP = IS_ANDROID || IS_DESKTOP;
export const installerStatus = () => bridge().status();
export const pauseInstaller = () => bridge().pause();
export const resumeInstaller = () => bridge().resume();
export const cancelInstaller = () => bridge().cancel();
/** Starts a native task. Hiding the UI never aborts that task. */
export async function downloadInstaller(version: string, signal?: AbortSignal, expected?: InstallerIdentity) {
  signal?.throwIfAborted(); const native = bridge();
  const cancel = () => { void native.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try { const result = await native.download(version, expected); signal?.throwIfAborted(); return result; }
  finally { signal?.removeEventListener('abort', cancel); }
}
export async function installInstaller(version: string) {
  const [{ flushPendingPersistentWrites }, { flushLocalDatabaseWrites }] = await Promise.all([import('./storage'), import('./localDatabase')]);
  await flushPendingPersistentWrites(); await flushLocalDatabaseWrites();
  await bridge().install(version);
}
