import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ArrowUpRight, Check, ChevronDown, Search } from 'lucide-react';
import type { GrammarExplanation } from '../types';
import type { ReadingStudyChapter, ReadingStudyItem, ReadingStudyWord } from '../lib/readingStudy';
import { findStudyWordContext } from '../lib/readingStudy';
import {
  getDictionaryChineseMeaning, lookupDictionaryWord, lookupDictionaryWords, toDictionaryWordCard,
  type DictionaryEntry,
} from '../lib/dictionaryClient';
import { useSpeech } from '../lib/speech/useSpeech';
import { AppPageHeader } from './AppPageHeader';
import { WordCardPanel } from './WordCardPanel';

interface ReadingStudyScreenProps {
  items: ReadingStudyItem[];
  selectedArticleId?: string;
  navigation?: React.ReactNode;
  onBack: () => void;
  onOverview: () => void;
  onSelectItem: (articleId: string) => void;
  onOpenArticle: (articleId: string) => void;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}

const secondaryButton = 'study-text-action';
const tabClass = (active: boolean) => `study-tab${active ? ' is-active' : ''}`;

export const ReadingStudyScreen: React.FC<ReadingStudyScreenProps> = ({
  items, selectedArticleId, navigation, onBack, onOverview, onSelectItem, onOpenArticle, loading, error, onRetry,
}) => {
  const [filter, setFilter] = useState<'completed' | 'all' | 'reading'>('completed');
  const selectedItem = selectedArticleId
    ? items.find(item => item.chapters.some(chapter => chapter.article.id === selectedArticleId))
    : undefined;
  // A book with completed chapters belongs here even while the rest is in progress.
  const filteredItems = items.filter(item => filter === 'all' || (filter === 'completed' ? item.completedCount > 0 : !item.completed));

  return (
    <div className="learning-screen reading-study min-h-screen bg-[#F8F6F0] text-[#2B2723] selection:bg-[#F3D7C7]">
      <AppPageHeader onBack={onBack} navigation={navigation} />
      <main className="study-shell safe-pb">
        <button type="button" onClick={selectedArticleId ? onBack : onOverview} className="study-back">
          <ArrowLeft size={14} aria-hidden="true" />{selectedArticleId ? '阅读记录' : '学习概览'}
        </button>
        {error && <div role="alert" className="study-notice">{error}<button type="button" onClick={onRetry} className={secondaryButton}>重试</button></div>}
        {selectedArticleId ? selectedItem ? (
          <StudyDetail key={selectedItem.id} item={selectedItem} onOpenArticle={onOpenArticle} loading={loading} />
        ) : (
          <div className="study-empty">
            {loading ? '加载中…' : '未找到阅读记录。'}
          </div>
        ) : (
          <>
            <header className="study-list-heading"><h1 className="study-title study-title--index">阅读记录</h1></header>
            <div className="study-tabs" role="group" aria-label="筛选阅读记录">
              {([['completed', '已完成'], ['reading', '阅读中'], ['all', '全部阅读']] as const).map(([value, label]) => (
                <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)} className={tabClass(filter === value)}>{label}</button>
              ))}
            </div>
            <ul className="study-reading-list" aria-label="文章与书籍">
              {filteredItems.map((item, index) => (
                <li key={item.id}>
                  <button type="button" onClick={() => onSelectItem(item.id)} aria-label={`查看${item.title}的学习详情`} className="study-reading-row">
                    <span className="study-number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
                    <div className="study-reading-row__body">
                      <h2>{item.title}</h2>
                      {item.kind !== 'article' && <p>第 {item.currentChapter.number} / {item.chapters.length} {item.unit}<span className="study-dot">·</span>已完成 {item.completedCount}/{item.chapters.length} {item.unit}</p>}
                      {item.kind === 'article' && filter === 'all' && <p>{item.completed ? '已读' : '在读'}</p>}
                    </div>
                    <span className="study-reading-row__count" aria-label={loading ? '生词加载中' : `${item.words.length} 个生词`}><span>{loading ? '—' : item.words.length}</span><small>生词</small></span>
                    <ArrowUpRight size={16} className="study-row-arrow" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
            {filteredItems.length === 0 && <p className="study-empty">{filter === 'completed' ? '还没有读完的文章。' : '还没有阅读记录。'}</p>}
          </>
        )}
      </main>
    </div>
  );
};

const StudyDetail: React.FC<{ item: ReadingStudyItem; onOpenArticle: (id: string) => void; loading: boolean }> = ({ item, onOpenArticle, loading }) => {
  const [chapterId, setChapterId] = useState(item.currentChapter.article.id);
  const [scope, setScope] = useState<'all' | 'chapter'>('all');
  const chapter = item.chapters.find(row => row.article.id === chapterId) ?? item.currentChapter;
  const isCollection = item.kind !== 'article';
  const allLabel = item.kind === 'book' ? '全书生词' : '全文生词';
  const chapterLabel = item.unit === '章' ? '本章生词' : item.unit === '页' ? '本页生词' : '本篇生词';
  const words = scope === 'chapter' ? chapter.words : item.words;

  return (
    <>
      <header className="study-detail-heading">
        <p className="study-status">{item.completed ? '已读' : '在读'}{isCollection && <><span className="study-dot">·</span>第 {item.currentChapter.number} / {item.chapters.length} {item.unit}</>}</p>
        <h1 className="study-title">{item.title}</h1>
        <div className="study-detail-actions">
          <button type="button" onClick={() => onOpenArticle(item.currentChapter.article.id)} aria-label={item.completed ? item.kind === 'article' ? '重读文章' : '重读书籍或文档' : '继续阅读'} className="study-read-action">{item.completed ? '再读一遍' : '继续阅读'}<ArrowRight size={16} aria-hidden="true" /></button>
          {isCollection && <span className="study-progress-caption">{item.completedCount} / {item.chapters.length} {item.unit}已读</span>}
        </div>
        {isCollection && <div className="study-progress" role="progressbar" aria-label="阅读进度" aria-valuenow={item.completedCount} aria-valuemin={0} aria-valuemax={item.chapters.length}><span style={{ width: `${item.completedCount / item.chapters.length * 100}%` }} /></div>}
      </header>

      {isCollection && <details className="study-chapters">
        <summary><span>{item.unit === '章' ? '章节进度' : item.unit === '页' ? '页面进度' : '分篇进度'}</span><ChevronDown size={16} aria-hidden="true" /></summary>
        <div className="study-chapter-list">
          {item.chapters.map(row => (
            <button type="button" key={row.article.id} aria-label={`第 ${row.number} ${item.unit}，${row.article.title}，${row.article.status === 'Completed' ? '已读' : row.started ? '在读' : '未读'}`} aria-pressed={scope === 'chapter' && chapterId === row.article.id} onClick={() => { setChapterId(row.article.id); setScope('chapter'); }} className="study-chapter-row">
              <span className="study-number">{String(row.number).padStart(2, '0')}</span>
              <span className="study-chapter-title">{row.article.title}</span>
              {row.article.status === 'Completed' ? <Check size={14} className="study-chapter-check" aria-hidden="true" /> : <span className="study-chapter-state">{row.started ? '在读' : '未读'}</span>}
              <span className="study-chapter-count">{loading ? '—' : row.words.length}<small> 生词</small></span>
            </button>
          ))}
        </div>
      </details>}

      <section className="study-vocabulary" aria-labelledby="study-vocabulary-heading">
        <div className="study-vocabulary-heading">
          <h2 id="study-vocabulary-heading">生词<span className="study-vocabulary-total">{loading ? '—' : words.length}</span></h2>
          {isCollection && <div className="study-scope" role="group" aria-label="生词范围">
            <button type="button" className={tabClass(scope === 'all')} aria-label={allLabel} aria-pressed={scope === 'all'} onClick={() => setScope('all')}>{item.kind === 'book' ? '全书' : '全文'}</button>
            <button type="button" className={tabClass(scope === 'chapter')} aria-label={chapterLabel} aria-pressed={scope === 'chapter'} onClick={() => setScope('chapter')}>第 {chapter.number} {item.unit}</button>
          </div>}
        </div>
        {scope === 'chapter' && isCollection && <div className="study-selected-chapter"><p>{chapter.article.title}</p><button type="button" onClick={() => onOpenArticle(chapter.article.id)} className={secondaryButton}>阅读<ArrowUpRight size={14} aria-hidden="true" /></button></div>}
        {loading ? <p role="status" className="study-empty">加载中…</p> : <StudyVocabulary key={scope === 'chapter' ? chapter.article.id : 'all'} words={words} chapters={scope === 'chapter' ? [chapter] : item.chapters} />}
      </section>
    </>
  );
};

const StudyVocabulary: React.FC<{ words: ReadingStudyWord[]; chapters: ReadingStudyChapter[] }> = ({ words, chapters }) => {
  const [query, setQuery] = useState('');
  const [visibleCount, setVisibleCount] = useState(24);
  const [entries, setEntries] = useState<Record<string, DictionaryEntry | null>>({});
  const cache = useRef<Record<string, DictionaryEntry | null>>({});
  const [dictionaryError, setDictionaryError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [card, setCard] = useState<{ query: string; loading: boolean; result: GrammarExplanation | null } | null>(null);
  const cardAbort = useRef<AbortController | null>(null);
  const failedWord = useRef<string | null>(null);
  const speech = useSpeech();
  const filteredWords = useMemo(() => words.filter(word => word.wordId.includes(query.trim().toLowerCase())), [words, query]);
  const visibleWords = useMemo(() => filteredWords.slice(0, visibleCount), [filteredWords, visibleCount]);

  useEffect(() => {
    const missing = visibleWords.filter(word => cache.current[word.wordId] === undefined);
    if (!missing.length) return;
    const controller = new AbortController();
    void lookupDictionaryWords(missing.map(word => word.wordId), { signal: controller.signal }).then(results => {
      if (controller.signal.aborted) return;
      missing.forEach((word, index) => { cache.current[word.wordId] = results[index]; });
      setEntries({ ...cache.current }); setDictionaryError(null);
    }).catch(() => {
      if (!controller.signal.aborted) setDictionaryError('释义暂未加载，可重试或点击生词单独查词。');
    });
    return () => controller.abort();
  }, [visibleWords, retryCount]);
  useEffect(() => () => cardAbort.current?.abort(), []);

  const closeCard = () => { cardAbort.current?.abort(); speech.stop(); setCard(null); };
  const openWord = async (queryWord: string) => {
    cardAbort.current?.abort(); speech.stop();
    const controller = new AbortController(); cardAbort.current = controller;
    setCard({ query: queryWord, loading: true, result: null });
    try {
      const entry = cache.current[queryWord] !== undefined ? cache.current[queryWord] : await lookupDictionaryWord(queryWord, { signal: controller.signal });
      if (controller.signal.aborted) return;
      const word = words.find(row => row.wordId === queryWord);
      const context = word ? findStudyWordContext(word, chapters) : null;
      const result: GrammarExplanation = entry ? toDictionaryWordCard(entry) : {
        wordOrPhrase: queryWord, type: '', definition: '词典暂未收录这个词，可结合阅读原句理解。', grammarRules: [], exampleSentences: [],
      };
      setCard({ query: queryWord, loading: false, result: { ...result, readingOriginalSentence: context?.sentence } });
      failedWord.current = null;
      setDictionaryError(null);
    } catch {
      if (!controller.signal.aborted) { failedWord.current = queryWord; setCard(null); setDictionaryError('查词暂不可用，请重试。'); }
    }
  };

  return (
    <>
      {words.length > 8 && <label className="study-word-search"><Search size={14} aria-hidden="true" /><span className="sr-only">搜索英文生词</span><input type="search" value={query} onChange={event => { setQuery(event.target.value); setVisibleCount(24); }} placeholder="查找生词" /></label>}
      {dictionaryError && <p role="alert" className="study-notice">{dictionaryError}<button type="button" onClick={() => failedWord.current ? void openWord(failedWord.current) : setRetryCount(count => count + 1)} className={secondaryButton}>重试</button></p>}
      {words.length === 0 ? <p className="study-empty">暂无查词记录</p> : filteredWords.length === 0 ? <p className="study-empty">没有匹配的生词。</p> : <ul className="study-word-list" aria-label="生词列表">
        {visibleWords.map(word => {
          const entry = entries[word.wordId];
          return <li key={word.wordId}><button type="button" onClick={() => void openWord(word.wordId)} aria-label={`查看生词 ${word.wordId}`} className="study-word-row">
            <div><span className="study-word">{word.wordId}</span><p className="study-word-meaning">{entry ? getDictionaryChineseMeaning(entry) || entry.definitionEn : entry === null ? '查看原句' : ' '}</p></div>
            <ArrowUpRight size={16} className="study-row-arrow" aria-hidden="true" />
          </button></li>;
        })}
      </ul>}
      {filteredWords.length > visibleCount && <button type="button" className={`${secondaryButton} w-full`} onClick={() => setVisibleCount(count => count + 24)}>显示更多生词（还有 {filteredWords.length - visibleCount} 个）</button>}
      {speech.state.error && <p role="alert" className="text-xs text-[#A94E2B]">{speech.state.error}</p>}
      <WordCardPanel open={Boolean(card)} loading={card?.loading ?? false} result={card?.result ?? null} selectedText={card?.query ?? ''} onClose={closeCard} onSpeak={speech.speak} onLookupRelated={word => void openWord(word)} />
    </>
  );
};
