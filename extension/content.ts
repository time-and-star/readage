import { normalizeSelectedWord } from '../src/lib/browserExtension/protocol';
import { toDictionaryWordCard, type DictionaryEntry } from '../src/lib/dictionaryClient';
import { floatingPosition } from './floatingPosition';
import { createLookupId } from './lookupId';

interface SelectedWord { word: string; range: Range }
interface LookupResponse { ok: boolean; entry?: DictionaryEntry | null; error?: string; status?: string }

(() => {
  const scope = globalThis as typeof globalThis & { __readageContent?: boolean };
  if (scope.__readageContent || window.top !== window || document.contentType !== 'text/html') return;
  scope.__readageContent = true;

  let host: HTMLElement | null = null;
  let shadow: ShadowRoot | null = null;
  let selectionState: SelectedWord | null = null;
  let revision = 0;
  let enabled = true;
  let activeLookupId: string | null = null;
  let recordStatus: HTMLElement | null = null;
  let synchronized = false;
  let resizeObserver: ResizeObserver | null = null;
  let frame = 0;
  let previousFocus: HTMLElement | null = null;
  let focusTrigger = false;

  function close(restoreFocus = false) {
    revision++;
    const hadFocus = document.activeElement === host;
    host?.remove(); host = null; shadow = null; selectionState = null;
    activeLookupId = null; recordStatus = null; synchronized = false;
    resizeObserver?.disconnect(); resizeObserver = null;
    cancelAnimationFrame(frame); frame = 0;
    if (restoreFocus && hadFocus && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    previousFocus = null;
    focusTrigger = false;
  }

  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message?.type === 'SETTINGS_CHANGED' && typeof message.enabled === 'boolean') {
      enabled = message.enabled;
      if (!enabled) close(true);
    } else if (message?.type === 'LOOKUP_SYNCED' && message.lookupId === activeLookupId) {
      synchronized = true;
      if (recordStatus) { recordStatus.textContent = '已同步'; recordStatus.dataset.synced = 'true'; }
    }
  });

  const isEditable = (node: Node | null) => {
    const element = node instanceof Element ? node : node?.parentElement;
    return Boolean(element?.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]'));
  };
  const inPopup = (node: Node | null) => Boolean(node && shadow && node.getRootNode() === shadow);
  const sameSelection = (left: SelectedWord, right: SelectedWord) => left.word === right.word
    && left.range.startContainer === right.range.startContainer && left.range.startOffset === right.range.startOffset
    && left.range.endContainer === right.range.endContainer && left.range.endOffset === right.range.endOffset;
  function readSelection(): SelectedWord | null {
    const selection = window.getSelection();
    const word = normalizeSelectedWord(selection?.toString());
    if (!word || !selection?.rangeCount || isEditable(document.activeElement) || isEditable(selection.anchorNode) || isEditable(selection.focusNode)
      || inPopup(selection.anchorNode) || inPopup(selection.focusNode)) return null;
    return { word, range: selection.getRangeAt(0).cloneRange() };
  }

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && (host || selectionState)) { close(true); event.stopPropagation(); }
  });
  document.addEventListener('pointerdown', event => {
    if (host && !event.composedPath().includes(host)) close();
  }, true);
  document.addEventListener('selectionchange', () => {
    if (!selectionState || (host && document.activeElement === host)
      || inPopup(window.getSelection()?.anchorNode ?? null)) return;
    const selected = readSelection();
    if (!selected || !sameSelection(selectionState, selected)) close();
  });
  document.addEventListener('pointerup', event => {
    if (event.button !== 0 || isEditable(event.target instanceof Node ? event.target : null)
      || (host && event.composedPath().includes(host))) return;
    void showSelection(false);
  });
  document.addEventListener('keyup', event => {
    // Wait for Shift to be released before moving focus, so arrow keys can keep extending the word.
    if (event.key === 'Shift') void showSelection(true);
    else if (event.shiftKey && /^(Arrow|Home$|End$)/.test(event.key)) void showSelection(false);
  });
  const schedulePosition = () => {
    if (!host || frame) return;
    frame = requestAnimationFrame(() => { frame = 0; positionPopup(); });
  };
  window.addEventListener('resize', schedulePosition, { passive: true });
  document.addEventListener('scroll', schedulePosition, { passive: true, capture: true });
  window.visualViewport?.addEventListener('resize', schedulePosition, { passive: true });
  window.visualViewport?.addEventListener('scroll', schedulePosition, { passive: true });

  function positionPopup() {
    if (!host || !selectionState) return;
    const visual = window.visualViewport;
    const viewport = { left: visual?.offsetLeft ?? 0, top: visual?.offsetTop ?? 0,
      width: visual?.width ?? innerWidth, height: visual?.height ?? innerHeight };
    const anchor = selectionState.range.getBoundingClientRect();
    if (anchor.bottom < viewport.top || anchor.top > viewport.top + viewport.height) { close(); return; }
    const bounds = floatingPosition(anchor, { width: 0, height: 0 }, viewport);
    host.style.setProperty('--popup-max-width', `${bounds.maxWidth}px`);
    host.style.setProperty('--popup-max-height', `${Math.min(560, bounds.maxHeight)}px`);
    const position = floatingPosition(anchor, host.getBoundingClientRect(), viewport);
    host.style.setProperty('left', `${position.left}px`, 'important');
    host.style.setProperty('top', `${position.top}px`, 'important');
  }

  async function showSelection(keyboard: boolean) {
    if (!enabled) return;
    const selected = readSelection();
    if (!selected) return;
    if (selectionState && sameSelection(selectionState, selected)) {
      if (keyboard) { focusTrigger = true; shadow?.querySelector<HTMLButtonElement>('.trigger')?.focus({ preventScroll: true }); }
      return;
    }
    const word = selected.word;
    close();
    focusTrigger = keyboard;
    selectionState = selected;
    const version = revision;
    let permission: { ok?: boolean } | null = null;
    try { permission = await chrome.runtime.sendMessage({ type: 'CONTENT_CHECK' }); } catch { /* Reloaded/removed extensions may lose their connection. */ }
    if (revision !== version || !enabled) return;
    if (!permission?.ok) { close(); return; }
    const current = readSelection();
    if (!current || !sameSelection(selected, current)) { close(); return; }

    host = document.createElement('div'); host.dataset.readageRoot = '';
    host.style.cssText = 'all:initial!important;position:fixed!important;z-index:2147483647!important;display:block!important;isolation:isolate!important;';
    shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style'); style.textContent = popupStyles;
    shadow.append(style);
    const trigger = document.createElement('button'); trigger.className = 'trigger';
    trigger.textContent = `查词 · ${selected.word}`; trigger.setAttribute('aria-label', `查询 ${selected.word}`);
    shadow.append(trigger); document.documentElement.append(host);
    resizeObserver = new ResizeObserver(schedulePosition); resizeObserver.observe(host);
    positionPopup();
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (focusTrigger) trigger.focus({ preventScroll: true });

    // Retries share an ID so a response lost after saving cannot count this selection twice.
    const lookupId = createLookupId();
    let requested = false;
    const currentPopup = () => revision === version && Boolean(host) && enabled;
    const startLookup = async () => {
      if (requested || !currentPopup()) return;
      requested = true; activeLookupId = lookupId;
      const loading = makeCard(selected.word);
      const message = textElement('p', '正在查询词典…', 'loading'); message.setAttribute('role', 'status');
      loading.append(message); replaceContent(loading);
      try {
        const result = await chrome.runtime.sendMessage<LookupResponse>({ type: 'LOOKUP', word: selected.word, lookupId });
        if (!currentPopup()) return;
        if (!result?.ok) showFailure(result?.error || '查询失败，请稍后重试。');
        else if (!result.entry) showFailure('没有找到这个单词，未生成学习记录。', true);
        else showEntry(result.entry, result.status);
      } catch {
        if (currentPopup()) showFailure('暂时无法连接词典，请检查主应用服务后重试。');
      } finally { requested = false; }
    };
    trigger.addEventListener('click', () => { void startLookup(); });

    function replaceContent(card: HTMLElement) {
      if (!shadow) return;
      shadow.querySelector('.trigger,.card')?.replaceWith(card);
      positionPopup();
      card.querySelector<HTMLButtonElement>('.dismiss')?.focus({ preventScroll: true });
    }
    function makeCard(word: string): HTMLElement {
      const card = document.createElement('section'); card.className = 'card';
      card.setAttribute('role', 'dialog'); card.setAttribute('aria-label', `${word} 的释义`);
      const head = document.createElement('div'); head.className = 'head';
      const dismiss = document.createElement('button'); dismiss.className = 'dismiss'; dismiss.textContent = '×';
      dismiss.setAttribute('aria-label', '关闭释义'); dismiss.addEventListener('click', () => close(true));
      head.append(textElement('h2', word), dismiss); card.append(head);
      return card;
    }
    function showFailure(message: string, missing = false) {
      const card = makeCard(word);
      const notice = textElement('p', message, 'notice'); notice.setAttribute('role', missing ? 'status' : 'alert');
      const retry = document.createElement('button'); retry.className = 'retry';
      retry.textContent = missing ? '重新查询' : '重试查询'; retry.addEventListener('click', () => { void startLookup(); });
      card.append(notice, retry); replaceContent(card);
    }
    function showEntry(entry: DictionaryEntry, status?: string) {
      const model = toDictionaryWordCard(entry);
      const card = makeCard(model.wordOrPhrase);
      card.classList.add('entry-card');
      const body = document.createElement('div'); body.className = 'entry-body';
      const meta = document.createElement('div'); meta.className = 'meta';
      if (model.phonetic) meta.append(textElement('span', model.phonetic, 'phonetic'));
      if (model.wordOrPhrase !== word) meta.append(textElement('span', `由 ${word} 还原`, 'query'));
      if (meta.childNodes.length) card.append(meta);
      const senses = entry.partOfSpeechGroups?.length
        ? entry.partOfSpeechGroups.flatMap(group => group.senses.map(sense => ({ partOfSpeech: group.partOfSpeech,
          definition: sense.definitionEn, definitionZh: sense.definitionZh })))
        : entry.definitionsEn;
      const definitions = senses.filter(sense => sense.definition.trim() || sense.definitionZh?.trim());
      const meanings = [...new Set(entry.basicMeaningsZh.map(cleanMeaning).filter(Boolean))];
      const moreContent = document.createElement('div'); moreContent.className = 'more-content';
      if (definitions.length) {
        const first = definitions[0];
        const list = document.createElement('ol'); list.className = 'senses primary-sense';
        appendSense(list, { ...first, definitionZh: first.definitionZh || meanings[0] }); body.append(list);
        if (definitions.length > 1) {
          const more = document.createElement('ol'); more.className = 'senses'; more.start = 2;
          let previousPartOfSpeech = first.partOfSpeech;
          definitions.slice(1).forEach(sense => {
            appendSense(more, sense, sense.partOfSpeech !== previousPartOfSpeech);
            previousPartOfSpeech = sense.partOfSpeech;
          });
          moreContent.append(more);
        }
        const visibleMeanings = definitions.map(sense => cleanMeaning(sense.definitionZh ?? ''));
        const extraMeanings = meanings.filter(item => item !== cleanMeaning(first.definitionZh || meanings[0] || '') && !visibleMeanings.includes(item));
        if (extraMeanings.length) moreContent.append(textElement('p', extraMeanings.join('；'), 'meaning'));
      } else {
        const summary = meanings.slice(0, 2).join('；');
        if (entry.partOfSpeech) body.append(textElement('span', entry.partOfSpeech, 'pos'));
        if (summary) body.append(textElement('p', summary, 'meaning'));
        if (model.definition && cleanMeaning(model.definition) !== summary) body.append(textElement('p', model.definition, 'definition'));
        if (meanings.length > 2) moreContent.append(textElement('p', meanings.slice(2).join('；'), 'meaning'));
      }
      model.exampleSentences.forEach(sentence => moreContent.append(textElement('blockquote', sentence, 'example')));
      if (model.exchanges?.length) moreContent.append(textElement('p', model.exchanges.map(form => `${form.label} ${form.value}`).join(' · '), 'forms'));
      if (moreContent.childNodes.length) {
        const details = document.createElement('details');
        details.append(textElement('summary', '更多'), moreContent); body.append(details);
      }
      recordStatus = textElement('p', synchronized ? '已同步' : '已保存', 'record-status');
      recordStatus.dataset.synced = String(synchronized); recordStatus.setAttribute('role', 'status'); card.append(body, recordStatus);
      replaceContent(card);
    }
  }
})();

