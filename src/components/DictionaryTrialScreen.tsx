import { useEffect, useMemo, useRef, useState, type FC, type ReactNode } from 'react';
import { BookOpen, Search } from 'lucide-react';
import type { DictionaryEntry, DictionarySense, LookupResult, SourceCatalog } from '../../packages/dictionary/contracts';
import { createDictionaryClient } from '../../packages/dictionary/client';
import { frenchLanguageAdapter } from '../../packages/dictionary/languages/french';
import { japaneseLanguageAdapter } from '../../packages/dictionary/languages/japanese';
import { AppPageHeader } from './AppPageHeader';
import { DICTIONARY_TRIALS, languageName, type DictionaryTrialLanguage } from '../lib/dictionaryTrial';
import type { Article, TranslationResult } from '../types';
import { createImportedArticle } from '../lib/articleLanguage';
import { useSpeech } from '../lib/speech/useSpeech';
import { SpeechControls, SpeechFeedback } from './SpeechControls';
import { translateSelection } from '../lib/localTranslation';
import { observeReadingSelection } from '../lib/observeReadingSelection';
import { ReadingTouchSelection } from './ReadingTouchSelection';
import { ReadingSelectionToolbar } from './ReadingSelectionToolbar';
import { SelectionTranslationNote } from './SelectionTranslationNote';
import './dictionaryTrial.css';

const client = createDictionaryClient();
interface Props { language?: DictionaryTrialLanguage; onBack: () => void; onSettings: () => void; onImport?: (article: Article) => void; navigation?: ReactNode }

