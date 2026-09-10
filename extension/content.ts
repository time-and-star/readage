import { normalizeSelectedWord } from '../src/lib/browserExtension/protocol';
import { toDictionaryWordCard, type DictionaryEntry } from '../src/lib/dictionaryClient';

(() => {
  const scope = globalThis as typeof globalThis & { __readageContent?: boolean };
  if (scope.__readageContent || window.top !== window || document.contentType !== 'text/html') return;
  scope.__readageContent = true;
  let host: HTMLElement | null = null;
  let revision = 0;
  let open = false;
  let activeLookupId: string | null = null;
  let recordStatus: HTMLElement | null = null;
  let synchronized = false;
  const close = () => { revision++; host?.remove(); host = null; open = false; activeLookupId = null; recordStatus = null; synchronized = false; };
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender.id !== chrome.runtime.id || message?.type !== 'LOOKUP_SYNCED' || message.lookupId !== activeLookupId) return;
    synchronized = true;
    if (recordStatus) recordStatus.textContent = '已同步到熟练度系统';
  });
  const isEditable = (node: Node | null) => {
    const element = node instanceof Element ? node : node?.parentElement;
    return Boolean(element?.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]'));
  };
  document.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
  document.addEventListener('pointerdown', event => { if (host && !event.composedPath().includes(host)) close(); }, true);
  document.addEventListener('selectionchange', () => { if (!open && !window.getSelection()?.toString()) close(); });
  document.addEventListener('pointerup', event => {
    if (host && event.composedPath().includes(host)) return;
    void showSelection();
  });
  document.addEventListener('keyup', event => { if (event.key.startsWith('Arrow') && event.shiftKey) void showSelection(); });

  async function showSelection() {
    const selection = window.getSelection();
    const word = normalizeSelectedWord(selection?.toString());
    if (!word || !selection?.rangeCount || isEditable(selection.anchorNode) || isEditable(selection.focusNode)) return;
    const range = selection.getRangeAt(0);
    if (range.commonAncestorContainer.parentElement?.closest('iframe')) return;
    const rect = range.getBoundingClientRect();
    close();
    const version = revision;
    const permission = await chrome.runtime.sendMessage({ type: 'CONTENT_CHECK' }).catch(() => null);
    if (!permission?.ok || revision !== version) return;
    host = document.createElement('div');
    host.dataset.readageRoot = '';
    host.style.cssText = 'all:initial!important;position:fixed!important;z-index:2147483647!important;display:block!important;';
    host.style.setProperty('left', `${Math.max(8, Math.min(rect.left, innerWidth - 340))}px`, 'important');
    host.style.setProperty('top', `${Math.max(8, Math.min(rect.bottom + 8, innerHeight - 220))}px`, 'important');
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = ':host{color-scheme:light}*{box-sizing:border-box}button{font:600 13px system-ui;cursor:pointer;border:1px solid #cfc5b4;border-radius:9px;padding:8px 12px;background:#fffdf7;color:#363b2d}button:focus-visible{outline:3px solid #778764}button:disabled{cursor:wait;opacity:.7}.card{font:14px/1.6 system-ui;color:#353c2c;background:#fffdf7;border:1px solid #d5cebf;border-radius:14px;box-shadow:0 8px 32px #0002;width:min(320px,calc(100vw - 16px));max-height:70vh;overflow:auto;padding:18px;overflow-wrap:anywhere}.head{display:flex;align-items:center;justify-content:space-between;gap:12px}h2{font-size:22px;margin:0}p{margin:8px 0}small{color:#727767}';
    shadow.append(style);
    const trigger = document.createElement('button'); trigger.textContent = '查词'; trigger.setAttribute('aria-label', `查询 ${word}`);
    shadow.append(trigger); document.documentElement.append(host);
    const lookupId = crypto.randomUUID();
    let requested = false;
    trigger.addEventListener('click', async () => {
      if (requested) return;
      requested = true; open = true; trigger.disabled = true; trigger.textContent = '查询中…';
      activeLookupId = lookupId;
      try {
        const result = await chrome.runtime.sendMessage({ type: 'LOOKUP', word, lookupId });
        if (revision !== version || !host) return;
        const card = document.createElement('section'); card.className = 'card'; card.setAttribute('role', 'dialog'); card.setAttribute('aria-label', `${word} 的释义`);
        const head = document.createElement('div'); head.className = 'head';
        const title = document.createElement('h2'); title.textContent = result.entry?.lemma || word;
        const dismiss = document.createElement('button'); dismiss.textContent = '×'; dismiss.setAttribute('aria-label', '关闭释义'); dismiss.onclick = close;
        head.append(title, dismiss); card.append(head);
        const add = (text: string, tag = 'p') => { const element = document.createElement(tag); element.textContent = text; card.append(element); return element; };
        if (!result.ok) add(result.error || '查询失败，请稍后重试。');
        else if (!result.entry) add('没有找到这个单词。未生成学习记录。');
        else {
          const entry: DictionaryEntry = result.entry;
          const model = toDictionaryWordCard(entry);
          add([model.phonetic, model.type].filter(Boolean).join(' · '), 'small');
          add(model.chineseTranslation || ''); add(model.definition);
          recordStatus = add(synchronized ? '已同步到熟练度系统' : result.status || '已保存，等待同步', 'small');
          recordStatus.setAttribute('role', 'status');
        }
        trigger.replaceWith(card); dismiss.focus({ preventScroll: true });
      } catch {
        if (revision !== version) return;
        trigger.disabled = false; trigger.textContent = '连接失败，请重新选词';
      }
    });
  }
})();
