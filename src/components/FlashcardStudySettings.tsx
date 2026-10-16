import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Check, ChevronRight, Upload, X } from 'lucide-react';
import { resolveLearningWordIds } from '../lib/dictionaryClient';
import { parseFlashcardWordList } from '../lib/flashcardWordList';
import { FlashcardWordManager } from './FlashcardWordManager';
import type { FlashcardStudyPreferences, FlashcardWordAction } from '../lib/flashcardPreferences';
import type { WordMemoryState } from '../lib/memoryV2/types';
import './flashcardStudySettings.css';

interface FlashcardStudySettingsProps {
  open: boolean;
  onClose: () => void;
  preferences: FlashcardStudyPreferences;
  introducedToday: number;
  remainingNewCount: number;
  onSaveLimit: (limit: number | null) => Promise<void>;
  onImportWords: (canonicalWordIds: string[]) => Promise<{ addedCount: number; existingCount: number; enrolledCount: number }>;
  existingWordIds: readonly string[];
  managedWordIds: readonly string[];
  memoryStates?: readonly WordMemoryState[];
  canonicalWordIds: ReadonlyMap<string, string>;
  onUpdateWords: (words: string[], action: FlashcardWordAction) => Promise<void>;
}

type WordListFormat = 'text' | 'csv' | 'tsv' | 'json' | 'auto';
type BusyOperation = 'saving' | 'reading' | 'previewing' | 'importing' | 'updating';
type SettingsView = 'home' | 'daily' | 'import' | 'preview' | 'done' | 'manage';
interface WordListPreview {
  words: string[];
  existingIds: string[];
  duplicateCount: number;
  invalidCount: number;
  inputCount: number;
  libraryKey: string;
}

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const PRESET_LIMITS = [10, 20, 50, 100, null];
const normalizeId = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase();
const errorMessage = (cause: unknown, fallback: string) => cause instanceof Error && cause.message ? cause.message : fallback;

