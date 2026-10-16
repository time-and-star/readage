import { Capacitor, registerPlugin } from '@capacitor/core';

interface NativeResourceStatus { ready: boolean; bundleId: string }
interface NativeResourcePlugin { initialize(): Promise<NativeResourceStatus> }
const nativeResources = registerPlugin<NativeResourcePlugin>('ReadageResources');

export async function initializeNativeResources(): Promise<void> {
  if (!Capacitor.isPluginAvailable('ReadageResources')) throw new Error('安装包缺少内置朗读和翻译资源组件，请安装完整版本。');
  const result = await nativeResources.initialize();
  if (!result.ready || !/^[a-f0-9]{64}$/.test(result.bundleId)) throw new Error('内置朗读和翻译资源尚未准备完成，请重试。');
}
