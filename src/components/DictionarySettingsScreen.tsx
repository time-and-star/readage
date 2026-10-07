import React, { useEffect, useRef, useState } from 'react';
import { Check, GripVertical, Plus, RefreshCw } from 'lucide-react';
import { LayoutGroup, Reorder, useDragControls, useMotionValue, useReducedMotion } from 'motion/react';
import type { SourceCatalog } from '../../packages/dictionary/contracts';
import { AppPageHeader } from './AppPageHeader';
import { applyDictionaryCatalog } from '../lib/dictionaryCatalog';
import { DictionarySettingsAutosave } from '../lib/dictionarySettingsAutosave';
import {
  dictionarySettingsClient,
  dictionarySettingsEqual,
  moveDictionarySource,
  setDictionarySourceOrder,
  setDictionaryEnabled,
  validateDictionaryImportFile,
  type DictionarySettings,
  type DictionarySettingsSnapshot,
} from '../lib/dictionarySettingsClient';
import './dictionarySettings.css';

interface DictionarySettingsScreenProps {
  onBack: () => void;
  navigation?: React.ReactNode;
  initialSnapshot?: DictionarySettingsSnapshot;
}

interface SortableDictionaryCardProps {
  id: string;
  busy: boolean;
  className: string;
  listRef: React.RefObject<HTMLOListElement | null>;
  onBegin: () => boolean;
  onLift: () => void;
  onFinish: () => void;
  onCancel: () => void;
  children: React.ReactNode;
}

const SortableDictionaryCard: React.FC<SortableDictionaryCardProps> = ({ id, busy, className, listRef, onBegin, onLift, onFinish, onCancel, children }) => {
  const controls = useDragControls();
  const y = useMotionValue(0);
  const reducedMotion = useReducedMotion();
  const session = useRef<{ lifted: boolean } | null>(null);
  const callbacks = useRef({ onFinish, onCancel });
  callbacks.current = { onFinish, onCancel };
  const cancel = () => {
    if (!session.current) return;
    session.current = null;
    controls.cancel();
    y.stop();
    y.set(0);
    callbacks.current.onCancel();
  };
  const finish = () => {
    if (!session.current) return;
    session.current = null;
    callbacks.current.onFinish();
  };
  useEffect(() => {
    window.addEventListener('blur', cancel);
    return () => { window.removeEventListener('blur', cancel); controls.cancel(); };
  }, [controls]);
  useEffect(() => { if (busy) cancel(); }, [busy]);

  return <Reorder.Item value={id} data-dictionary-id={id} className={className}
    dragListener={false} dragControls={controls} dragConstraints={listRef}
    dragMomentum={false} dragElastic={0.04} layout="position" style={{ y, touchAction: 'pan-y' }}
    transition={{ layout: reducedMotion ? { duration: 0 } : { type: 'spring', stiffness: 650, damping: 50, mass: 0.8 } }}
    dragTransition={{ bounceStiffness: 800, bounceDamping: 60 }}
    onPointerDown={event => {
      if (busy || event.button !== 0 || event.isPrimary === false || session.current) return;
      const target = event.target as HTMLElement;
      const grip = target.closest('.dictionary-settings__drag-handle');
      if (!grip && target.closest('button, input, label, summary, details, a')) return;
      // Leave touch scrolling available in the details; the entire heading is a drag handle.
      if (event.pointerType === 'touch' && !target.closest('.dictionary-settings__source-heading')) return;
      if (!onBegin()) return;
      event.preventDefault();
      (event.currentTarget as HTMLElement).querySelector<HTMLButtonElement>('.dictionary-settings__drag-handle')?.focus({ preventScroll: true });
      // Receive pointer-up even if a click ends just outside the card before the drag threshold.
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* The pointer may already have ended. */ }
      session.current = { lifted: false };
      controls.start(event, { distanceThreshold: 5 });
    }}
    onDragStart={() => { if (session.current) { session.current.lifted = true; onLift(); } }}
    onDragEnd={finish}
    onPointerUp={() => { if (session.current && !session.current.lifted) finish(); }}
    onPointerCancel={cancel}
    onKeyDown={event => { if (event.key === 'Escape' && session.current) { event.preventDefault(); event.stopPropagation(); cancel(); } }}>
    {children}
  </Reorder.Item>;
};

