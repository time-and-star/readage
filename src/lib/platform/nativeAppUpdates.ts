import { registerPlugin } from '@capacitor/core';
import type { PatchStatus } from '../webPatches';

export const nativeAppUpdates = registerPlugin<{
  version(): Promise<{ version: string; build: number }>;
  check(options: { requestId: string }): Promise<unknown>;
  cancel(options: { requestId: string }): Promise<void>;
  openDownload(): Promise<void>;
  openWebsite(): Promise<void>;
  installerStatus(): Promise<import('../installerUpdates').InstallerStatus>;
  downloadInstaller(options: { version: string; build?: number; sha256?: string }): Promise<import('../installerUpdates').InstallerStatus>;
  cancelInstaller(): Promise<void>;
  pauseInstaller(): Promise<void>;
  resumeInstaller(): Promise<import('../installerUpdates').InstallerStatus>;
  installInstaller(options: { version: string }): Promise<void>;
  patchStatus(): Promise<PatchStatus>;
  preparePatch(options: { revision: number }): Promise<PatchStatus>;
  cancelPatch(): Promise<void>;
  activatePatch(options: { id: string }): Promise<void>;
  patchReady(options: { id: string }): Promise<void>;
}>('ReadageAppUpdates');
