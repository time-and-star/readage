import { Capacitor, registerPlugin } from '@capacitor/core';
import { configureLocalDatabaseTransport } from './localDatabaseTransport';
import { createNativeDatabaseTransport, type NativeDatabasePlugin } from './nativeDatabase';
import { initializeNativeFiles } from './nativeFiles';
import { createNativeDictionaryFetcher } from './nativeDictionary';
import { createNativeAppFetch } from './nativeFetch';
import { initializeNativeResources } from './nativeResources';
import { nativeTranslationFetch } from './nativeTranslation';
import { nativeMagazineFetch } from './nativeMagazines';
import { installAndroidWebViewCompatibility } from './androidCompatibility';

let initialized: Promise<void> | undefined;
export function initializeAndroidPlatform(): Promise<void> {
  if (initialized) return initialized;
  initialized = (async () => {
    await installAndroidWebViewCompatibility();
    if (Capacitor.getPlatform() !== 'android' || !Capacitor.isPluginAvailable('ReadageDatabase')) {
      throw new Error('请使用 Android 安装包打开应用，手机本机数据库尚未接入。');
    }
    configureLocalDatabaseTransport(createNativeDatabaseTransport(registerPlugin<NativeDatabasePlugin>('ReadageDatabase')));
    await initializeNativeResources();
    await initializeNativeFiles();
    globalThis.fetch = createNativeAppFetch({ origin: window.location.origin,
      localFetch: globalThis.fetch.bind(globalThis), dictionaryFetch: createNativeDictionaryFetcher(),
      translationFetch: nativeTranslationFetch, magazineFetch: nativeMagazineFetch });
    document.documentElement.dataset.platform = 'android';
  })();
  // Leave the same adapter installed on retry, even if resource initialization failed.
  initialized.catch(() => { initialized = undefined; });
  return initialized;
}