/** A real, language-neutral dictionary consumer, with no English learning-store dependencies. */
export const DictionaryTrialScreen: FC<Props> = ({ language = 'fr', onBack, onSettings, onImport, navigation }) => {
  const trial = DICTIONARY_TRIALS[language];
  const speech = useSpeech(language);
  const content = useRef<HTMLDivElement>(null);
  const translationController = useRef<AbortController | null>(null);
  const [selection, setSelection] = useState<{ text: string; anchor: { left: number; top: number; bottom: number } } | null>(null);
  const [translation, setTranslation] = useState<{ text: string; loading: boolean; result: TranslationResult | null; error: string | null } | null>(null);
  const adapter = language === 'ja' ? japaneseLanguageAdapter : frenchLanguageAdapter;
  const [text, setText] = useState<string>(trial.sample);
  const [draft, setDraft] = useState<string>(trial.sample);
  const [editing, setEditing] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState('');
  const [selectedOffset, setSelectedOffset] = useState<number | null>(null);
  const [catalog, setCatalog] = useState<SourceCatalog | null>(null);
  const [catalogError, setCatalogError] = useState(false);
  const [sourceId, setSourceId] = useState('');
  const [result, setResult] = useState<LookupResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const selectedContext = useRef('');
  const segments = useMemo(() => adapter.segment!(text), [adapter, text]);
  const captureSelection = () => {
    const selected = window.getSelection();
    const range = selected?.rangeCount ? selected.getRangeAt(0) : null;
    if (!range || selected!.isCollapsed || !content.current?.contains(range.startContainer) || !content.current.contains(range.endContainer)) {
      setSelection(null); return;
    }
    const rect = range.getBoundingClientRect();
    setSelection({ text: selected!.toString().trim(), anchor: { left: rect.left, top: rect.top, bottom: rect.bottom } });
  };
  useEffect(() => content.current ? observeReadingSelection(content.current, captureSelection) : undefined, []);
  useEffect(() => {
    translationController.current?.abort(); speech.stop(); setSelection(null); setTranslation(null);
    return () => { translationController.current?.abort(); speech.stop(); };
  }, [text, language, speech.stop]);
  const translate = async (value: string) => {
    translationController.current?.abort();
    const abort = new AbortController(); translationController.current = abort;
    setSelection(null); window.getSelection()?.removeAllRanges();
    setTranslation({ text: value, loading: true, result: null, error: null });
    try {
      const result = await translateSelection(value, { signal: abort.signal, sourceLanguage: language });
      if (!abort.signal.aborted) setTranslation({ text: value, loading: false, result, error: null });
    } catch (cause) {
      if (!abort.signal.aborted) setTranslation({ text: value, loading: false, result: null, error: cause instanceof Error ? cause.message : '翻译失败，请重试。' });
    }
  };
  const consumeSelection = (action: (text: string) => void) => {
    if (!selection) return;
    const value = selection.text; setSelection(null); window.getSelection()?.removeAllRanges(); action(value);
  };
  useEffect(() => {
    const abort = new AbortController();
    void client.listSources(abort.signal).then(setCatalog).catch(() => { if (!abort.signal.aborted) setCatalogError(true); });
    return () => { abort.abort(); controller.current?.abort(); };
  }, []);
  const languageSources = useMemo(() => catalog?.sources.filter(source => source.languages.some(tag => tag.split('-')[0] === language)) ?? [], [catalog, language]);
  const availableSources = languageSources.filter(source => source.enabled && source.available);
  const activeSource = availableSources.find(source => source.id === sourceId)
    ?? availableSources.find(source => source.definitionLanguages.some(language => language.split('-')[0] === 'zh'))
    ?? availableSources[0];
  const definitionLabel = (languages: readonly string[]) => languages.map(languageName).join('、') + '释义';
  const lookup = async (word: string, context = '', offset: number | null = null, dictionaryId = activeSource?.id) => {
    if (!word.trim()) return;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setSelected(word.trim()); setSelectedOffset(offset); selectedContext.current = context;
    setResult(null); setError(null);
    if (!dictionaryId || !availableSources.some(source => source.id === dictionaryId)) {
      setLoading(false); setError(`请先在词典设置中启用可用的${trial.languageName}词典。`); return;
    }
    setLoading(true);
    try {
      const response = await client.lookup({ text: word.trim(), language, context, dictionaryIds: [dictionaryId], preferredDefinitionLanguages: ['zh', language, 'en'] }, abort.signal);
      if (!abort.signal.aborted) setResult(response);
    } catch (cause) {
      if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : '查词失败，请重试。');
    } finally { if (!abort.signal.aborted) setLoading(false); }
  };
  return <div className="dictionary-trial-screen">
    <AppPageHeader onBack={onBack} navigation={navigation} showWordSearch={false} />
    <main className="dictionary-trial">
      <header className="dictionary-trial__heading">
        <div><p className="dictionary-trial__eyebrow">{trial.nativeName}</p><h1>{trial.languageName}试读</h1>
          <p>点击文章中的单词，试试词典的释义与词形查询。</p></div>
        <div className="dictionary-trial__heading-actions">{onImport && <button type="button" onClick={() => onImport(createImportedArticle(text,
          text === trial.sample ? trial.sampleTitle : trial.customTitle, language))}>导入书库并阅读</button>}
          <button type="button" onClick={onSettings}>词典设置</button></div>
      </header>
      <div className="dictionary-trial__sources">
        {activeSource ? <>
          <span><BookOpen size={15} aria-hidden="true" />{activeSource.name} · {definitionLabel(activeSource.definitionLanguages)}</span>
          {availableSources.length > 1 && <label className="dictionary-trial__source-select">释义语言
            <select aria-label="选择释义词典" value={activeSource.id} onChange={event => {
              const nextSourceId = event.target.value; setSourceId(nextSourceId);
              controller.current?.abort(); setLoading(false); setResult(null); setError(null);
              if (selected) void lookup(selected, selectedContext.current, selectedOffset, nextSourceId);
            }}>
              {availableSources.map(source => <option key={source.id} value={source.id}>{definitionLabel(source.definitionLanguages)}{
                availableSources.filter(other => definitionLabel(other.definitionLanguages) === definitionLabel(source.definitionLanguages)).length > 1 ? ` · ${source.name}` : ''
              }</option>)}
            </select>
          </label>}
        </> : <p role="status">{catalogError ? '词典暂时无法连接，请确认本地服务已启动。' : !catalog ? '正在连接词典…'
          : !languageSources.length ? `尚未安装${trial.languageName}词典。` : languageSources.some(source => source.available) ? `请在词典设置中启用${trial.languageName}词典。`
          : `已安装的${trial.languageName}词典暂时无法读取。`}<button type="button" onClick={onSettings}>查看词典</button></p>}
      </div>
      <div className="dictionary-trial__layout">
        <section className="dictionary-trial__article" aria-label={`${trial.languageName}试读文章`}>
          <div className="dictionary-trial__article-heading"><h2>{text === trial.sample ? trial.sampleTitle : trial.customTitle}</h2>
            <button type="button" onClick={() => { setDraft(text); setEditing(value => !value); }}>换一段文字</button></div>
          {editing && <form className="dictionary-trial__editor" onSubmit={event => {
            event.preventDefault(); controller.current?.abort(); setLoading(false);
            setText(draft); setEditing(false); setResult(null); setSelected(''); setSelectedOffset(null); setError(null);
          }}>
            <label htmlFor={`${language}-trial-text`}>粘贴{trial.languageName}文章</label>
            <textarea id={`${language}-trial-text`} lang={language} value={draft} maxLength={12_000} rows={7} onChange={event => setDraft(event.target.value)} />
            <div><button type="button" onClick={() => setEditing(false)}>取消</button><button type="submit" disabled={!draft.trim()}>开始试读</button></div>
          </form>}
          <div ref={content} className="dictionary-trial__text" lang={language} data-reading-paragraph="0">
            {segments.map(segment => segment.kind === 'term'
              ? <span key={segment.start} role="button" tabIndex={activeSource ? 0 : -1} data-trial-word={segment.text} data-trial-offset={segment.start}
                  aria-pressed={selectedOffset === segment.start} className={selectedOffset === segment.start ? 'is-selected' : ''} aria-disabled={!activeSource}
                  onKeyDown={event => { if (activeSource && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); void lookup(segment.text, text, segment.start); } }}
                  onClick={() => { if (activeSource && !window.getSelection()?.toString()) void lookup(segment.text, text.slice(Math.max(0, segment.start - 160), segment.end + 160), segment.start); }}>{segment.text}</span>
              : <span key={segment.start}>{segment.text}</span>)}
          </div>
          <ReadingTouchSelection contentRef={content} articleId={`trial:${language}:${text}`} disabled={editing}
            onSelectionStart={() => setSelection(null)} onSelectionChange={captureSelection} onGestureEnd={captureSelection} />
          <div className="dictionary-trial__heading-actions">
            <button type="button" onClick={() => speech.speak(text)}>朗读试读文章</button>
            {selected && <button type="button" onClick={() => speech.speak(selected)}>朗读查询词</button>}
            <SpeechControls preferences={speech.preferences} onChange={speech.setPreferences} language={language} />
          </div>
          {translation && <div data-selection-translation="true"><p lang={language}>{translation.text}</p>
            <SelectionTranslationNote {...translation} onRetry={() => { void translate(translation.text); }} /></div>}
          <p className="dictionary-trial__hint">{text === trial.sample ? trial.sampleHint : '点击文中的单词试试。'}{trial.morphologyHint}</p>
        </section>
        <aside className="dictionary-trial__lookup" aria-label={`${trial.languageName}查词`}>
          <form className="dictionary-trial__search" onSubmit={event => { event.preventDefault(); void lookup(query); }}>
            <label htmlFor={`${language}-trial-query`}>直接查词</label><div>
              <input id={`${language}-trial-query`} lang={language} value={query} maxLength={512} placeholder={trial.queryPlaceholder} onChange={event => setQuery(event.target.value)} />
              <button type="submit" aria-label={`查询${trial.languageName}单词`} disabled={!query.trim() || !activeSource}><Search size={18} aria-hidden="true" /></button>
            </div>
          </form>
          <div className="dictionary-trial__results" aria-live="polite" aria-busy={loading}>
            {loading ? <p role="status">正在查询 {selected}…</p> : error ? <div role="alert"><p>{error}</p><button type="button" onClick={() => void lookup(selected)}>重试</button></div>
              : result ? <>
                <p className="dictionary-trial__query">查询：<span lang={language}>{selected}</span></p>
                {result.status === 'not_found' && <p>当前词典未收录此词。</p>}
                {result.status === 'invalid_request' && <p role="alert">查询内容无效，请缩短文本后重试。</p>}
                {result.sources.map(source => <section key={source.dictionaryId} className="dictionary-trial__source-results">
                  <h3>{source.dictionaryName ?? source.dictionaryId}</h3>
                  {source.status === 'unavailable' && <p role="alert">此词典暂时无法读取。<button type="button" onClick={() => void lookup(selected)}>重试</button></p>}
                  {source.status === 'not_found' && result.status !== 'not_found' && <p>未收录</p>}
                  {source.matches.map(match => <TrialEntry key={match.entry.entryId} entry={match.entry} inflection={match.matchKind === 'inflection'} query={selected} />)}
                </section>)}
              </> : <p className="dictionary-trial__empty">{activeSource ? `点击文章中的单词，或在这里输入${trial.languageName}词。` : `连接并启用${trial.languageName}词典后即可查词。`}</p>}
          </div>
        </aside>
      </div>
      <p className="dictionary-trial__scope">试读使用独立的{trial.languageName}查询；本页暂不记录学习进度。现有英语阅读与复习记录照常使用。</p>
    </main>
    {selection && <ReadingSelectionToolbar anchor={selection.anchor} touchSelection={typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches}
      allowDiscussion={false} onExplain={() => {}} onDiscuss={() => {}}
      onTranslate={() => consumeSelection(value => { void translate(value); })}
      onLookup={() => consumeSelection(value => { void lookup(value); })}
      onCopy={() => consumeSelection(value => { void navigator.clipboard?.writeText(value).catch(() => {}); })}
      onSpeak={() => consumeSelection(speech.speak)} />}
    <SpeechFeedback state={speech.state} onStop={speech.stop} floating />
  </div>;
};

