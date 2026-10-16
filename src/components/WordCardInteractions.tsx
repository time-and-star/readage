import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FC, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Volume2 } from 'lucide-react';
import type { GrammarExplanation, TranslationResult } from '../types';
import { createWordCardRequest, fetchWordCard } from '../lib/wordCard';
import { translateSelection } from '../lib/localTranslation';
import { observeReadingSelection } from '../lib/observeReadingSelection';
import { getWordCardSelection, isInWordCardScope } from '../lib/wordCardInteractions';
import { createDictionaryClient, resolveDictionaryLearningWordId } from '../lib/dictionaryClient';
import type { LookupResult } from '../../packages/dictionary/contracts';
import { useMemorySystem } from '../lib/memoryV2/hooks';
import { saveLookupEvidenceOnce, type LookupEvidenceState } from '../lib/lookupEvidence';
import { ReadingLookupCard, type LookupAnchor } from './ReadingLookupCard';
import { SelectionTranslationNote } from './SelectionTranslationNote';
import { WordCardInteractionContext } from './WordCardInteractionContext';

interface Props {
  scopeId: string;
  ancestorCardIds?: string[];
  word: string;
  onSpeak: (text: string) => void;
  onStopSpeech?: () => void;
  language?: string;
  children: ReactNode;
}
interface SelectionAction { text: string; anchor: LookupAnchor; touch: boolean }
interface NestedLookup {
  word: string; anchor: LookupAnchor; loading: boolean; result: GrammarExplanation | null;
  neutralResult?: LookupResult | null;
  error: string | null; recordStatus?: string; retryRecord?: () => void;
}

export const WordCardInteractions: FC<Props> = ({ scopeId, ancestorCardIds = [], word, onSpeak, onStopSpeech, language = 'en', children }) => {
  const content = useRef<HTMLDivElement>(null);
  const lookupAbort = useRef<AbortController | null>(null);
  const nestedSpeechOwned = useRef(false);
  const stopSpeech = useRef(onStopSpeech);
  stopSpeech.current = onStopSpeech;
  const stopNestedSpeech = () => {
    if (nestedSpeechOwned.current) stopSpeech.current?.();
    nestedSpeechOwned.current = false;
  };
  const lookupEvidence = useRef<{ word: string; occurrenceId: string; state: LookupEvidenceState } | null>(null);
  const translationAbort = useRef<AbortController | null>(null);
  const [lookup, setLookup] = useState<NestedLookup | null>(null);
  const [selection, setSelection] = useState<SelectionAction | null>(null);
  const [translation, setTranslation] = useState<{ text: string; loading: boolean; result: TranslationResult | null; error: string | null } | null>(null);
  const { recordExposure, recordClick } = useMemorySystem();
  const scopes = [...ancestorCardIds, scopeId];

  useEffect(() => () => { lookupAbort.current?.abort(); translationAbort.current?.abort(); stopNestedSpeech(); }, []);

  const select = useCallback((text: string, range: Range, touch: boolean) => {
    const root = content.current;
    if (!root || !root.contains(range.startContainer) || !root.contains(range.endContainer) || !text.trim()) return;
    const rect = range.getBoundingClientRect();
    setSelection({ text: text.trim(), anchor: { left: rect.left, top: rect.top, bottom: rect.bottom }, touch });
  }, []);

  useEffect(() => {
    const root = content.current;
    if (!root) return;
    return observeReadingSelection(root, () => {
      const selected = getWordCardSelection(root);
      if (!selected) { setSelection(null); return; }
      select(selected.text, selected.range, window.matchMedia('(pointer: coarse)').matches);
    });
  }, [select]);

  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (isInWordCardScope(event.target, scopeId)) return;
      setSelection(null);
      translationAbort.current?.abort();
      setTranslation(null);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [scopeId]);

  const lookupWord = useCallback(async (value: string, rect: Pick<DOMRect, 'left' | 'top' | 'bottom'>, forceRefresh = false) => {
    const request = language === 'en' ? createWordCardRequest(value) : value.trim() ? { selectedText: value.trim(), contextSentence: '' } : null;
    if (!request) return;
    const evidence = forceRefresh && lookupEvidence.current?.word === request.selectedText ? lookupEvidence.current
      : { word: request.selectedText, occurrenceId: `word-card:${crypto.randomUUID()}`, state: { saved: false } };
    lookupEvidence.current = evidence;
    lookupAbort.current?.abort();
    stopNestedSpeech();
    const controller = new AbortController();
    lookupAbort.current = controller;
    translationAbort.current?.abort();
    setTranslation(null);
    setSelection(null);
    window.getSelection()?.removeAllRanges();
    const anchor = { left: rect.left, top: rect.top, bottom: rect.bottom };
    setLookup({ word: request.selectedText, anchor, loading: true, result: null, error: null });
    try {
      if (language !== 'en') {
        const neutralResult = await createDictionaryClient().lookup({ text: request.selectedText, language, preferredDefinitionLanguages: ['zh', language, 'en'] }, controller.signal);
        if (!controller.signal.aborted) setLookup({ word: request.selectedText, anchor, loading: false, result: null, neutralResult, error: null });
        return;
      }
      const result = await fetchWordCard(request, { signal: controller.signal, forceRefresh });
      if (controller.signal.aborted) return;
      setLookup({ word: request.selectedText, anchor, loading: false, result, error: null,
        recordStatus: evidence.state.saved ? '学习记录已保存' : '正在保存学习记录…' });
      const save = async () => {
        try {
          await saveLookupEvidenceOnce(evidence.state, async () => {
            const wordId = await resolveDictionaryLearningWordId(request.selectedText, result.learningTermRef);
            await recordExposure(wordId, 'word-card', evidence.occurrenceId, { contextText: `Dictionary lookup from ${word}: ${request.selectedText}` });
            await recordClick(wordId, 'word-card', evidence.occurrenceId);
          });
          if (!controller.signal.aborted) setLookup(previous => previous && { ...previous, recordStatus: '学习记录已保存', retryRecord: undefined });
        } catch {
          if (!controller.signal.aborted) setLookup(previous => previous && { ...previous, recordStatus: '释义已显示，学习记录待保存', retryRecord: () => { void save(); } });
        }
      };
      await save();
    } catch (error) {
      if (!controller.signal.aborted) setLookup({ word: request.selectedText, anchor, loading: false, result: null,
        error: error instanceof Error ? error.message : '查询暂时不可用，请重试。' });
    }
  }, [word, language, recordExposure, recordClick]);

  const refreshLookupRef = useRef(() => {});
  refreshLookupRef.current = () => { if (lookup) void lookupWord(lookup.word, lookup.anchor, true); };
  useEffect(() => {
    const refresh = () => refreshLookupRef.current();
    window.addEventListener('dictionary-settings-changed', refresh);
    return () => window.removeEventListener('dictionary-settings-changed', refresh);
  }, []);

  const translate = useCallback(async (text: string) => {
    translationAbort.current?.abort();
    const controller = new AbortController();
    translationAbort.current = controller;
    setSelection(null);
    window.getSelection()?.removeAllRanges();
    setTranslation({ text, loading: true, result: null, error: null });
    try {
      const result = await translateSelection(text, { signal: controller.signal, sourceLanguage: language });
      if (!controller.signal.aborted) setTranslation({ text, loading: false, result, error: null });
    } catch (error) {
      if (!controller.signal.aborted) setTranslation({ text, loading: false, result: null,
        error: error instanceof Error ? error.message : '翻译暂时不可用，请重试。' });
    }
  }, [language]);

  const consume = (action: (text: string) => void) => {
    if (!selection) return;
    const text = getWordCardSelection(content.current)?.text ?? selection.text;
    setSelection(null);
    window.getSelection()?.removeAllRanges();
    action(text);
  };
  const lookupText = useCallback((value: string, rect: DOMRect) => { void lookupWord(value, rect); }, [lookupWord]);
  const actions = useMemo(() => ({ lookup: lookupText, select }), [lookupText, select]);

  return <WordCardInteractionContext.Provider value={actions}>
    <div ref={content} className="word-card-interactions">
      {children}
      {translation && <div className="word-card-selected-translation" data-selection-translation="true">
        <p className="word-card-selected-translation__original" lang={language}>{translation.text}</p>
        <SelectionTranslationNote loading={translation.loading} result={translation.result} error={translation.error} scrollWithinCard
          onRetry={() => { void translate(translation.text); }} />
      </div>}
    </div>
    {selection && <WordCardSelectionActions selection={selection} scopes={scopes}
      onTranslate={() => consume(text => { void translate(text); })}
      onCopy={() => consume(text => { void navigator.clipboard?.writeText(text).catch(() => {}); })}
      onSpeak={() => consume(onSpeak)} onDismiss={() => consume(() => {})} />}
    {lookup && <ReadingLookupCard open selectedText={lookup.word} result={lookup.result} neutralResult={lookup.neutralResult} loading={lookup.loading}
      anchor={lookup.anchor} error={lookup.error} ancestorCardIds={scopes} returnTo={word}
      recordStatus={lookup.recordStatus} onRetryRecord={lookup.retryRecord}
      onRetry={() => { void lookupWord(lookup.word, lookup.anchor, true); }}
      onClose={() => { lookupAbort.current?.abort(); stopNestedSpeech(); setLookup(null); }}
      onSpeak={text => { nestedSpeechOwned.current = true; onSpeak(text); }}
      onStopSpeech={() => { stopSpeech.current?.(); nestedSpeechOwned.current = false; }}
      onLookupRelated={value => { void lookupWord(value, lookup.anchor); }} />}
  </WordCardInteractionContext.Provider>;
};