function textElement<K extends keyof HTMLElementTagNameMap>(tag: K, text: string, className?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag); element.textContent = text;
  if (className) element.className = className;
  return element;
}
function appendSense(list: HTMLOListElement, sense: { partOfSpeech: string; definition: string; definitionZh?: string }, showPartOfSpeech = true) {
  const row = document.createElement('li');
  if (sense.partOfSpeech && showPartOfSpeech) row.append(textElement('span', sense.partOfSpeech, 'pos'));
  if (sense.definitionZh) row.append(textElement('p', cleanMeaning(sense.definitionZh), 'sense-zh'));
  if (sense.definition) row.append(textElement('p', sense.definition, 'sense-en'));
  list.append(row);
}

function cleanMeaning(text: string): string {
  return text.replace(/(^|[，；;]\s*)(?:(?:n|v|vt|vi|adj|adv|prep|conj|pron|interj|aux|det|num|art)\.\s*|(?:名词|动词|形容词|副词|介词|连词|代词)[：:]\s*)+/gi, '$1').trim();
}

const popupStyles = `
:host{color-scheme:light}*{box-sizing:border-box}button{font:500 13px/1.4 "Microsoft YaHei UI","Microsoft YaHei","Noto Sans SC","Segoe UI",sans-serif;cursor:pointer;border:0;transition:background .15s,color .15s}
button:focus-visible,summary:focus-visible{outline:2px solid #c94b35;outline-offset:3px}
.trigger{display:block;max-width:var(--popup-max-width,calc(100vw - 24px));overflow-wrap:anywhere;padding:9px 13px;border:1px solid #dddcd5;border-radius:5px;background:#fcfbf8;color:#222521;box-shadow:0 3px 12px #22252112}.trigger:hover{background:#f3f2ed}
.card{font:14px/1.6 "Microsoft YaHei UI","Microsoft YaHei","Noto Sans SC","Segoe UI",sans-serif;color:#222521;background:#fcfbf8;border:1px solid #dddcd5;border-radius:6px;box-shadow:0 8px 24px #22252112;width:min(320px,var(--popup-max-width,calc(100vw - 24px)));max-height:var(--popup-max-height,calc(100vh - 24px));overflow:auto;overscroll-behavior:contain;padding:18px;overflow-wrap:anywhere;text-align:left}
.entry-card{display:flex;flex-direction:column;overflow:hidden}.entry-card>.head,.entry-card>.meta,.entry-card>.record-status{flex-shrink:0}.entry-body{min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:#dddcd5 transparent;padding-right:2px}
.head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}.dismiss{display:grid;place-items:center;flex-shrink:0;background:transparent;color:#7b7d75;font:300 21px/1 "Segoe UI",sans-serif;width:24px;height:28px;border-radius:4px}.dismiss:hover{color:#222521;background:#eeede7}
h2{font:500 29px/1.15 Georgia,Cambria,serif;letter-spacing:-.035em;margin:0;color:#222521}p{margin:0}.query{font-size:10px;color:#7b7d75}.meta{display:flex;align-items:center;flex-wrap:wrap;gap:4px 10px;margin:7px 0 13px;color:#7b7d75;font-size:12px}.phonetic{font-family:"Segoe UI","Microsoft YaHei UI",sans-serif;font-size:12px}.head+.entry-body{margin-top:13px}.meaning{font-size:14px;line-height:1.65;margin:0 0 5px}
.senses{margin:0;padding-left:18px}.senses li{padding-left:2px;margin-bottom:11px}.senses li:last-child{margin-bottom:0}.senses li::marker{font:500 10px "Segoe UI",sans-serif;color:#7b7d75}.pos{font:italic 12px/1.5 Georgia,Cambria,serif;color:#7b7d75;display:block;margin-bottom:3px}.sense-zh{font-size:14px;line-height:1.65;font-weight:400}.sense-en,.definition{color:#7b7d75;font-size:12px;line-height:1.6}.sense-en{margin-top:5px}.definition{margin-top:5px}.primary-sense{list-style:none;padding-left:0}.primary-sense li{padding-left:0}.primary-sense .pos{display:inline;margin-right:7px}.primary-sense .sense-zh{display:inline}.primary-sense .sense-en:first-child{margin-top:0}details{margin-top:10px}summary{cursor:pointer;color:#7b7d75;font-size:11px;padding:3px 0}summary:hover{color:#222521}details[open] summary{margin-bottom:9px}summary::marker{font-size:9px}.more-content>.meaning{margin-top:10px}
.example{margin:12px 0 0;padding:0;color:#7b7d75;font-size:12px;line-height:1.6}.forms{font-size:11px;line-height:1.7;color:#7b7d75;margin-top:12px}.record-status{display:flex;gap:6px;align-items:flex-start;font-size:10px;line-height:1.6;color:#7b7d75;margin-top:12px;padding-top:9px;border-top:1px solid #e9e8e1}.record-status::before{content:'';flex-shrink:0;width:3px;height:3px;border-radius:50%;background:#9c9e94;margin-top:6px}.record-status[data-synced=true]::before{background:#222521}
.loading,.notice{margin:18px 0 5px;color:#7b7d75;font-size:13px}.loading{display:flex;gap:9px;align-items:center}.loading::before{content:'';width:11px;height:11px;flex-shrink:0;border:1px solid #dddcd5;border-top-color:#c94b35;border-radius:50%;animation:spin .8s linear infinite}.retry{padding:8px 12px;border-radius:4px;background:#222521;color:#fcfbf8;margin-top:10px}.retry:hover{background:#41443e}@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.loading::before{animation:none}button{transition:none}}
`;
