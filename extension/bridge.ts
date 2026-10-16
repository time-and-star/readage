import { EXTENSION_CHANNEL } from '../src/lib/browserExtension/protocol';

(() => {
  const scope = globalThis as typeof globalThis & { __readageBridge?: boolean };
  if (scope.__readageBridge || window.top !== window) return;
  scope.__readageBridge = true;
  const pending = new Map<string, { done: (value: unknown) => void; timer: ReturnType<typeof setTimeout> }>();
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || message?.type !== 'IMPORT' || message.origin !== location.origin) return;
    void chrome.runtime.sendMessage({ type: 'BRIDGE_CHECK' }).then(result => {
      if (!result?.ok || result.origin !== location.origin) { respond({ error: '主应用地址已更改。' }); return; }
      const requestId = crypto.randomUUID();
      const timer = setTimeout(() => { pending.delete(requestId); respond({ error: '同步超时，记录已保留，将自动重试。' }); }, 15_000);
      pending.set(requestId, { done: respond, timer });
      window.postMessage({ channel: EXTENSION_CHANNEL, type: 'IMPORT', requestId, events: message.events }, location.origin);
    }).catch(() => respond({ error: '连接已断开。' }));
    return true;
  });
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.channel !== EXTENSION_CHANNEL) return;
    if (event.data.type === 'READY') { void chrome.runtime.sendMessage({ type: 'BRIDGE_READY' }).catch(() => {}); return; }
    if (event.data.type !== 'ACK') return;
    const item = pending.get(event.data.requestId);
    if (!item) return;
    clearTimeout(item.timer); pending.delete(event.data.requestId);
    item.done({ ids: event.data.ids, error: event.data.error });
  });
  void chrome.runtime.sendMessage({ type: 'BRIDGE_READY' }).catch(() => {});
})();