function WordCardSelectionActions({ selection, scopes, onTranslate, onCopy, onSpeak, onDismiss }: {
  selection: SelectionAction; scopes: string[]; onTranslate: () => void; onCopy: () => void; onSpeak: () => void; onDismiss: () => void;
}) {
  const toolbar = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 12, top: 12 });
  useLayoutEffect(() => {
    if (selection.touch) return;
    const rect = toolbar.current!.getBoundingClientRect();
    const below = selection.anchor.bottom + 6;
    setPosition({ left: Math.max(12, Math.min(selection.anchor.left, document.documentElement.clientWidth - rect.width - 12)),
      top: Math.max(12, Math.min(below + rect.height <= window.innerHeight - 12 ? below : selection.anchor.top - rect.height - 6, window.innerHeight - rect.height - 12)) });
  }, [selection]);
  return createPortal(<div ref={toolbar} role="toolbar" aria-label="词卡选中文本操作"
    className="reading-selection-actions word-card-selection-actions" data-word-card-scopes={scopes.join(' ')}
    data-touch-selection={selection.touch ? 'true' : undefined}
    style={{ ...(selection.touch ? {} : position), zIndex: 62 + (scopes.length - 1) * 10 }}
    onPointerDown={event => event.preventDefault()} onKeyDown={event => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); onDismiss(); }
      if (event.key === 'Tab') {
        const buttons = toolbar.current?.querySelectorAll<HTMLButtonElement>('button');
        const first = buttons?.[0]; const last = buttons?.[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
    <button type="button" onClick={onTranslate}>翻译</button>
    <button type="button" onClick={onCopy}>复制</button>
    <button type="button" aria-label="朗读词卡选中句子" onClick={onSpeak}><Volume2 size={14} aria-hidden="true" />朗读</button>
  </div>, document.body);
}