export const TrialEntry: FC<{ entry: DictionaryEntry; inflection: boolean; query: string }> = ({ entry, inflection, query }) => {
  const senses = entry.content.kind === 'structured' ? entry.content.senses : [];
  const morphology = entry.provenance.find(item => item.kind === 'morphology');
  const source = entry.provenance.find(item => {
    if (item.kind !== 'entry' || !item.detail) return false;
    try { const url = new URL(item.detail); return url.protocol === 'https:' && ['en.wiktionary.org', 'zh.wiktionary.org'].includes(url.hostname); }
    catch { return false; }
  })?.detail;
  return <article className="dictionary-trial__entry">
    <h4 lang={entry.language}>{entry.headword}</h4>
    {inflection && <p className="dictionary-trial__inflection"><span lang={entry.language}>{query}</span> → <span lang={entry.language}>{entry.headword}</span> · 词典词形匹配{morphology?.label && <small>{morphology.label}</small>}</p>}
    {!!entry.readings.length && <p className="dictionary-trial__pronunciation">{[...new Set(entry.readings.map(reading => reading.text))].slice(0, 3).join(' · ')}</p>}
    <ol>{senses.slice(0, 6).map(sense => <TrialSense key={sense.id} sense={sense} />)}</ol>
    {(senses.length > 6 || !!entry.forms?.length) && <details><summary>更多释义与词形</summary>
      {senses.length > 6 && <ol start={7}>{senses.slice(6).map(sense => <TrialSense key={sense.id} sense={sense} />)}</ol>}
      {entry.forms?.map((form, i) => <p key={i}><span lang={entry.language}>{form.text}</span>{form.label && <small>{form.label}</small>}</p>)}
    </details>}
    {source && <a href={source} target="_blank" rel="noreferrer">Wiktionary 原词条 ↗</a>}
  </article>;
};

