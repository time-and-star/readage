/**
 * React provider for Memory V2: boots finalization once, refreshes on day
 * change / focus / visibility, and exposes a shared store to hooks.
 */

import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from 'react';
import { installExtensionBridge } from '../browserExtension/appBridge';
import {
  getDefaultMemoryStore,
  MemoryV2Store,
  type MemoryStoreOptions,
} from './memoryStore';

const MemoryStoreContext = createContext<MemoryV2Store | null>(null);

export interface MemoryProviderProps {
  children: ReactNode;
  /** Optional store injection for tests. */
  store?: MemoryV2Store;
  /** Used only when `store` is omitted and the default is not yet created. */
  storeOptions?: MemoryStoreOptions;
}

export function MemoryProvider({
  children,
  store: injectedStore,
  storeOptions,
}: MemoryProviderProps) {
  const store = useMemo(
    () => injectedStore ?? getDefaultMemoryStore(storeOptions),
    [injectedStore, storeOptions]
  );

  useEffect(() => {
    const removeExtensionBridge = installExtensionBridge(store);
    void store.start().catch((error) => {
      console.error('MemoryProvider start failed:', error);
    });

    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      void store.checkDayBoundary().catch((error) => {
        console.error('Memory day-boundary check failed:', error);
      });
    };
    const onFocus = () => {
      void store.checkDayBoundary().catch((error) => {
        console.error('Memory day-boundary check failed:', error);
      });
    };

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onFocus);
    store.scheduleMidnightCheck();

    return () => {
      removeExtensionBridge();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onFocus);
    };
  }, [store]);

  return (
    <MemoryStoreContext.Provider value={store}>
      {children}
    </MemoryStoreContext.Provider>
  );
}

/** Resolve the active store: Provider context, else the process default. */
export function useMemoryStore(): MemoryV2Store {
  const ctx = useContext(MemoryStoreContext);
  return ctx ?? getDefaultMemoryStore();
}
