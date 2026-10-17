import { registerPlugin } from '@capacitor/core';
import type { PatchStatus } from '../webPatches';

export const nativeAppUpdates = registerPlugin<{
  version(): Promise<{ version: string; build: number }>;
  check(options: { requestId: string }): Promise<unknown>;
  cancel(options: { requestId: string }): Promise<void>;
  openDownload(): Promise<void>;
  patchStatus(): Promise<PatchStatus>;
  preparePatch(options: { revision: number }): Promise<PatchStatus>;
  cancelPatch(): Promise<void>;
  activatePatch(options: { id: string }): Promise<void>;
  patchReady(options: { id: string }): Promise<void>;
}>('ReadageAppUpdates');
