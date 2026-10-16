import type { MemoryV2Store } from '../memoryV2/memoryStore';
import { EXTENSION_CHANNEL, parseLookupBatch } from './protocol';

/** The content script exists only on the origin explicitly configured by the user. */
export function installExtensionBridge(store: MemoryV2Store): () => void {
  if (window.top !== window) return () => {};
  const listener = (event: MessageEvent) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (!message || message.channel !== EXTENSION_CHANNEL || message.type !== 'IMPORT'
      || typeof message.requestId !== 'string' || message.requestId.length > 100) return;
    void (async () => {
      try {
        const events = parseLookupBatch(message.events);
        const ids = await store.importExtensionLookups(events);
        window.postMessage({ channel: EXTENSION_CHANNEL, type: 'ACK', requestId: message.requestId, ids }, location.origin);
      } catch (error) {
        window.postMessage({ channel: EXTENSION_CHANNEL, type: 'ACK', requestId: message.requestId,
          error: error instanceof Error ? error.message : '学习记录写入失败。' }, location.origin);
      }
    })();
  };
  window.addEventListener('message', listener);
  const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('readage-memory-changed') : null;
  if (channel) channel.onmessage = () => store.refreshExternalChanges();
  const ready = () => window.postMessage({ channel: EXTENSION_CHANNEL, type: 'READY' }, location.origin);
  const localChanged = () => store.refreshExternalChanges();
  window.addEventListener('readage-local-data-changed', localChanged);
  void store.ensureReady().then(ready).catch(() => {});
  return () => { window.removeEventListener('message', listener); window.removeEventListener('readage-local-data-changed', localChanged); channel?.close(); };
}