const PART_OF_SPEECH_NAMES: Record<string, string> = {
  noun: '名词', verb: '动词', adj: '形容词', adjective: '形容词', adv: '副词', adverb: '副词',
  pron: '代词', pronoun: '代词', prep: '介词', preposition: '介词', article: '冠词',
  det: '限定词', determiner: '限定词', conj: '连词', conjunction: '连词',
  intj: '感叹词', interjection: '感叹词', name: '专有名词', proper_noun: '专有名词',
  num: '数词', numeral: '数词', phrase: '短语', prefix: '前缀', suffix: '后缀',
};

const TrialSense: FC<{ sense: DictionarySense }> = ({ sense }) => <li>
  {sense.partOfSpeech && <span className="dictionary-trial__pos">{PART_OF_SPEECH_NAMES[sense.partOfSpeech] ?? sense.partOfSpeech}</span>}
  {!!sense.labels?.length && <small>{sense.labels.join(' · ')}</small>}
  {sense.definitions.map((definition, i) => <p key={`definition-${i}`} lang={definition.language}>{definition.text}<small>{languageName(definition.language)}</small></p>)}
  {sense.translations.map((translation, i) => <p key={`translation-${i}`} lang={translation.language}>{translation.text}<small>{languageName(translation.language)}</small></p>)}
  {sense.examples.slice(0, 1).map(example => <blockquote key={example.id}>
    <p lang={example.text.language}>{example.text.text}</p>
    {example.translations?.map((translation, i) => <p key={i} lang={translation.language}>{translation.text}<small>{languageName(translation.language)}</small></p>)}
  </blockquote>)}
</li>;