function languageLabel(tag: string): string {
  try { return new Intl.DisplayNames(['zh-CN'], { type: 'language' }).of(tag) ?? tag; }
  catch { return tag; }
}

export function compactDictionaryVersion(version: string): string {
  return version.replace(/[a-f0-9]{16,}/gi, token => token.slice(0, 8)).slice(0, 80);
}

function sourceName(source: SourceCatalog['sources'][number]): string {
  return source.id === 'native-reviewed' ? 'ReadAge 自编词典'
    : source.id === 'ecdict' ? 'ECDICT 内置词典' : source.name;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '词典设置暂不可用，请重试。';
}

export const DictionarySettingsScreen: React.FC<DictionarySettingsScreenProps> = ({
  onBack,
  navigation,
  initialSnapshot,
}) => {
  const [snapshot, setSnapshot] = useState<DictionarySettingsSnapshot | null>(initialSnapshot ?? null);
  const [draft, setDraft] = useState<DictionarySettings | null>(initialSnapshot?.settings ?? null);
  const [loading, setLoading] = useState(!initialSnapshot);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'error' | 'conflict'>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [saveWarning, setSaveWarning] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const autosave = useRef<DictionarySettingsAutosave | null>(null);
  const unsubscribeSave = useRef<(() => void) | null>(null);
  const listRef = useRef<HTMLOListElement | null>(null);
  const orderGesture = useRef<{ id: string; before: DictionarySettings } | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [expandedSources, setExpandedSources] = useState<Set<string>>(() => new Set());
  const [orderNotice, setOrderNotice] = useState('');
  const fileInput = useRef<HTMLInputElement | null>(null);
  const importRequest = useRef<AbortController | null>(null);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importLanguage, setImportLanguage] = useState('en');
  const [importName, setImportName] = useState('');
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importMessage, setImportMessage] = useState<string | null>(null);

  const installSnapshot = (value: DictionarySettingsSnapshot) => {
    unsubscribeSave.current?.();
    const writer = new DictionarySettingsAutosave(value, {
      save: update => dictionarySettingsClient.save(update), applyCatalog: applyDictionaryCatalog,
    });
    autosave.current = writer;
    const receive = (state: ReturnType<DictionarySettingsAutosave['getSnapshot']>) => {
      setSnapshot(state.snapshot);
      draftRef.current = state.settings;
      setDraft(state.settings);
      setSaveState(state.status);
      setMessage(state.message ?? null);
      setSaveWarning(state.cacheWarning ?? null);
    };
    unsubscribeSave.current = writer.subscribe(receive);
    receive(writer.getSnapshot());
  };

  useEffect(() => {
    if (initialSnapshot && reloadKey === 0) { installSnapshot(initialSnapshot); return; }
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    void dictionarySettingsClient.load(controller.signal).then(value => {
      installSnapshot(value);
    }).catch(error => {
      if (!controller.signal.aborted) setLoadError(errorMessage(error));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [initialSnapshot, reloadKey]);

  // Detach the view on navigation, while an already requested settings write completes.
  useEffect(() => () => { unsubscribeSave.current?.(); importRequest.current?.abort(); }, []);

  const enabledCount = draft?.enabledSources.length ?? 0;
  const writeBusy = loading || saveState === 'saving' || importing;
  const busy = writeBusy || saveState === 'error' || saveState === 'conflict';
  const orderedSources = draft?.sourceOrder.flatMap(id => {
    const source = snapshot?.catalog.sources.find(item => item.id === id);
    return source ? [source] : [];
  }) ?? [];

  const updateDraft = (update: (value: DictionarySettings) => DictionarySettings, persist = true) => {
    const previous = draftRef.current;
    if (!previous) return;
    const next = update(previous);
    draftRef.current = next;
    setDraft(next);
    if (persist && !dictionarySettingsEqual(previous, next)) void autosave.current?.update(next);
  };

  const endDrag = () => {
    orderGesture.current = null;
    setDraggingId(null);
  };
  const finishDrag = () => {
    const changed = orderGesture.current && draftRef.current && !dictionarySettingsEqual(orderGesture.current.before, draftRef.current);
    const next = draftRef.current;
    if (changed) {
      setOrderNotice('词典顺序已调整。');
    }
    endDrag();
    if (changed && next) void autosave.current?.update(next);
  };
  const cancelDrag = () => {
    const gesture = orderGesture.current;
    if (gesture) { draftRef.current = gesture.before; setDraft(gesture.before); setOrderNotice('已取消排序。'); }
    endDrag();
  };

  const chooseFile = (file?: File) => {
    if (!file || busy) return;
    setImportMessage(null);
    setImportName('');
    try {
      validateDictionaryImportFile(file);
      setImportFile(file);
      setImportError(null);
    } catch (error) {
      setImportFile(null);
      setImportError(errorMessage(error));
    }
  };

  const handleImport = async () => {
    if (!importFile || !snapshot || !draft || busy) return;
    const controller = new AbortController();
    importRequest.current = controller;
    setImporting(true);
    setImportError(null);
    setImportMessage(null);
    endDrag();
    try {
      const imported = await dictionarySettingsClient.importFile(importFile, {
        language: importLanguage, name: importName, signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      installSnapshot({ settings: imported.settings, catalog: imported.catalog,
        ...(snapshot.warning && imported.settings.revision === snapshot.settings.revision ? { warning: snapshot.warning } : {}) });
      setImportFile(null);
      let cacheUpdated = true;
      try { await applyDictionaryCatalog(imported.catalog); }
      catch { cacheUpdated = false; }
      if (controller.signal.aborted) return;
      setImportMessage(`已导入 ${imported.imported.name}，${imported.imported.entryCount.toLocaleString('zh-CN')} 个词条。${imported.importWarning ? ` ${imported.importWarning}` : ''}${cacheUpdated ? '' : '刷新页面可更新查词缓存。'}`);
    } catch (error) {
      if (!controller.signal.aborted) setImportError(errorMessage(error));
    } finally {
      if (importRequest.current === controller) importRequest.current = null;
      if (!controller.signal.aborted) setImporting(false);
    }
  };

  return (
    <div className="dictionary-settings-screen">
      <AppPageHeader onBack={onBack} navigation={navigation} showWordSearch={false} />
      <main className="dictionary-settings" aria-busy={writeBusy}>
        <div className="dictionary-settings__heading">
          <div>
            <h1>词典</h1>
            <p>拖动排序，查词依次展示。</p>
          </div>
          {saveState === 'saving' && <span role="status" className="dictionary-settings__saving">
            <RefreshCw aria-hidden="true" /><span className="dictionary-settings__sr-only">正在保存词典设置…</span>
          </span>}
          <button type="button" className="dictionary-settings__import-button" disabled={busy || Boolean(draggingId) || !snapshot}
            onClick={() => fileInput.current?.click()}><Plus aria-hidden="true" />导入词典</button>
          <input ref={fileInput} type="file" accept=".mdx" className="dictionary-settings__file-input" aria-label="选择 MDX 词典文件"
            disabled={busy || !snapshot} onChange={event => { chooseFile(event.target.files?.[0]); event.target.value = ''; }} />
        </div>

        {loading && !snapshot && <p role="status" className="dictionary-settings__notice">正在读取词典设置…</p>}
        {loadError && <div role="alert" className="dictionary-settings__notice dictionary-settings__notice--error">
          <span>{loadError}</span>
          <button type="button" onClick={() => setReloadKey(value => value + 1)} disabled={writeBusy}>
            <RefreshCw aria-hidden="true" />重新加载
          </button>
        </div>}
        {snapshot?.warning && <div role="alert" className="dictionary-settings__notice dictionary-settings__notice--warning">
          <span>{snapshot.warning}</span><button type="button" disabled={writeBusy} onClick={() => void autosave.current?.retry()}>修复设置</button>
        </div>}
        {message && <div role="alert" className="dictionary-settings__notice dictionary-settings__notice--error">
          <span>{message}</span>
          {saveState === 'conflict'
            ? <button type="button" disabled={writeBusy} onClick={() => setReloadKey(value => value + 1)}><RefreshCw aria-hidden="true" />重新加载</button>
            : <button type="button" disabled={writeBusy} onClick={() => void autosave.current?.retry()}><RefreshCw aria-hidden="true" />重试</button>}
        </div>}
        {saveWarning && <p role="status" className="dictionary-settings__notice dictionary-settings__notice--warning">{saveWarning}</p>}
        {importMessage && <p role="status" className="dictionary-settings__import-success"><Check aria-hidden="true" />{importMessage}</p>}
        {(importFile || importError) && <section className="dictionary-settings__import-panel" aria-label="导入词典文件"
          onDragOver={event => { if (!busy && event.dataTransfer.types.includes('Files')) event.preventDefault(); }}
          onDrop={event => { if (event.dataTransfer.files.length && !busy) { event.preventDefault(); chooseFile(event.dataTransfer.files[0]); } }}>
          {importFile && <>
            <div className="dictionary-settings__import-file">
              <span>{importFile.name}</span>
              <small>{(importFile.size / (1024 * 1024)).toLocaleString('zh-CN', { maximumFractionDigits: 1 })} MB</small>
              {!importing && <button type="button" disabled={busy} onClick={() => fileInput.current?.click()}>更换文件</button>}
            </div>
            <details className="dictionary-settings__import-options">
              <summary>语言与名称</summary>
              <div>
                <label>词条语言<input type="text" value={importLanguage} placeholder="en" maxLength={80} disabled={busy}
                  onChange={event => setImportLanguage(event.target.value)} /></label>
                <label>词典名称<input type="text" value={importName} placeholder="使用文件内的名称" maxLength={128} disabled={busy}
                  onChange={event => setImportName(event.target.value)} /></label>
              </div>
            </details>
            <p className="dictionary-settings__import-hint">最大 256 MB。支持 MDX 文字词条；部分压缩或加密文件、MDD 图片与音频暂不支持。</p>
          </>}
          {importError && <p role="alert" className="dictionary-settings__save-error">{importError}</p>}
          {importing ? <div role="status" className="dictionary-settings__import-progress">
            <span>正在导入词典…</span><progress aria-label="正在导入词典" />
          </div> : <div className="dictionary-settings__import-actions">
            <button type="button" className="dictionary-settings__secondary" disabled={busy}
              onClick={() => { setImportFile(null); setImportError(null); }}>取消</button>
            {importFile && <button type="button" className="dictionary-settings__save" disabled={busy} onClick={() => void handleImport()}>导入</button>}
          </div>}
        </section>}

        {snapshot && draft && <>
          <fieldset className="dictionary-settings__sources" disabled={busy}>
            <legend className="dictionary-settings__sr-only">已安装词典</legend>
            <span id="dictionary-drag-help" className="dictionary-settings__sr-only">拖动卡片或标题排序，按 Escape 取消；也可在拖动手柄上按上下方向键。</span>
            <LayoutGroup>
            <Reorder.Group as="ol" axis="y" ref={listRef} values={draft.sourceOrder}
              className={`dictionary-settings__list${draggingId ? ' dictionary-settings__list--dragging' : ''}`}
              onReorder={sourceOrder => {
                if (!orderGesture.current || busy) return;
                updateDraft(value => setDictionarySourceOrder(value, sourceOrder), false);
              }}>
              {orderedSources.map((source, index) => {
                const name = sourceName(source);
                const enabled = draft.enabledSources.includes(source.id);
                const lastEnabled = enabled && enabledCount === 1;
                return <SortableDictionaryCard key={source.id} id={source.id} busy={busy} listRef={listRef}
                  className={`dictionary-settings__source${enabled ? '' : ' dictionary-settings__source--disabled'}${draggingId === source.id ? ' dictionary-settings__source--dragging' : ''}`}
                  onBegin={() => {
                    if (orderGesture.current) return false;
                    orderGesture.current = { id: source.id, before: draft };
                    return true;
                  }}
                  onLift={() => setDraggingId(source.id)} onFinish={finishDrag} onCancel={cancelDrag}>
                  <div className="dictionary-settings__source-heading">
                    <button type="button" className="dictionary-settings__drag-handle" aria-label={`调整 ${name} 的顺序`}
                      aria-describedby="dictionary-drag-help" title="拖动排序"
                      onKeyDown={event => {
                        if (draggingId || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
                        event.preventDefault();
                        const direction = event.key === 'ArrowUp' ? -1 : 1;
                        if (index + direction < 0 || index + direction >= orderedSources.length) return;
                        updateDraft(value => moveDictionarySource(value, source.id, direction));
                        setOrderNotice(`${name} 已${direction === -1 ? '上移' : '下移'}。`);
                      }}>
                      <GripVertical aria-hidden="true" />
                    </button>
                    <div className="dictionary-settings__source-name">
                      <h2>{name}</h2>
                      {!source.available && <span className="dictionary-settings__availability dictionary-settings__availability--unavailable">暂不可用</span>}
                    </div>
                    <label className="dictionary-settings__enabled">
                      <input type="checkbox" checked={enabled} disabled={lastEnabled} aria-label={`启用 ${name}`}
                        aria-describedby={lastEnabled ? 'dictionary-minimum-enabled' : undefined}
                        onChange={event => {
                          const checked = event.currentTarget.checked;
                          updateDraft(value => setDictionaryEnabled(value, source.id, checked));
                        }} />
                      <span className="dictionary-settings__sr-only">启用</span>
                    </label>
                  </div>
                  {(source.entryCount !== undefined || source.description) && <p className="dictionary-settings__coverage">
                    {source.entryCount !== undefined && <span>已收录 {source.entryCount.toLocaleString('zh-CN')} 个词条。 </span>}
                    {source.description}
                  </p>}
                  <details className="dictionary-settings__metadata" open={expandedSources.has(source.id)}>
                    <summary onClick={event => {
                      // Change size during React's commit so every sortable card measures the same layout.
                      event.preventDefault();
                      if (draggingId) return;
                      setExpandedSources(previous => {
                        const next = new Set(previous);
                        if (next.has(source.id)) next.delete(source.id);
                        else next.add(source.id);
                        return next;
                      });
                    }}>详情</summary>
                    {!source.available && <p className="dictionary-settings__source-warning">此词典暂时无法读取，其他已启用词典仍可用于查词。</p>}
                    <dl>
                      <div><dt>词条语言</dt><dd>{source.languages.map(languageLabel).join('、')}</dd></div>
                      <div><dt>释义语言</dt><dd>{source.definitionLanguages.map(languageLabel).join('、')}</dd></div>
                      <div><dt>数据版本</dt><dd title={source.contentVersion}>{compactDictionaryVersion(source.contentVersion)}</dd></div>
                      {source.provenance.map((provenance, position) => <div key={position}><dt>{position === 0 ? '来源' : '来源补充'}</dt>
                        <dd>{provenance.label ?? provenance.kind}{provenance.detail && <span> · {provenance.detail}</span>}</dd></div>)}
                      <div><dt>适配器</dt><dd>{source.adapterVersion}</dd></div>
                      <div><dt>数据结构</dt><dd>{source.schemaVersion}</dd></div>
                    </dl>
                    <label className="dictionary-settings__default">
                      <input type="radio" name="default-dictionary" checked={draft.defaultSource === source.id} disabled={!enabled}
                        aria-label={`将 ${name} 设为默认词典`}
                        onChange={() => updateDraft(value => ({ ...value, defaultSource: source.id }))} />
                      默认词典
                    </label>
                  </details>
                </SortableDictionaryCard>;
              })}
            </Reorder.Group>
            </LayoutGroup>
            <p id="dictionary-minimum-enabled" className="dictionary-settings__sr-only">至少保留一本已启用词典。</p>
            <span role="status" aria-live="polite" className="dictionary-settings__sr-only">{orderNotice}</span>
          </fieldset>

        </>}
      </main>
    </div>
  );
};