export function FlashcardStudySettings({
  open, onClose, preferences,
  onSaveLimit, onImportWords, existingWordIds, managedWordIds, memoryStates = [], canonicalWordIds, onUpdateWords,
}: FlashcardStudySettingsProps) {
  const id = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef<BusyOperation | null>(null);
  const operationRef = useRef(0);
  const openRef = useRef(open);
  const closeRef = useRef(onClose);
  const preferencesRef = useRef(preferences);
  openRef.current = open;
  closeRef.current = onClose;
  preferencesRef.current = preferences;

  const [busy, setBusy] = useState<BusyOperation | null>(null);
  const [view, setView] = useState<SettingsView>('home');
  const [inputMode, setInputMode] = useState<'file' | 'paste'>('file');
  const [limitText, setLimitText] = useState(String(preferences.dailyNewWordLimit ?? 10));
  const [unlimited, setUnlimited] = useState(preferences.dailyNewWordLimit === null);
  const [limitError, setLimitError] = useState<string | null>(null);
  const [sourceText, setSourceText] = useState('');
  const [sourceFormat, setSourceFormat] = useState<WordListFormat>('auto');
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState<WordListPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [imported, setImported] = useState(false);

  const canonicalMap = useMemo(() => new Map([...canonicalWordIds].map(([word, canonical]) => [normalizeId(word), normalizeId(canonical)])), [canonicalWordIds]);
  const managerPreferences = useMemo(() => {
    const ids = (words: readonly string[] = []) => [...new Set(words.map(word => canonicalMap.get(normalizeId(word)) ?? normalizeId(word)))];
    return { ...preferences, importedWordIds: ids(preferences.importedWordIds),
      pausedWordIds: ids(preferences.pausedWordIds), excludedWordIds: ids(preferences.excludedWordIds) };
  }, [preferences, canonicalMap]);
  const libraryKey = useMemo(() => JSON.stringify([
    [...existingWordIds].map(normalizeId).sort(),
    preferences.importedWordIds.map(normalizeId).sort(),
    [...canonicalMap].sort(([left], [right]) => left.localeCompare(right)),
  ]), [existingWordIds, preferences.importedWordIds, canonicalMap]);
  const limitNumber = Number(limitText);
  const validLimit = unlimited || (/^\d+$/.test(limitText) && Number.isSafeInteger(limitNumber) && limitNumber >= 0);
  const selectedLimit = unlimited ? null : validLimit ? limitNumber : undefined;
  const changedLimit = validLimit && selectedLimit !== preferences.dailyNewWordLimit;
  const previewStale = !!preview && preview.libraryKey !== libraryKey && !imported;
  const previewCounts = useMemo(() => {
    if (!preview) return null;
    const existing = new Set(preview.existingIds);
    preferences.importedWordIds.forEach(word => existing.add(canonicalMap.get(normalizeId(word)) ?? normalizeId(word)));
    const existingCount = preview.words.filter(word => existing.has(word)).length;
    return { existingCount, addedCount: preview.words.length - existingCount };
  }, [preview, preferences.importedWordIds, canonicalMap]);

  useEffect(() => {
    if (!open) return;
    const currentPreferences = preferencesRef.current;
    setView('home');
    setInputMode('file');
    setLimitText(String(currentPreferences.dailyNewWordLimit ?? 10));
    setUnlimited(currentPreferences.dailyNewWordLimit === null);
    setLimitError(null);
    setSourceText('');
    setSourceFormat('auto');
    setFileName('');
    setPreview(null);
    setPreviewError(null);
    setImportError(null);
    setImportMessage(null);
    setImported(false);
    setBusy(null);
    busyRef.current = null;

    const dialog = dialogRef.current;
    if (!dialog) return;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    if (!dialog.open) dialog.showModal();
    dialog.focus({ preventScroll: true });

    const focusableElements = () => [...dialog.querySelectorAll<HTMLElement>(
      'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],summary,[tabindex]',
    )].filter(element => element.tabIndex >= 0 && !element.matches(':disabled') && element.getClientRects().length > 0);
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation();
        if (!busyRef.current) closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusableElements();
      const first = items[0];
      const last = items[items.length - 1];
      if (!first) { event.preventDefault(); dialog.focus(); return; }
      const focusIsOutsideItems = !items.includes(document.activeElement as HTMLElement);
      if (event.shiftKey && (document.activeElement === first || focusIsOutsideItems)) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || focusIsOutsideItems)) {
        event.preventDefault(); first.focus();
      }
    };
    const keepFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !dialog.contains(event.target)) dialog.focus({ preventScroll: true });
    };
    document.addEventListener('keydown', trapFocus, true);
    document.addEventListener('focusin', keepFocus);
    return () => {
      operationRef.current += 1;
      busyRef.current = null;
      document.removeEventListener('keydown', trapFocus, true);
      document.removeEventListener('focusin', keepFocus);
      document.body.style.overflow = previousOverflow;
      if (dialog.open) dialog.close();
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    headingRef.current?.focus({ preventScroll: true });
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [open, view]);

  const beginOperation = (operation: BusyOperation) => {
    if (!openRef.current || busyRef.current) return null;
    busyRef.current = operation;
    setBusy(operation);
    return ++operationRef.current;
  };
  const isCurrentOperation = (token: number) => openRef.current && operationRef.current === token;
  const finishOperation = (token: number) => {
    if (!isCurrentOperation(token)) return;
    busyRef.current = null;
    setBusy(null);
  };
  const close = () => { if (!busyRef.current) closeRef.current(); };
  const goBack = () => {
    if (busyRef.current) return;
    setView(view === 'preview' ? 'import' : 'home');
  };
  const openDaily = () => {
    if (busyRef.current) return;
    setLimitText(String(preferencesRef.current.dailyNewWordLimit ?? 10));
    setUnlimited(preferencesRef.current.dailyNewWordLimit === null);
    setLimitError(null);
    setView('daily');
  };
  const clearImportFeedback = () => {
    setPreview(null);
    setPreviewError(null);
    setImportError(null);
    setImportMessage(null);
    setImported(false);
  };

  const saveLimit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!validLimit || selectedLimit === undefined) return;
    const token = beginOperation('saving');
    if (token === null) return;
    setLimitError(null);
    try {
      await onSaveLimit(selectedLimit);
      if (isCurrentOperation(token)) setView('home');
    } catch (cause) {
      if (isCurrentOperation(token)) setLimitError(errorMessage(cause, '保存失败，请重试。'));
    } finally { finishOperation(token); }
  };

  const readFile = async (file: File | null) => {
    if (!file) return;
    const token = beginOperation('reading');
    if (token === null) return;
    clearImportFeedback();
    setSourceText('');
    setFileName('');
    try {
      if (file.size > MAX_FILE_BYTES) throw new Error('文件不能超过 2 MB。');
      const extension = file.name.split('.').pop()?.toLowerCase();
      if (!extension || !['txt', 'csv', 'tsv', 'json'].includes(extension)) throw new Error('请选择 TXT、CSV、TSV 或 JSON 文件。');
      const text = await file.text();
      if (!isCurrentOperation(token)) return;
      setSourceText(text);
      setSourceFormat(extension === 'txt' ? 'text' : extension as WordListFormat);
      setFileName(file.name);
    } catch (cause) {
      if (isCurrentOperation(token)) setPreviewError(errorMessage(cause, '文件读取失败，请重试。'));
    } finally { finishOperation(token); }
  };

  const previewWords = async () => {
    if (!sourceText.trim()) return;
    const token = beginOperation('previewing');
    if (token === null) return;
    setPreviewError(null);
    setImportError(null);
    setImportMessage(null);
    setImported(false);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (new TextEncoder().encode(sourceText).byteLength > MAX_FILE_BYTES) throw new Error('词表不能超过 2 MB。');
      const parsed = parseFlashcardWordList(sourceText, sourceFormat);
      if (!parsed.words.length) throw new Error('没有找到有效英文词，请检查词表。');
      const knownExisting = existingWordIds.map(normalizeId);
      const unresolvedExisting = [...new Set(knownExisting.filter(word => word && !canonicalMap.has(word)))];
      const resolved = await Promise.race([
        resolveLearningWordIds([...parsed.words, ...unresolvedExisting]),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('单词整理暂未完成，请重试。')), 20_000); }),
      ]);
      if (!isCurrentOperation(token)) return;
      if (resolved.length !== parsed.words.length + unresolvedExisting.length || resolved.some(word => !word.trim())) throw new Error('单词整理未完成，请重试。');
      const words = [...new Set(resolved.slice(0, parsed.words.length).map(normalizeId))];
      const existingIds = [...new Set([
        ...knownExisting.filter(word => canonicalMap.has(word)).map(word => canonicalMap.get(word)!),
        ...resolved.slice(parsed.words.length).map(normalizeId),
        ...preferences.importedWordIds.map(word => canonicalMap.get(normalizeId(word)) ?? normalizeId(word)),
      ])];
      setPreview({ words, existingIds, duplicateCount: parsed.duplicateCount + parsed.words.length - words.length,
        invalidCount: parsed.invalidCount, inputCount: parsed.inputCount, libraryKey });
      setView('preview');
    } catch (cause) {
      if (isCurrentOperation(token)) setPreviewError(errorMessage(cause, '预览失败，请重试。'));
    } finally {
      if (timer) clearTimeout(timer);
      finishOperation(token);
    }
  };

  const importWords = async () => {
    if (!preview?.words.length || previewStale || imported) return;
    const token = beginOperation('importing');
    if (token === null) return;
    setImportError(null);
    setImportMessage(null);
    try {
      const result = await onImportWords([...preview.words]);
      if (!isCurrentOperation(token)) return;
      setImported(true);
      setImportMessage(`新增 ${result.addedCount} 个单词，已有 ${result.existingCount} 个单词；本次 ${result.enrolledCount} 个单词加入学习。已有单词保留学习进度。`);
      setView('done');
    } catch (cause) {
      if (isCurrentOperation(token)) setImportError(errorMessage(cause, '导入失败，请重试。'));
    } finally { finishOperation(token); }
  };

  if (!open) return null;

  const title = { home: '学习设置', daily: '每日新词', import: '导入词表', preview: '确认词表', done: '导入完成', manage: '词表管理' }[view];
  const dailySummary = preferences.dailyNewWordLimit === null ? '不限' : preferences.dailyNewWordLimit === 0 ? '仅复习' : `${preferences.dailyNewWordLimit} 个 / 天`;

  return <dialog ref={dialogRef} className="flashcard-settings" aria-labelledby={`${id}-title`} aria-modal="true" aria-busy={!!busy} tabIndex={-1}
    onCancel={event => { event.preventDefault(); close(); }}
    onClick={event => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
    }}>
    <header className="flashcard-settings__header">
      {view !== 'home' && view !== 'done' && <button type="button" className="flashcard-settings__back" aria-label={view === 'preview' ? '返回词表输入' : '返回学习设置'} disabled={!!busy} onClick={goBack}><ArrowLeft size={18} aria-hidden="true" /></button>}
      <h2 ref={headingRef} tabIndex={-1} id={`${id}-title`}>{title}</h2>
      <button type="button" className="flashcard-settings__close" aria-label="关闭学习设置" disabled={!!busy} onClick={close}><X size={18} aria-hidden="true" /></button>
    </header>
    <div ref={bodyRef} className="flashcard-settings__body">
      {view === 'home' && <div className="flashcard-settings__menu">
        <button type="button" disabled={!!busy} onClick={openDaily}><span>每日新词</span><span className="flashcard-settings__menu-value">{dailySummary}</span><ChevronRight size={17} aria-hidden="true" /></button>
        <button type="button" disabled={!!busy} onClick={() => { if (!busyRef.current) setView('import'); }}><span>导入词表</span><ChevronRight size={17} aria-hidden="true" /></button>
        <button type="button" disabled={!!busy} onClick={() => { if (!busyRef.current) setView('manage'); }}><span>词表管理</span><ChevronRight size={17} aria-hidden="true" /></button>
      </div>}

      {view === 'manage' && <FlashcardWordManager words={managedWordIds}
        memoryStates={memoryStates} canonicalWordIds={canonicalWordIds}
        preferences={managerPreferences} busy={!!busy} onUpdate={async (words, action) => {
          const token = beginOperation('updating');
          if (token === null) return;
          try { await onUpdateWords(words, action); } finally { finishOperation(token); }
        }} />}

      {view === 'daily' && <section className="flashcard-settings__page">
        <form onSubmit={event => void saveLimit(event)}>
          <label className="flashcard-settings__quantity" htmlFor={`${id}-limit`}>
            <input id={`${id}-limit`} aria-label="每日新词数量" type="number" min={0} step={1} inputMode="numeric" value={unlimited ? '' : limitText} disabled={!!busy} aria-invalid={!unlimited && !!limitText && !validLimit} aria-describedby={`${id}-limit-help`} placeholder={unlimited ? '不限' : '0'} onChange={event => { setUnlimited(false); setLimitText(event.target.value); setLimitError(null); }} />
            {!unlimited && <span>个 / 天</span>}
          </label>
          <div className="flashcard-settings__limits" role="group" aria-label="快速选择数量">{PRESET_LIMITS.map(limit => <button type="button" key={limit ?? 'unlimited'} disabled={!!busy} aria-pressed={validLimit && selectedLimit === limit} onClick={() => { setUnlimited(limit === null); if (limit !== null) setLimitText(String(limit)); setLimitError(null); }}>{limit ?? '不限'}</button>)}</div>
          <p id={`${id}-limit-help`} className="flashcard-settings__note">{selectedLimit === 0 ? '设为 0，只复习已有单词。' : '到期复习不占新词数量；设为 0 可仅复习。'}</p>
          {limitError && <p className="flashcard-settings__error" role="alert">{limitError}</p>}
          <button type="submit" className="flashcard-settings__primary" disabled={!!busy || !validLimit || (!changedLimit && !limitError)}>{busy === 'saving' ? '保存中…' : limitError ? '重试保存' : '保存'}</button>
        </form>
      </section>}

      {view === 'import' && <section className="flashcard-settings__page">
        <div className="flashcard-settings__source-tabs" role="group" aria-label="词表来源">{(['file', 'paste'] as const).map(mode => <button key={mode} type="button" disabled={!!busy} aria-pressed={inputMode === mode} onClick={() => {
          if (busyRef.current || mode === inputMode) return;
          setInputMode(mode); setSourceText(''); setSourceFormat('auto'); setFileName(''); clearImportFeedback();
        }}>{mode === 'file' ? '上传文件' : '粘贴单词'}</button>)}</div>
        <input ref={fileInputRef} type="file" className="flashcard-settings__file-input" tabIndex={-1} accept=".txt,.csv,.tsv,.json,text/plain,text/csv,text/tab-separated-values,application/json" aria-label="选择词表文件" disabled={!!busy} onChange={event => { const file = event.target.files?.[0] ?? null; event.target.value = ''; void readFile(file); }} />
        {inputMode === 'file' ? <button type="button" className="flashcard-settings__file" disabled={!!busy} onClick={() => fileInputRef.current?.click()}>
          <Upload size={23} strokeWidth={1.4} aria-hidden="true" />
          <span className="flashcard-settings__file-name">{busy === 'reading' ? '读取中…' : fileName || '选择词表文件'}</span>
          <span className="flashcard-settings__note">{fileName ? '点击更换文件' : 'TXT / CSV / TSV / JSON'}</span>
        </button> : <textarea id={`${id}-words`} aria-label="粘贴单词" value={sourceText} disabled={!!busy} rows={5} placeholder="每行一个英文单词或短语" spellCheck={false} onChange={event => { setSourceText(event.target.value); setSourceFormat('auto'); setFileName(''); clearImportFeedback(); }} />}
        {previewError && <p className="flashcard-settings__error" role="alert">{previewError}</p>}
        <button type="button" className="flashcard-settings__primary" disabled={!!busy || !sourceText.trim()} onClick={() => void previewWords()}>{busy === 'previewing' ? '整理中…' : previewError ? '重新检查' : '下一步'}</button>
      </section>}

      {view === 'preview' && preview && previewCounts && <section className="flashcard-settings__page">
        <p className="flashcard-settings__total"><strong>{preview.words.length}</strong><span>个单词</span></p>
        <dl className="flashcard-settings__counts"><div><dt>新单词</dt><dd>{previewCounts.addedCount}</dd></div><div><dt>已有单词</dt><dd>{previewCounts.existingCount}</dd></div></dl>
        {previewCounts.existingCount > 0 && <p className="flashcard-settings__note">已有单词保留学习进度。</p>}
        {(preview.duplicateCount > 0 || preview.invalidCount > 0) && <p className="flashcard-settings__note">已忽略{[preview.duplicateCount > 0 ? `${preview.duplicateCount} 个重复词` : '', preview.invalidCount > 0 ? `${preview.invalidCount} 项无效内容` : ''].filter(Boolean).join('、')}。</p>}
        <details className="flashcard-settings__word-list"><summary>查看词表</summary><p lang="en">{preview.words.join(' · ')}</p></details>
        {previewStale && <p className="flashcard-settings__error" role="status">词库已更新，请重新检查。</p>}
        {previewError && <p className="flashcard-settings__error" role="alert">{previewError}</p>}
        {importError && <p className="flashcard-settings__error" role="alert">{importError}</p>}
        {previewStale ? <button type="button" className="flashcard-settings__primary" disabled={!!busy} onClick={() => void previewWords()}>{busy === 'previewing' ? '整理中…' : '重新检查'}</button> : <button type="button" className="flashcard-settings__primary" disabled={!!busy || imported} onClick={() => void importWords()}>{busy === 'importing' ? '导入中…' : importError ? '重试导入' : `导入 ${preview.words.length} 个词`}</button>}
      </section>}

      {view === 'done' && <section className="flashcard-settings__page flashcard-settings__done">
        <Check size={30} strokeWidth={1.3} aria-hidden="true" />
        <p role="status">{importMessage}</p>
        <button type="button" className="flashcard-settings__primary" disabled={!!busy} onClick={close}>完成</button>
      </section>}
    </div>
  </dialog>;
}
