import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeft,
  MoreHorizontal,
  BookOpen,
  Globe,
  MessageCircle,
  Send,
  Sparkles,
  CheckCircle2,
  X,
  Volume2,
  PenLine,
} from 'lucide-react';
import {
  Article,
  GrammarExplanation,
  TranslationResult,
  StructuredAssessResult,
  ChatMessage,
  ReadingAdvancePayload,
  ReadingMode,
} from '../types';

import {
  extractLearningUnits,
  findLearningUnitAtTokenIndex,
  getMinimumExposureDwellMs,
  hasSufficientExposureVisibility,
  limitConcurrentExposureCandidates,
  shouldAdvanceRecommendationAtScrollEnd,
} from '../lib/readingExposure';
import { getPhraseHighlightMatches } from '../lib/textHighlight';
import { postTutor } from '../lib/tutorClient';
import type { ImportJob } from '../lib/articleImport';
import { needsImportEnrichment } from '../lib/articleImport';
import { classifyArticleParagraph, getArticleInlineParts } from '../lib/articlePresentation';
import {
  buildReadingAdvancePayload,
  hasArticleExitedViewport,
  isLeftSwipeGesture,
  selectCurrentContinuousArticleId,
} from '../lib/continuousReading';
import { useMemoryV2Integration } from '../lib/memoryV2Integration';
import { createWordCardRequest, fetchWordCard } from '../lib/wordCard';
import { formatSelectionQuote } from '../lib/readingSelection';
import { WordCardPanel } from './WordCardPanel';
import { ReadAgeBrand } from './ReadAgeBrand';
import {
  emitVocabArticleComplete,
  startVocabSession,
  toVocabSnapshot,
} from '../lib/vocabTelemetry';

let recommendationNavigationHintShown = false;

const REWRITE_CEFR_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] as const;

export function getArticleHighlightTerms(readingArticle?: Article): string[] {
  if (
    !readingArticle
    || readingArticle.source === 'level_rewrite'
    || readingArticle.generationKind === 'level-rewrite'
  ) return [];
  return [
    ...(readingArticle.keyWords || []),
    ...(readingArticle.embeddedReviewWords || []),
  ];
}

function getArticleReviewWords(readingArticle: Article): string[] {
  if (readingArticle.source === 'level_rewrite') return [];
  return Array.from(
    new Set((readingArticle.embeddedReviewWords || []).map((word) => word.trim()).filter(Boolean)),
  );
}

interface ReadingScreenProps {
  article: Article;
  /** App-level navigation rendered in place of the article title header. */
  navigation?: React.ReactNode;
  /** Live job from the independent import module (translate + rate). */
  importJob?: ImportJob | null;
  onRetryImport?: () => void;
  /** CEFR level rewrite in progress (parent). */
  isRewriting?: boolean;
  /** Generate a new article version at the chosen CEFR level. */
  onRewriteAtLevel?: (level: string) => void;
  /** User reading level from English test — highlight preferred rewrite target. */
  preferredCefrLevel?: string;
  /** Open the parent article this rewrite was based on. */
  onOpenParentArticle?: () => void;
  onBack: () => void;
  onWordClick?: (word: string, articleId?: string) => void;
  onGrammarQuery?: (wordOrPhrase: string, articleId?: string) => void;
  onExposures?: (words: string[]) => void;
  onReadingComplete?: () => void;
  mode?: ReadingMode;
  /** Articles rendered as one continuous recommendation reading stream. */
  continuousArticles?: Article[];
  onAdvance?: (payload: ReadingAdvancePayload) => void;
  /** Structured discussion assessment -> production updates. */
  onDiscussionAssessed?: (text: string, result: StructuredAssessResult) => void;
  initialChatMessages?: ChatMessage[];
  trackedLemmas?: string[];
  onChatMessagesChange?: (messages: ChatMessage[]) => void;
}

export const ReadingScreen: React.FC<ReadingScreenProps> = ({
  article,
  navigation,
  importJob = null,
  onRetryImport,
  isRewriting = false,
  onRewriteAtLevel,
  preferredCefrLevel,
  onOpenParentArticle,
  onBack,
  onWordClick,
  onGrammarQuery,
  onExposures,
  onReadingComplete,
  mode = 'single',
  continuousArticles,
  onAdvance,
  onDiscussionAssessed,
  initialChatMessages = [],
  trackedLemmas = [],
  onChatMessagesChange,
}) => {
  const [selectedText, setSelectedText] = useState<string>('');
  const [selectedContext, setSelectedContext] = useState<string>('');
  const [showRewriteLevels, setShowRewriteLevels] = useState(false);

  const [isExplaining, setIsExplaining] = useState(false);
  const [grammarResult, setGrammarResult] = useState<GrammarExplanation | null>(null);
  const [wordCardOpen, setWordCardOpen] = useState(false);

  const [isTranslating, setIsTranslating] = useState(false);
  const [translationResult, setTranslationResult] = useState<TranslationResult | null>(null);

  const [addedWordSuccess, setAddedWordSuccess] = useState<string | null>(null);
  const [copyHint, setCopyHint] = useState<string | null>(null);

  const [userInput, setUserInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(initialChatMessages);
  const [showChatPanel, setShowChatPanel] = useState(initialChatMessages.length > 0);
  const [isComposerExpanded, setIsComposerExpanded] = useState(false);
  const composerInputRef = useRef<HTMLInputElement>(null);
  const [articleVisible, setArticleVisible] = useState(false);
  const [showNavigationHint, setShowNavigationHint] = useState(false);

  // Memory V2.2 集成
  const { recordParagraphExposure, recordWordClick, snapshotWords } = useMemoryV2Integration(
    article.id,
    { isRecommendation: mode === 'recommendation-feed' },
  );
  const snapshotWordsRef = useRef(snapshotWords);
  useEffect(() => {
    snapshotWordsRef.current = snapshotWords;
  }, [snapshotWords]);

  // Restore chat when switching articles / session
  useEffect(() => {
    setChatMessages(initialChatMessages);
    setShowChatPanel(initialChatMessages.length > 0);
    setIsComposerExpanded(false);
    setWordCardOpen(false);
    setGrammarResult(null);
    setIsExplaining(false);
    // Real vocab particle session for this article (due/tracked lemmas if known)
    const dueWords = (trackedLemmas || []).slice(0, 40).map((wordId) => toVocabSnapshot(wordId, null));
    startVocabSession({ articleId: article.id, dueWords });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [article.id]);

  useEffect(() => {
    if (isComposerExpanded) composerInputRef.current?.focus({ preventScroll: true });
  }, [isComposerExpanded]);

  const [showMenu, setShowMenu] = useState(false);
  const [fontSize, setFontSize] = useState<'normal' | 'large' | 'xlarge'>('normal');
  /** Show Chinese paragraph translations produced on import. */
  const [showParagraphTranslations, setShowParagraphTranslations] = useState(false);
  const [showLevelDetail, setShowLevelDetail] = useState(false);

  const contentRef = useRef<HTMLDivElement>(null);
  const wordCardAbortRef = useRef<AbortController | null>(null);
  /** Staged lemmas per article id for continuous-stream completion payloads. */
  const exposedLemmasByArticleRef = useRef(new Map<string, Set<string>>());
  const onExposuresRef = useRef(onExposures);
  const onReadingCompleteRef = useRef(onReadingComplete);
  const onAdvanceRef = useRef(onAdvance);
  const hasAdvancedRef = useRef(false);
  const suppressNextWordClickRef = useRef(false);
  const swipeStartRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const touchSwipeStartRef = useRef<{ identifier: number; x: number; y: number } | null>(null);
  const pendingSwipeScrollArticleIdRef = useRef<string | null>(null);
  const completedContinuousArticleIdsRef = useRef(new Set<string>());
  const continuousArticlesRef = useRef(continuousArticles);
  const primaryArticleRef = useRef(article);
  const exposureObserveNewRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    continuousArticlesRef.current = continuousArticles;
  }, [continuousArticles]);

  useEffect(() => {
    primaryArticleRef.current = article;
  }, [article]);

  useEffect(() => {
    return () => {
      wordCardAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    onExposuresRef.current = onExposures;
  }, [onExposures]);

  useEffect(() => {
    onReadingCompleteRef.current = onReadingComplete;
  }, [onReadingComplete]);

  useEffect(() => {
    onAdvanceRef.current = onAdvance;
  }, [onAdvance]);

  useEffect(() => {
    hasAdvancedRef.current = false;
    exposedLemmasByArticleRef.current = new Map();
    completedContinuousArticleIdsRef.current.clear();
    setArticleVisible(false);
    const frame = window.requestAnimationFrame(() => {
      window.scrollTo({ top: 0, behavior: 'auto' });
      setArticleVisible(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [article.id]);

  useEffect(() => {
    if (mode !== 'recommendation-feed' || recommendationNavigationHintShown) return;
    recommendationNavigationHintShown = true;
    setShowNavigationHint(true);
  }, [mode]);

  useEffect(() => {
    if (!showNavigationHint) return;
    const timer = window.setTimeout(() => setShowNavigationHint(false), 2600);
    return () => window.clearTimeout(timer);
  }, [showNavigationHint]);

  const stagedExposuresFor = (articleId: string): Set<string> => {
    let staged = exposedLemmasByArticleRef.current.get(articleId);
    if (!staged) {
      staged = new Set();
      exposedLemmasByArticleRef.current.set(articleId, staged);
    }
    return staged;
  };

  // A paragraph counts as read only after it stays at least 60% visible for 800ms.
  useEffect(() => {
    const container = contentRef.current;
    if (!container || typeof IntersectionObserver === 'undefined') return;

    let isActive = true;
    const visibleParagraphs = new Set<Element>();
    const completedParagraphs = new Set<Element>();
    const observedParagraphs = new Set<Element>();
    const exposureTimers = new Map<Element, number>();
    exposedLemmasByArticleRef.current = new Map();

    const clearExposureTimer = (paragraph: Element) => {
      const timerId = exposureTimers.get(paragraph);
      if (timerId === undefined) return;
      window.clearTimeout(timerId);
      exposureTimers.delete(paragraph);
    };

    const finishSingleReading = () => {
      if (!isActive || hasAdvancedRef.current || mode === 'recommendation-feed') return;
      hasAdvancedRef.current = true;
      const exposed = [...(exposedLemmasByArticleRef.current.get(article.id) ?? new Set<string>())];
      void snapshotWordsRef.current(exposed).then((words) => {
        emitVocabArticleComplete({
          articleId: article.id,
          exposedLemmas: exposed,
          words,
        });
      });
      onReadingCompleteRef.current?.();
    };

    let scheduleVisibleExposureTimers: () => void = () => {};

    const scheduleExposureTimer = (paragraph: Element) => {
      if (
        !isActive
        || !visibleParagraphs.has(paragraph)
        || completedParagraphs.has(paragraph)
        || exposureTimers.has(paragraph)
      ) return;

      const minimumDwellTimeMs = getMinimumExposureDwellMs(paragraph.textContent ?? '');
      const timerId = window.setTimeout(() => {
        exposureTimers.delete(paragraph);
        if (
          !isActive
          || document.visibilityState !== 'visible'
          || !visibleParagraphs.has(paragraph)
        ) {
          scheduleVisibleExposureTimers();
          return;
        }

        const primary = primaryArticleRef.current;
        const paragraphElement = paragraph as HTMLElement;
        const paragraphIndex = Number(paragraphElement.dataset.readingParagraph);
        const paragraphArticleId = paragraphElement.dataset.readingArticleId || primary.id;
        const paragraphArticle = paragraphArticleId === primary.id
          ? primary
          : continuousArticlesRef.current?.find((candidate) => candidate.id === paragraphArticleId);
        const paragraphText = paragraphArticle?.content[paragraphIndex]
          ?? paragraphElement.textContent
          ?? '';
        const articleHighlightTerms = getArticleHighlightTerms(paragraphArticle);
        const learningUnits = extractLearningUnits(paragraphText, articleHighlightTerms);
        const staged = stagedExposuresFor(paragraphArticleId);
        const newWordIds = [...new Set(
          learningUnits.map((unit) => unit.wordId),
        )].filter((wordId) => !staged.has(wordId));

        newWordIds.forEach((wordId) => staged.add(wordId));
        completedParagraphs.add(paragraph);
        observer.unobserve(paragraph);
        visibleParagraphs.delete(paragraph);
        scheduleVisibleExposureTimers();

        // Memory V2.2: record for every article in the continuous stream
        if (learningUnits.length > 0) {
          const wordCount = paragraphText.trim().split(/\s+/).filter(Boolean).length;
          recordParagraphExposure(paragraphIndex, learningUnits, paragraphArticleId, {
            contextText: paragraphText.slice(0, 2_000),
            dwellTimeMs: minimumDwellTimeMs,
            expectedDwellTimeMs: Math.max(300, wordCount * 300),
          }).catch(err =>
            console.error('Memory V2.2 exposure recording failed:', err)
          );
        }

        if (newWordIds.length > 0 && mode === 'single') {
          onExposuresRef.current?.(newWordIds);
        }
        if (mode === 'single') {
          const paragraphCount = container.querySelectorAll('[data-reading-paragraph]').length;
          if (paragraphCount > 0 && completedParagraphs.size === paragraphCount) {
            finishSingleReading();
          }
        }
      }, minimumDwellTimeMs);

      exposureTimers.set(paragraph, timerId);
    };

    scheduleVisibleExposureTimers = () => {
      const candidates: Element[] = [];
      container.querySelectorAll('[data-reading-paragraph]').forEach((paragraph) => {
        const element = paragraph as Element;
        if (visibleParagraphs.has(element) && !completedParagraphs.has(element)) {
          candidates.push(element);
        }
      });

      limitConcurrentExposureCandidates(candidates, exposureTimers.size)
        .forEach(scheduleExposureTimer);
    };

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!isActive) return;

          const paragraph = entry.target as HTMLElement;
          const isSufficientlyVisible =
            document.visibilityState === 'visible'
            && entry.isIntersecting
            && hasSufficientExposureVisibility(
              entry.intersectionRect.height,
              entry.boundingClientRect.height,
              window.innerHeight,
            );

          if (!isSufficientlyVisible) {
            visibleParagraphs.delete(paragraph);
            clearExposureTimer(paragraph);
            scheduleVisibleExposureTimers();
            return;
          }

          visibleParagraphs.add(paragraph);
          scheduleVisibleExposureTimers();
        });
      },
      { threshold: Array.from({ length: 101 }, (_, index) => index / 100) },
    );

    const observeNewParagraphs = () => {
      if (!isActive) return;
      const paragraphs = Array.from(
        container.querySelectorAll('[data-reading-paragraph]')
      ) as HTMLElement[];
      for (const paragraph of paragraphs) {
        if (completedParagraphs.has(paragraph) || observedParagraphs.has(paragraph)) continue;
        observedParagraphs.add(paragraph);
        observer.observe(paragraph);
      }
    };

    exposureObserveNewRef.current = observeNewParagraphs;
    observeNewParagraphs();

    const pauseExposureTracking = () => {
      exposureTimers.forEach((timerId) => window.clearTimeout(timerId));
      exposureTimers.clear();
      visibleParagraphs.clear();
    };

    const handleVisibilityChange = () => {
      pauseExposureTracking();
      if (document.visibilityState !== 'visible') return;
      observedParagraphs.forEach((paragraph) => {
        if (completedParagraphs.has(paragraph)) return;
        observer.unobserve(paragraph);
        observer.observe(paragraph);
      });
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      isActive = false;
      exposureObserveNewRef.current = null;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      observer.disconnect();
      pauseExposureTracking();
      completedParagraphs.clear();
      observedParagraphs.clear();
    };
    // The exposure set intentionally resets only when the article lifecycle changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [article.id, mode]);

  // When continuous articles are appended, observe their new paragraphs without
  // resetting exposure progress for articles already on screen.
  useEffect(() => {
    if (mode !== 'recommendation-feed') return;
    const frame = window.requestAnimationFrame(() => {
      exposureObserveNewRef.current?.();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [mode, continuousArticles]);

  useEffect(() => {
    const skippedArticleId = pendingSwipeScrollArticleIdRef.current;
    if (!skippedArticleId) return;
    const sections: HTMLElement[] = contentRef.current
      ? Array.from(contentRef.current.querySelectorAll<HTMLElement>('[data-reading-article-section]'))
      : [];
    const skippedIndex = sections.findIndex(
      (section) => section.dataset.readingArticleId === skippedArticleId,
    );
    const nextSection = skippedIndex >= 0 ? sections[skippedIndex + 1] : undefined;
    if (!nextSection) return;
    pendingSwipeScrollArticleIdRef.current = null;
    nextSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [continuousArticles]);

  // Recommendation pages advance when the last paragraph fully leaves the viewport.
  // Paragraph visibility still records exposure, but never advances before that.
  useEffect(() => {
    if (mode !== 'recommendation-feed') return;

    let ticking = false;
    const checkScrollEnd = () => {
      ticking = false;
      if (document.visibilityState !== 'visible') return;
      const sections = contentRef.current?.querySelectorAll<HTMLElement>('[data-reading-article-section]');
      if (!sections) return;
      let completedOne = false;
      sections.forEach((section) => {
        if (completedOne) return;
        const articleId = section.dataset.readingArticleId;
        if (!articleId || completedContinuousArticleIdsRef.current.has(articleId)) return;
        const lastParagraph = section.querySelector('[data-reading-last-paragraph="true"]') as HTMLElement | null;
        if (!lastParagraph) return;
        const documentHeight = Math.max(
          document.documentElement.scrollHeight,
          document.body?.scrollHeight ?? 0,
        );
        const lastParagraphBottom = lastParagraph.getBoundingClientRect().bottom;
        const canAdvance = window.innerWidth >= 768
          ? shouldAdvanceRecommendationAtScrollEnd(
            lastParagraphBottom,
            window.scrollY,
            window.innerHeight,
            documentHeight,
          )
          : hasArticleExitedViewport(lastParagraphBottom);
        if (!canAdvance) return;
        completedContinuousArticleIdsRef.current.add(articleId);
        completedOne = true;
        const exposed = exposedLemmasByArticleRef.current.get(articleId) ?? new Set<string>();
        const exposedList = [...exposed];
        void snapshotWordsRef.current(exposedList).then((words) => {
          emitVocabArticleComplete({
            articleId,
            exposedLemmas: exposedList,
            words,
          });
        });
        onAdvanceRef.current?.(
          buildReadingAdvancePayload(articleId, 'completed', exposed)
        );
      });
    };
    const handleScroll = () => {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(checkScrollEnd);
    };

    // Capture catches browsers that dispatch scrolling on the document's
    // scrolling element instead of window. touchend covers short final drags.
    document.addEventListener('scroll', handleScroll, { passive: true, capture: true });
    window.addEventListener('scroll', handleScroll, { passive: true });
    window.addEventListener('wheel', handleScroll, { passive: true });
    window.addEventListener('touchend', handleScroll, { passive: true });
    // Re-check after continuousArticles append in case the previous article already left.
    window.requestAnimationFrame(checkScrollEnd);
    return () => {
      document.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('scroll', handleScroll);
      window.removeEventListener('wheel', handleScroll);
      window.removeEventListener('touchend', handleScroll);
    };
  }, [article.id, mode, continuousArticles]);

  const highlightTerms = getArticleHighlightTerms(article);
  const reviewWords = getArticleReviewWords(article);
  const currentLastParagraphIndex = article.content.reduce(
    (lastIndex, paragraph, index) =>
      classifyArticleParagraph(paragraph, article.title) === 'furniture' ? lastIndex : index,
    -1,
  );
  const continuationArticleList = mode === 'recommendation-feed'
    ? (continuousArticles || []).filter((candidate) => candidate.id !== article.id)
    : [];

  const closeWordCard = useCallback(() => {
    wordCardAbortRef.current?.abort();
    wordCardAbortRef.current = null;
    setWordCardOpen(false);
    setIsExplaining(false);
    setGrammarResult(null);
  }, []);

  const openWordCard = useCallback(
    async (wordOrPhrase: string, contextSentence = '', contextArticle: Article = article) => {
      const request = createWordCardRequest(wordOrPhrase, contextSentence);
      if (!request) return;

      wordCardAbortRef.current?.abort();
      const controller = new AbortController();
      wordCardAbortRef.current = controller;

      setSelectedText(request.selectedText);
      setSelectedContext(request.contextSentence);
      setWordCardOpen(true);
      setIsExplaining(true);
      setGrammarResult(null);
      onGrammarQuery?.(request.selectedText, contextArticle.id);

      try {
        const result = await fetchWordCard(request, {
          articleId: contextArticle.id,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setGrammarResult(result);
      } catch (error) {
        if (error instanceof Error && /cancelled|abort/i.test(error.message)) return;
        // fetchWordCard already falls back offline; keep panel open on unexpected errors.
      } finally {
        if (!controller.signal.aborted) {
          setIsExplaining(false);
        }
      }
    },
    [article, onGrammarQuery],
  );

  const handleWordClick = (
    word: string,
    paragraph: string,
    tokenIndex: number,
    e: React.MouseEvent,
    readingArticle: Article = article,
    readingHighlightTerms: string[] = highlightTerms,
  ) => {
    // Right-click is reserved for copy-and-quote; never open a word card from it.
    if (e.button !== 0 && e.nativeEvent.button !== 0) return;
    if (suppressNextWordClickRef.current) {
      suppressNextWordClickRef.current = false;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    e.stopPropagation();
    const request = createWordCardRequest(word, paragraph);
    if (!request) return;
    const cleanWord = request.selectedText;

    onWordClick?.(cleanWord, readingArticle.id);

    // Memory V2.2: record clicks for any article in the continuous stream
    const paragraphElement = (e.target as HTMLElement).closest('[data-reading-paragraph]');
    const learningUnit = findLearningUnitAtTokenIndex(
      paragraph,
      readingHighlightTerms,
      tokenIndex,
    );
    if (paragraphElement && learningUnit) {
      const paragraphIndex = Number(paragraphElement.getAttribute('data-reading-paragraph'));

      recordWordClick(learningUnit, paragraphIndex, readingArticle.id, {
        contextText: paragraph.slice(0, 2_000),
      }).catch(err =>
        console.error('Memory V2.2 click recording failed:', err)
      );
    }

    void openWordCard(cleanWord, paragraph, readingArticle);
  };

  const copyTextToClipboard = async (text: string): Promise<boolean> => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // fall through to execCommand
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  };

  const flashCopyHint = (label: string) => {
    setCopyHint(label);
    window.setTimeout(() => setCopyHint(null), 1600);
  };

  const isArticleSelection = (selection: Selection | null): selection is Selection => {
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
    if (!contentRef.current) return false;
    return contentRef.current.contains(selection.getRangeAt(0).commonAncestorContainer);
  };

  const quoteSelectedText = (text: string) => {
    setUserInput((currentInput) => formatSelectionQuote(text, currentInput));
    setShowChatPanel(true);
    setIsComposerExpanded(true);
    void copyTextToClipboard(text).then((ok) => {
      flashCopyHint(ok ? '已复制并引用到讨论框' : '复制失败，但已引用到讨论框');
    });
  };

  /** Left-button drag selection copies the source text and quotes it in discussion. */
  const handleTextSelection = (e: React.MouseEvent) => {
    const button = e.button ?? e.nativeEvent.button;
    if (button !== 0) return;

    const selection = window.getSelection();
    if (!isArticleSelection(selection)) return;

    const text = selection.toString().trim();
    // Ignore pure click noise; require a real selection (phrase/sentence)
    if (text.length < 2 || text.length > 4000) return;

    quoteSelectedText(text);
  };

  /** Look up a related word from the word-card panel (word-family chips). */
  const handleExplainWord = (word: string) => {
    void openWordCard(word, selectedContext || '');
  };

  const handleTranslate = async () => {
    const text = selectedText || grammarResult?.wordOrPhrase;
    if (!text) return;
    setIsTranslating(true);
    setTranslationResult(null);

    try {
      const response = await postTutor<TranslationResult>({
        intent: 'translate',
        articleId: article.id,
        selectedText: text,
        targetLanguage: 'Chinese',
      });
      setTranslationResult(response.result);
    } catch {
      setTranslationResult({
        originalText: text,
        translatedText: '当前为离线模式，请配置 API Key 后重试。',
        targetLanguage: 'Chinese',
      });
    } finally {
      setIsTranslating(false);
    }
  };

  const handleSendQuestion = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!userInput.trim() || isSending) return;

    const query = userInput.trim();
    const userMessage: ChatMessage = {
      id: `chat-${Date.now()}-user`,
      sender: 'user',
      text: query,
      timestamp: new Date().toISOString(),
    };
    setUserInput('');
    setShowChatPanel(true);
    const withUser = [...chatMessages, userMessage];
    setChatMessages(withUser);
    onChatMessagesChange?.(withUser);
    setIsSending(true);

    try {
      const response = await postTutor<StructuredAssessResult>({
        intent: 'discuss',
        articleId: article.id,
        message: query,
        articleContext: article.content.join('\n\n'),
        history: chatMessages.slice(-12),
      });
      const assessed = response.result;
      onDiscussionAssessed?.(query, assessed);

      // Socratic discussion: show tutor reply only — no error/score chrome
      const aiMessage: ChatMessage = {
        id: `chat-${Date.now()}-ai`,
        sender: 'ai',
        text: assessed.reply || '…',
        timestamp: new Date().toISOString(),
      };
      const withAi = [...withUser, aiMessage];
      setChatMessages(withAi);
      onChatMessagesChange?.(withAi);
    } catch {
      const assessed: StructuredAssessResult = {
        reply:
          '离线模式：先不看答案——用一句话概括作者最想说的一点。你觉得文中哪一句最能支撑你的概括？',
        errors: [],
        wordsUsedCorrectly: [],
        wordsUsedIncorrectly: [],
        weakPoints: [],
      };
      onDiscussionAssessed?.(query, assessed);
      const aiMessage: ChatMessage = {
        id: `chat-${Date.now()}-ai`,
        sender: 'ai',
        text: assessed.reply,
        timestamp: new Date().toISOString(),
      };
      const withAi = [...withUser, aiMessage];
      setChatMessages(withAi);
      onChatMessagesChange?.(withAi);
    } finally {
      setIsSending(false);
    }
  };

  const handleSpeakText = (text: string) => {
    if ('speechSynthesis' in window) {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'en-US';
      window.speechSynthesis.speak(utterance);
    }
  };

  const getFontSizeClass = () => {
    // Mobile-first: slightly larger base for readability; sm+ keeps prior scale.
    if (fontSize === 'large') return 'text-[1.2rem] leading-[1.75] sm:text-xl sm:leading-relaxed';
    if (fontSize === 'xlarge') return 'text-[1.35rem] leading-[1.8] sm:text-2xl sm:leading-loose';
    return 'text-[1.05rem] leading-[1.75] sm:text-lg sm:leading-relaxed';
  };

  const renderInteractiveParagraph = (
    paragraph: string,
    readingArticle: Article,
    readingHighlightTerms: string[],
  ): React.ReactNode => {
    const sourceTokens = paragraph.trim().split(/\s+/).filter(Boolean);
    const highlightMatches = getPhraseHighlightMatches(sourceTokens, readingHighlightTerms);
    let tokenIndex = 0;

    return getArticleInlineParts(paragraph).map((part, partIndex) => {
      if (part.type === 'link') {
        tokenIndex += Math.max(1, part.value.trim().split(/\s+/).filter(Boolean).length);
        return (
          <a
            key={`link-${partIndex}`}
            href={part.href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[#A94E2B] underline decoration-[#D7A28F] underline-offset-4 hover:text-[#7E351C] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#C35E37]"
          >
            {part.value}
          </a>
        );
      }

      return part.value.split(/(\s+)/).map((piece, pieceIndex) => {
        if (/^\s+$/.test(piece)) return piece;

        const currentTokenIndex = tokenIndex;
        // Link punctuation is split into its own text part, but shares the URL token index.
        if (!/^[\p{P}\p{S}]+$/u.test(piece)) tokenIndex += 1;
        const matchedTerm = highlightMatches[currentTokenIndex];
        return (
          <span
            key={`text-${partIndex}-${pieceIndex}`}
            onClick={(event) => handleWordClick(
              matchedTerm || piece,
              paragraph,
              currentTokenIndex,
              event,
              readingArticle,
              readingHighlightTerms,
            )}
            className={
              matchedTerm
                ? 'bg-[#FEF08A] hover:bg-[#FDE047] text-[#1E1B18] px-1 py-0.5 rounded transition-all cursor-pointer inline-block font-medium border-b border-[#EAB308]'
                : 'hover:bg-[#EFECE3] rounded px-0.5 transition-colors cursor-pointer'
            }
            title={matchedTerm ? `Review phrase: ${matchedTerm}` : 'Click to look up'}
          >
            {piece}
          </span>
        );
      });
    });
  };

  const shouldIgnoreSwipeTarget = (target: EventTarget | null): boolean => {
    if (!(target instanceof Element)) return false;
    return Boolean(target.closest(
      'button, input, textarea, select, a, [role="button"], [contenteditable="true"], [data-reading-interaction="true"]'
    ));
  };

  const canStartSwipe = (target: EventTarget | null): boolean => {
    if (mode !== 'recommendation-feed' || shouldIgnoreSwipeTarget(target)) return false;
    const selection = window.getSelection();
    return !selection || selection.isCollapsed;
  };

  const getCurrentContinuousArticleId = (): string => {
    const sections: HTMLElement[] = contentRef.current
      ? Array.from(contentRef.current.querySelectorAll<HTMLElement>('[data-reading-article-section]'))
      : [];
    return selectCurrentContinuousArticleId(
      sections.map((section) => {
        const bounds = section.getBoundingClientRect();
        return {
          articleId: section.dataset.readingArticleId || article.id,
          top: bounds.top,
          bottom: bounds.bottom,
        };
      }),
    ) ?? article.id;
  };

  /** Skip to the next recommended article (left-swipe / desktop right-click). */
  const advanceToNextRecommendedArticle = () => {
    if (mode !== 'recommendation-feed') return;
    const articleId = getCurrentContinuousArticleId();
    if (completedContinuousArticleIdsRef.current.has(articleId)) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;

    completedContinuousArticleIdsRef.current.add(articleId);
    pendingSwipeScrollArticleIdRef.current = articleId;
    suppressNextWordClickRef.current = true;
    window.setTimeout(() => {
      suppressNextWordClickRef.current = false;
    }, 0);
    onAdvanceRef.current?.(
      buildReadingAdvancePayload(
        articleId,
        'skipped',
        exposedLemmasByArticleRef.current.get(articleId) ?? new Set<string>(),
      )
    );
  };

  const handleLeftSwipe = (startX: number, startY: number, endX: number, endY: number) => {
    if (!isLeftSwipeGesture({ startX, startY, endX, endY })) return;
    advanceToNextRecommendedArticle();
  };

  /** Desktop: right-click advances to the next recommended article. */
  const handleContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    if (mode !== 'recommendation-feed' || shouldIgnoreSwipeTarget(event.target)) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;
    event.preventDefault();
    advanceToNextRecommendedArticle();
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (
      !event.isPrimary
      || !['touch', 'pen'].includes(event.pointerType)
      || !canStartSwipe(event.target)
    ) return;
    swipeStartRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = swipeStartRef.current;
    swipeStartRef.current = null;
    if (
      mode !== 'recommendation-feed'
      || !start
      || start.pointerId !== event.pointerId
    ) return;
    handleLeftSwipe(start.x, start.y, event.clientX, event.clientY);
  };

  const handlePointerCancel = () => {
    swipeStartRef.current = null;
  };

  const handleTouchStart = (event: React.TouchEvent<HTMLDivElement>) => {
    if (event.touches.length !== 1 || !canStartSwipe(event.target)) return;
    const touch = event.touches[0];
    touchSwipeStartRef.current = { identifier: touch.identifier, x: touch.clientX, y: touch.clientY };
  };

  const handleTouchEnd = (event: React.TouchEvent<HTMLDivElement>) => {
    const start = touchSwipeStartRef.current;
    touchSwipeStartRef.current = null;
    if (mode !== 'recommendation-feed' || !start) return;
    let touch: Touch | null = null;
    for (let index = 0; index < event.changedTouches.length; index += 1) {
      const changedTouch = event.changedTouches.item(index);
      if (changedTouch?.identifier === start.identifier) {
        touch = changedTouch;
        break;
      }
    }
    if (!touch) return;
    handleLeftSwipe(start.x, start.y, touch.clientX, touch.clientY);
  };

  const handleTouchCancel = () => {
    touchSwipeStartRef.current = null;
  };

  return (
    <div
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchCancel}
      onContextMenu={handleContextMenu}
      style={{ touchAction: mode === 'recommendation-feed' ? 'pan-y' : undefined }}
      className={`min-h-screen bg-[#F8F6F0] text-[#2B2723] flex flex-col justify-between relative selection:bg-[#FDE68A] transition-all duration-150 ease-out overflow-x-clip ${
        articleVisible ? 'opacity-100 translate-x-0' : 'opacity-0 translate-x-2'
      }`}
    >
      {showNavigationHint && (
        <div className="fixed top-[max(4.5rem,calc(env(safe-area-inset-top,0px)+3.5rem))] left-1/2 -translate-x-1/2 z-40 rounded-full bg-[#2C2723]/90 px-4 py-2 text-xs font-medium text-white shadow-lg pointer-events-none max-w-[90vw] text-center">
          上下滑动阅读 · 电脑右键切换下一篇
        </div>
      )}

      <header className="sticky top-0 z-20 bg-[#F8F6F0]/90 px-4 backdrop-blur-md safe-pt sm:px-6">
        <div className="mx-auto grid h-16 w-full max-w-[1040px] grid-cols-[auto_minmax(0,1fr)_auto] items-center border-b border-[#E7E2D5] sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
          <div className="flex min-w-11 items-center gap-3">
          <button
            type="button"
            onClick={onBack}
            className="tap-target inline-flex items-center justify-center p-2.5 hover:bg-[#EFEAE0] active:bg-[#E8E2D5] rounded-xl text-[#524B43] transition-colors"
            title="Back"
            aria-label="Back"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <ReadAgeBrand
            className="app-desktop-brand"
            logoClassName="h-7 w-7"
            nameClassName="text-base"
          />
          </div>

          <div className="text-center min-w-0 px-1 sm:px-2 flex justify-center">
            {navigation || (
            <>
            <h1 className="font-serif text-base sm:text-2xl font-bold leading-tight text-[#2C2723] truncate max-w-[min(58vw,16rem)] sm:max-w-lg mx-auto">
              {article.title}
            </h1>
            {(article.levelRating || article.level || article.source) && (
              <p className="text-[11px] sm:text-xs text-[#8C8478] mt-0.5 truncate max-w-[min(58vw,16rem)] sm:max-w-lg mx-auto">
              {/* One CEFR badge per article (levelRating is the official grade when present). */}
              {(article.levelRating?.level || article.level) && (
                <button
                  type="button"
                  onClick={() => setShowLevelDetail((v) => !v)}
                  className="hover:text-[#C35E37] underline-offset-2 hover:underline"
                  title="查看本篇唯一 CEFR 评级"
                >
                  CEFR {article.levelRating?.level || article.level}
                  {typeof article.levelRating?.difficultyScore === 'number' && (
                    <span> · 难度 {article.levelRating.difficultyScore}</span>
                  )}
                </button>
              )}
              {(article.levelRating?.level || article.level) && article.source && (
                <span> · </span>
              )}
              {article.source && <span>{article.source}</span>}
              </p>
            )}
            </>
            )}
          </div>

          <div className="relative justify-self-end">
            <button
              type="button"
              onClick={() => setShowMenu(!showMenu)}
              className="tap-target inline-flex items-center justify-center p-2.5 hover:bg-[#EFEAE0] active:bg-[#E8E2D5] rounded-xl text-[#524B43] transition-colors"
              title="Options"
              aria-label="Options"
              aria-expanded={showMenu}
            >
              <MoreHorizontal className="w-5 h-5" />
            </button>

            {showMenu && (
              <div className="absolute right-0 mt-2 w-[min(15rem,calc(100vw-1.5rem))] bg-[#FAF8F3] border border-[#E0D9CB] rounded-xl shadow-lg p-2 z-30 text-sm sm:text-xs text-[#3D372E]">
              <div className="flex gap-1 p-1 mb-2 bg-[#EFECE3] rounded-lg">
                {(['normal', 'large', 'xlarge'] as const).map((size) => (
                  <button
                    key={size}
                    type="button"
                    onClick={() => setFontSize(size)}
                    className={`flex-1 min-h-10 sm:min-h-0 py-2 sm:py-1 rounded text-center font-medium ${
                      fontSize === size
                        ? 'bg-white shadow-2xs text-[#2B2723]'
                        : 'text-[#6C655C]'
                    }`}
                  >
                    {size === 'normal' ? 'Aa' : size === 'large' ? 'Aa+' : 'Aa++'}
                  </button>
                ))}
              </div>

              <button
                type="button"
                onClick={() => {
                  setShowMenu(false);
                  handleSpeakText(article.content.join(' '));
                }}
                className="w-full min-h-11 sm:min-h-0 px-3 py-2.5 sm:py-2 hover:bg-[#F0EBE0] active:bg-[#EFEAE0] rounded-lg flex items-center justify-center"
                title="Listen to full article"
                aria-label="Listen to full article"
              >
                <Volume2 className="w-4 h-4 text-[#C35E37] shrink-0" />
              </button>

              {article.paragraphTranslations && article.paragraphTranslations.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setShowParagraphTranslations((v) => !v);
                    setShowMenu(false);
                  }}
                  className="w-full min-h-11 sm:min-h-0 px-3 py-2.5 sm:py-2 hover:bg-[#F0EBE0] active:bg-[#EFEAE0] rounded-lg flex items-center justify-center [&>span]:hidden"
                  title={showParagraphTranslations ? 'Hide paragraph translations' : 'Show paragraph translations'}
                  aria-label={showParagraphTranslations ? 'Hide paragraph translations' : 'Show paragraph translations'}
                >
                  <Globe className="w-4 h-4 text-[#2563EB] shrink-0" />
                </button>
              )}

              {onRewriteAtLevel && (
                <div className="mt-1 border-t border-[#E7E2D5] pt-1">
                  <button
                    type="button"
                    disabled={isRewriting}
                    onClick={() => setShowRewriteLevels((v) => !v)}
                    className="w-full min-h-11 sm:min-h-0 px-3 py-2.5 sm:py-2 hover:bg-[#F0EBE0] active:bg-[#EFEAE0] rounded-lg flex items-center justify-center gap-2 disabled:opacity-50"
                    title={isRewriting ? '正在改写' : '按等级改写'}
                    aria-label={isRewriting ? '正在改写' : '按等级改写'}
                  >
                    <PenLine className="w-4 h-4 text-[#C35E37]" />
                    <span className="sm:hidden">按等级改写</span>
                  </button>
                  {showRewriteLevels && !isRewriting && (
                    <div className="px-2 pb-2 grid grid-cols-3 gap-1.5">
                      {REWRITE_CEFR_LEVELS.map((lv) => {
                        const current = (article.levelRating?.level || article.level || '').toUpperCase();
                        const isCurrent = current === lv;
                        const isPreferred =
                          Boolean(preferredCefrLevel)
                          && preferredCefrLevel.toUpperCase() === lv;
                        return (
                          <button
                            key={lv}
                            type="button"
                            onClick={() => {
                              setShowRewriteLevels(false);
                              setShowMenu(false);
                              onRewriteAtLevel(lv);
                            }}
                            className={`min-h-10 sm:min-h-0 py-2 sm:py-1.5 rounded-lg text-center text-xs sm:text-[11px] font-semibold border transition-colors ${
                              isPreferred
                                ? 'border-[#A94E2B] bg-[#A94E2B] text-white'
                                : isCurrent
                                  ? 'border-[#A94E2B] bg-[#A94E2B]/10 text-[#A94E2B]'
                                  : 'border-[#E0DBCF] bg-white hover:border-[#C35E37] text-[#3D372E]'
                            }`}
                            title={
                              isPreferred
                                ? `你的测试等级 ${lv}（推荐）`
                                : isCurrent
                                  ? `当前约 ${lv}，仍可生成新版本`
                                  : `生成 CEFR ${lv} 新版本`
                            }
                          >
                            {lv}
                            {isPreferred ? ' ·你' : ''}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-3xl w-full mx-auto px-4 py-6 sm:px-6 sm:py-12 pb-10 sm:pb-[max(7rem,calc(5.5rem+env(safe-area-inset-bottom,0px)))]">
        <header className="mb-6 sm:mb-8">
          <h2 className="font-serif text-[1.65rem] sm:text-3xl font-bold leading-tight text-[#2A2621] break-words">
            {article.title}
          </h2>
          {(article.levelRating?.level || article.level || article.source) && (
            <p className="mt-2 text-[10px] text-[#8C8478]">
              {(article.levelRating?.level || article.level) && (
                <button
                  type="button"
                  onClick={() => setShowLevelDetail((v) => !v)}
                  className="hover:text-[#C35E37] underline-offset-2 hover:underline"
                  title="查看本篇唯一 CEFR 评级"
                >
                  CEFR {article.levelRating?.level || article.level}
                  {typeof article.levelRating?.difficultyScore === 'number' && (
                    <span> · 难度 {article.levelRating.difficultyScore}</span>
                  )}
                </button>
              )}
              {(article.levelRating?.level || article.level) && article.source && <span> · </span>}
              {article.source && <span>{article.source}</span>}
            </p>
          )}
        </header>

        {/* Legacy rewrite banner is intentionally suppressed: rewrites are ordinary new articles. */}
        {false && (
          <div className="mb-4 p-3 bg-[#FDF2F8] border border-[#FBCFE8] rounded-xl text-xs text-[#9D174D] flex items-start justify-between gap-3">
            <div>
              <p className="font-semibold">
                改写版
                {(article.levelRating?.level || article.level || article.rewriteTargetLevel)
                  ? ` · CEFR ${article.levelRating?.level || article.level || article.rewriteTargetLevel}`
                  : ''}
              </p>
              <p className="mt-0.5 text-[#BE185D]">
                改写自「{article.parentArticleTitle || '原文'}」· 每篇仅一个评级
              </p>
            </div>
            {onOpenParentArticle && (
              <button
                type="button"
                onClick={onOpenParentArticle}
                className="shrink-0 px-2.5 py-1 rounded-lg bg-white border border-[#F9A8D4] text-[#9D174D] font-medium hover:bg-[#FDF2F8]"
              >
                打开原文
              </button>
            )}
          </div>
        )}

        {reviewWords.length > 0 && (
          <section className="review-word-strip mb-7" aria-labelledby="review-word-strip-title">
            <div className="mb-2 flex items-center justify-between gap-3 px-1">
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="review-word-strip__icon" aria-hidden="true">
                  <BookOpen className="h-3.5 w-3.5" />
                </span>
                <div className="min-w-0">
                  <h2 id="review-word-strip-title" className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#6B645B]">
                    Focus words
                  </h2>
                  <p className="text-[11px] text-[#9A9185]">{reviewWords.length} in this article</p>
                </div>
              </div>
              <span className="hidden shrink-0 text-[11px] font-medium text-[#A59C90] sm:inline">
                Vocabulary set
              </span>
            </div>
            <div className="review-word-strip__viewport">
              <div className="review-word-strip__fade review-word-strip__fade--left" aria-hidden="true" />
              <ul className="review-word-strip__track" aria-label="Review words">
                {reviewWords.map((word) => (
                  <li key={word} className="shrink-0">
                    <button
                      type="button"
                      className="review-word-chip"
                      onClick={() => {
                        const context = article.content.find((paragraph) =>
                          paragraph.toLowerCase().includes(word.toLowerCase()),
                        ) || article.content[0] || '';
                        onWordClick?.(word);
                        void openWordCard(word, context);
                      }}
                    >
                      <span className="review-word-chip__dot" aria-hidden="true" />
                      <span>{word}</span>
                    </button>
                  </li>
                ))}
              </ul>
              <div className="review-word-strip__fade review-word-strip__fade--right" aria-hidden="true" />
            </div>
          </section>
        )}

        {(importJob?.status === 'queued'
          || importJob?.status === 'processing'
          || article.importEnrichmentStatus === 'pending'
          || article.importEnrichmentStatus === 'processing'
          || (needsImportEnrichment(article) && article.importEnrichmentStatus !== 'failed')) && (
          <div className="mb-4 p-3 bg-[#E0F2FE] border border-[#BAE6FD] rounded-xl text-xs text-[#075985] space-y-1">
            <p className="font-semibold">导入模块处理中 · 可先阅读原文</p>
            <p>
              {importJob?.progress?.message
                || (importJob?.status === 'queued'
                  ? '已排队，等待后台逐段翻译与评级…'
                  : '后台逐段翻译与 CEFR 评级稍后完成，译文会自动出现。')}
            </p>
          </div>
        )}

        {(importJob?.status === 'failed' || article.importEnrichmentStatus === 'failed') && (
          <div className="mb-4 p-3 bg-[#FEE2E2] border border-[#FECACA] rounded-xl text-xs text-[#991B1B] flex items-start justify-between gap-3">
            <div>
              <p className="font-semibold">导入模块失败</p>
              <p className="mt-0.5">
                {article.importEnrichmentError || importJob?.error || '翻译或评级未完成'}
              </p>
            </div>
            {onRetryImport && (
              <button
                type="button"
                onClick={onRetryImport}
                className="shrink-0 px-2.5 py-1 rounded-lg bg-white border border-[#FECACA] text-[#991B1B] font-medium hover:bg-[#FEF2F2]"
              >
                重试
              </button>
            )}
          </div>
        )}

        {showLevelDetail && article.levelRating && (
          <div className="mb-4 p-3 bg-white border border-[#E0DBCF] rounded-xl text-xs text-[#3D372E] space-y-1.5 shadow-2xs">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-[#2A2621]">
                AI 评级 · CEFR {article.levelRating.level}
                {typeof article.levelRating.difficultyScore === 'number' && (
                  <span className="font-normal text-[#8C8478]">
                    {' '}
                    · 难度 {article.levelRating.difficultyScore}/100
                  </span>
                )}
              </span>
              <button
                type="button"
                onClick={() => setShowLevelDetail(false)}
                className="text-[#8C8478] hover:text-[#C35E37]"
              >
                收起
              </button>
            </div>
            <p className="leading-relaxed text-[#524B43]">{article.levelRating.summary}</p>
            {article.levelRating.vocabularyNotes && (
              <p className="text-[#6B645B]">
                <span className="font-medium text-[#3D372E]">词汇：</span>
                {article.levelRating.vocabularyNotes}
              </p>
            )}
            {article.levelRating.structureNotes && (
              <p className="text-[#6B645B]">
                <span className="font-medium text-[#3D372E]">结构：</span>
                {article.levelRating.structureNotes}
              </p>
            )}
          </div>
        )}

        {addedWordSuccess && (
          <div className="mb-6 p-3 bg-[#D2E7D6] text-[#27532F] rounded-xl text-sm font-medium flex items-center gap-2 shadow-2xs">
            <CheckCircle2 className="w-4 h-4" />
            <span>Added &quot;{addedWordSuccess}&quot; to review (L1 生词)</span>
          </div>
        )}
        <div
          ref={contentRef}
          onMouseUp={handleTextSelection}
          className={`font-serif text-[#2B2723] space-y-6 sm:space-y-8 select-text break-words [overflow-wrap:anywhere] ${getFontSizeClass()}`}
        >
          <section data-reading-article-section={article.id} data-reading-article-id={article.id}>
            {article.content.map((paragraph, pIdx) => {
            const paragraphKind = classifyArticleParagraph(paragraph, article.title);
            if (paragraphKind === 'furniture') return null;

            const zh = article.paragraphTranslations?.[pIdx];
            const inlineContent = paragraphKind === 'author'
              ? paragraph
              : renderInteractiveParagraph(paragraph, article, highlightTerms);

            const translationClassName =
              paragraphKind === 'title'
                ? 'font-sans text-sm sm:text-base leading-relaxed text-[#7B7267] pl-3 border-l border-[#D6CFC1]'
                : paragraphKind === 'author'
                  ? 'font-sans text-xs sm:text-sm leading-relaxed text-[#9A9185] pl-3'
                  : 'font-sans text-[0.85em] leading-relaxed text-[#6B645B] bg-[#F3F0E8] border border-[#E7E2D5] rounded-xl px-3 py-2.5';

            return (
              <div
                key={pIdx}
                className={
                  paragraphKind === 'title'
                    ? 'space-y-3 pt-2 pb-1'
                    : paragraphKind === 'author'
                      ? 'space-y-2 pt-1 pb-2'
                      : 'space-y-2'
                }
              >
                {paragraphKind === 'title' ? (
                  <h2
                    data-reading-paragraph={pIdx}
                    data-reading-article-id={article.id}
                    data-reading-last-paragraph={pIdx === currentLastParagraphIndex ? 'true' : undefined}
                    className="font-serif text-2xl sm:text-3xl font-bold leading-tight tracking-normal text-[#2A2621]"
                  >
                    {inlineContent}
                  </h2>
                ) : (
                  <p
                    data-reading-paragraph={pIdx}
                    data-reading-article-id={article.id}
                    data-reading-last-paragraph={pIdx === currentLastParagraphIndex ? 'true' : undefined}
                    className={
                      paragraphKind === 'author'
                        ? 'font-sans text-sm sm:text-base font-bold leading-relaxed tracking-normal text-[#6C655C] pl-3 border-l-2 border-[#C35E37]'
                        : 'tracking-normal indent-8 sm:indent-10'
                    }
                  >
                    {inlineContent}
                  </p>
                )}
                {showParagraphTranslations && zh && (
                  <p className={translationClassName}>
                    {zh}
                  </p>
                )}
              </div>
            );
            })}
          </section>

          {continuationArticleList.map((nextArticle) => {
            const nextLastParagraphIndex = nextArticle.content.reduce(
              (lastIndex, paragraph, index) =>
                classifyArticleParagraph(paragraph, nextArticle.title) === 'furniture' ? lastIndex : index,
              -1,
            );
            return (
              <section
                key={nextArticle.id}
                data-reading-article-section={nextArticle.id}
                data-reading-article-id={nextArticle.id}
                className="mt-10 border-t border-[#E7E2D5] pt-8"
              >
                <header className="mb-8">
                  <h2
                    data-reading-article-title="true"
                    className="font-serif text-2xl sm:text-3xl font-bold leading-tight text-[#2A2621]"
                  >
                    {nextArticle.title}
                  </h2>
                  {(nextArticle.levelRating?.level || nextArticle.level || nextArticle.source) && (
                    <p className="mt-2 text-[10px] text-[#8C8478]">
                      {nextArticle.levelRating?.level || nextArticle.level
                        ? `CEFR ${nextArticle.levelRating?.level || nextArticle.level}`
                        : null}
                      {(nextArticle.levelRating?.level || nextArticle.level) && nextArticle.source ? ' · ' : null}
                      {nextArticle.source || null}
                    </p>
                  )}
                </header>
                <div className="space-y-8">
                  {nextArticle.content.map((paragraph, pIdx) => {
                    const paragraphKind = classifyArticleParagraph(paragraph, nextArticle.title);
                    if (paragraphKind === 'furniture') return null;
                    const nextHighlightTerms = getArticleHighlightTerms(nextArticle);
                    const inlineContent = paragraphKind === 'author'
                      ? paragraph
                      : renderInteractiveParagraph(paragraph, nextArticle, nextHighlightTerms);
                    const translation = nextArticle.paragraphTranslations?.[pIdx];
                    return (
                      <div key={pIdx} className="space-y-2">
                        {paragraphKind === 'title' ? (
                          <h3
                            data-reading-paragraph={pIdx}
                            data-reading-article-id={nextArticle.id}
                            data-reading-last-paragraph={pIdx === nextLastParagraphIndex ? 'true' : undefined}
                            className="font-serif text-xl sm:text-2xl font-bold leading-tight text-[#2A2621]"
                          >
                            {inlineContent}
                          </h3>
                        ) : (
                          <p
                            data-reading-paragraph={pIdx}
                            data-reading-article-id={nextArticle.id}
                            data-reading-last-paragraph={pIdx === nextLastParagraphIndex ? 'true' : undefined}
                            className={paragraphKind === 'author'
                              ? 'font-sans text-sm sm:text-base font-bold leading-relaxed text-[#6C655C] pl-3 border-l-2 border-[#C35E37]'
                              : 'tracking-normal indent-8 sm:indent-10'}
                          >
                            {inlineContent}
                          </p>
                        )}
                        {showParagraphTranslations && translation && (
                          <p className="font-sans text-[0.85em] leading-relaxed text-[#6B645B] bg-[#F3F0E8] border border-[#E7E2D5] rounded-xl px-3 py-2.5">
                            {translation}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}

          {mode === 'recommendation-feed' && continuationArticleList.length === 0 && (
            <div
              className="mt-10 min-h-[100dvh] border-t border-[#E7E2D5] pt-8 text-center text-sm text-[#8C8478]"
              aria-live="polite"
            >
              Preparing your next article...
            </div>
          )}
        </div>

        {!isComposerExpanded && (
          <div className="mt-10 flex justify-center sm:hidden">
            <button
              type="button"
              data-reading-interaction="true"
              onClick={() => setIsComposerExpanded(true)}
              className="app-primary-action inline-flex min-h-12 items-center gap-2 rounded-full border border-[#A94E2B] px-5 py-3 shadow-md transition-transform hover:-translate-y-0.5 focus:outline-none focus:ring-2 focus:ring-[#A94E2B] focus:ring-offset-2 sm:hidden"
              aria-label="Open article discussion input"
              aria-expanded={false}
              aria-controls="reading-composer-input"
              title="讨论：就文章提问"
            >
              <MessageCircle className="h-5 w-5 shrink-0" />
              <span className="text-sm font-semibold tracking-wide">讨论本文</span>
            </button>
          </div>
        )}
      </main>

      {copyHint && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-[60] px-3 py-1.5 rounded-full bg-[#2C2723]/90 text-white text-xs font-medium shadow-lg pointer-events-none">
          {copyHint}
        </div>
      )}

      <WordCardPanel
        open={wordCardOpen}
        loading={isExplaining}
        result={grammarResult}
        selectedText={selectedText}
        onClose={closeWordCard}
        onSpeak={handleSpeakText}
        onLookupRelated={handleExplainWord}
        onTranslate={() => {
          void handleTranslate();
        }}
        onCopy={() => {
          const text = selectedText || grammarResult?.wordOrPhrase || '';
          if (!text) return;
          void copyTextToClipboard(text).then((ok) => {
            flashCopyHint(ok ? '已复制到剪贴板' : '复制失败');
          });
        }}
      />

      {(isTranslating || translationResult) && createPortal(
        <div className="fixed inset-0 bg-black/30 backdrop-blur-xs z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="bg-[#FAF8F3] border border-[#E2DCD0] w-full max-w-lg rounded-t-2xl sm:rounded-2xl shadow-xl p-5 sm:p-6 relative max-h-[min(90dvh,100%)] overflow-y-auto safe-pb">
            <button
              type="button"
              onClick={() => {
                setTranslationResult(null);
                setIsTranslating(false);
              }}
              className="absolute top-3 right-3 sm:top-4 sm:right-4 tap-target inline-flex items-center justify-center p-2 text-[#777] hover:bg-[#EFEAE0] rounded-full"
              aria-label="Close translation"
            >
              <X className="w-5 h-5" />
            </button>

            {isTranslating ? (
              <div className="py-12 text-center space-y-4">
                <Globe className="w-8 h-8 text-[#2563EB] animate-spin mx-auto" />
                <p className="font-serif text-lg text-[#332E28]">Translating...</p>
              </div>
            ) : translationResult ? (
              <div className="space-y-4 text-left">
                <h3 className="font-serif text-xl font-semibold text-[#2A2621] border-b border-[#E8E2D5] pb-2">
                  Translation ({translationResult.targetLanguage})
                </h3>
                <div className="p-3 bg-[#EFECE3] rounded-xl text-sm text-[#443E36]">
                  <span className="block text-xs font-semibold text-[#8C8478] mb-1">Original:</span>
                  &quot;{translationResult.originalText}&quot;
                </div>
                <div className="p-3 bg-[#E6F4EA] border border-[#C6E7CE] rounded-xl text-sm text-[#1B4D24] font-medium">
                  <span className="block text-xs font-semibold text-[#2D6A3A] mb-1">Translation:</span>
                  {translationResult.translatedText}
                </div>
                {translationResult.culturalNote && (
                  <div className="p-3 bg-[#FFFBEB] border border-[#FDE68A] rounded-xl text-xs text-[#92400E]">
                    <span className="font-semibold">Note:</span> {translationResult.culturalNote}
                  </div>
                )}
              </div>
            ) : null}
          </div>
        </div>,
        document.body,
      )}

      {/* Discussion UI is portaled to document.body so reading-root transform/opacity
          cannot clip or scroll it off-screen (fixed descendants of transformed
          ancestors are positioned against that ancestor, not the viewport). */}
      {showChatPanel && !isComposerExpanded && createPortal(
        <div
          data-reading-interaction="true"
          className="fixed inset-x-3 bottom-[max(5.5rem,calc(4.5rem+env(safe-area-inset-bottom,0px)))] z-[70] flex max-h-[min(50dvh,24rem)] flex-col rounded-2xl border border-[#E0DBCF] bg-[#FAF8F3] p-4 shadow-2xl sm:inset-x-auto sm:bottom-24 sm:right-8 sm:left-auto sm:w-96 sm:max-h-96"
        >
          <div className="flex items-center justify-between border-b border-[#E8E2D5] pb-2 mb-3">
            <div className="min-w-0">
              <span className="font-serif font-semibold text-sm text-[#332E28] flex items-center gap-1.5">
                <Sparkles className="w-4 h-4 text-[#C35E37] shrink-0" />
                讨论区 · 就文答疑
              </span>
              <p className="text-[10px] text-[#9A9286] mt-0.5 pl-5">
                苏格拉底式追问 · 解释难点 · 不评分
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowChatPanel(false)}
              className="tap-target inline-flex items-center justify-center p-2 hover:bg-[#EFEAE0] rounded-md text-[#666]"
              aria-label="Close discussion"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto space-y-3 p-1 text-sm sm:text-xs overscroll-contain">
            {chatMessages.map((msg, idx) => (
              <div
                key={msg.id ?? idx}
                className={`p-3 rounded-xl max-w-[85%] break-words ${
                  msg.sender === 'user'
                    ? 'bg-[#A94E2B] text-white ml-auto'
                    : 'bg-[#EFECE3] text-[#2C2722] mr-auto border border-[#E2DDD0]'
                }`}
              >
                {msg.text}
              </div>
            ))}
            {isSending && (
              <div className="p-3 bg-[#EFECE3] text-[#6C655C] rounded-xl mr-auto animate-pulse">
                Thinking...
              </div>
            )}
          </div>
        </div>,
        document.body,
      )}

      {isComposerExpanded
        ? createPortal(
          <footer
            data-reading-interaction="true"
            className="fixed inset-x-0 bottom-0 z-[70] sm:inset-x-auto sm:bottom-auto sm:right-8 sm:top-1/2 sm:w-[min(28rem,calc(100vw-2rem))] sm:-translate-y-1/2"
            style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
          >
            <div className="flex max-h-[min(70dvh,34rem)] flex-col gap-1.5 overflow-hidden rounded-t-2xl border border-[#DDD6C8] border-b-0 bg-[#F8F6F0]/98 p-3 shadow-2xl backdrop-blur-md sm:max-h-[min(34rem,calc(100vh-2rem))] sm:rounded-2xl sm:border-b">
              <div className="flex items-center justify-between gap-2 px-1 sm:hidden">
                <span className="font-serif text-sm font-semibold text-[#332E28]">讨论区</span>
                <button
                  type="button"
                  onClick={() => {
                    setIsComposerExpanded(false);
                    setShowChatPanel(false);
                  }}
                  className="tap-target inline-flex items-center justify-center rounded-full p-2 text-[#5B544B] transition-colors hover:bg-[#EFEAE0]"
                  aria-label="Collapse article discussion input"
                  title="Collapse input"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
              <div className="min-h-0 max-h-[40dvh] w-full space-y-3 overflow-y-auto p-1 text-sm sm:max-h-56 sm:text-xs overscroll-contain">
                {chatMessages.length === 0 && !isSending && (
                  <p className="rounded-xl border border-dashed border-[#DDD6C8] bg-white/60 p-3 text-[#756D63]">
                    Start with a question about a sentence, idea, or vocabulary in this article.
                  </p>
                )}
                {chatMessages.map((msg, idx) => (
                  <div
                    key={msg.id ?? idx}
                    className={`max-w-[85%] rounded-xl p-3 break-words ${
                      msg.sender === 'user'
                        ? 'ml-auto bg-[#A94E2B] text-white'
                        : 'mr-auto border border-[#E2DDD0] bg-[#EFECE3] text-[#2C2722]'
                    }`}
                  >
                    {msg.text}
                  </div>
                ))}
                {isSending && (
                  <div className="mr-auto animate-pulse rounded-xl bg-[#EFECE3] p-3 text-[#6C655C]">
                    Thinking...
                  </div>
                )}
              </div>
              <form
                onSubmit={handleSendQuestion}
                className="flex w-full shrink-0 items-center rounded-full border border-[#DDD6C8] bg-white px-3 py-2.5 sm:py-2 shadow-2xs transition-all focus-within:border-[#C35E37]"
                aria-label="Article discussion"
              >
                <input
                  type="text"
                  ref={composerInputRef}
                  id="reading-composer-input"
                  value={userInput}
                  onChange={(e) => setUserInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      setIsComposerExpanded(false);
                      setShowChatPanel(false);
                    }
                  }}
                  placeholder="问大意、难句，或谈谈你的观点…"
                  aria-label="Ask about this article"
                  enterKeyHint="send"
                  autoComplete="off"
                  className="min-w-0 flex-1 bg-transparent text-base sm:text-sm text-[#2B2723] placeholder-[#9A9185] outline-none"
                />
                <button
                  type="submit"
                  disabled={!userInput.trim() || isSending}
                  className="ml-2 tap-target inline-flex shrink-0 items-center justify-center rounded-full bg-[#A94E2B] p-2.5 sm:p-1.5 text-white transition-colors hover:bg-[#8F3F22] disabled:opacity-40"
                  aria-label="Send question"
                >
                  <Send className="w-4 h-4 sm:w-3.5 sm:h-3.5" />
                </button>
              </form>

              <button
                type="button"
                onClick={() => {
                  setIsComposerExpanded(false);
                  setShowChatPanel(false);
                }}
                className="hidden sm:inline-flex shrink-0 self-end rounded-full p-2.5 text-[#5B544B] transition-colors hover:bg-[#EFEAE0]"
                aria-label="Collapse article discussion input"
                title="Collapse input"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          </footer>,
          document.body,
        )
        : createPortal(
          <button
            type="button"
            data-reading-interaction="true"
            onClick={() => setIsComposerExpanded(true)}
            className="hidden sm:inline-flex sm:fixed sm:z-[70] items-center gap-2 rounded-full border border-[#A94E2B] bg-[#A94E2B] px-4 py-3.5 sm:px-5 sm:py-3.5 text-white shadow-xl transition-all hover:scale-105 hover:bg-[#8F3F22] hover:shadow-2xl focus:outline-none focus:ring-2 focus:ring-[#A94E2B] focus:ring-offset-2 sm:right-8 sm:bottom-8"
            aria-label="Open article discussion input"
            aria-expanded={false}
            aria-controls="reading-composer-input"
            title="讨论：就文章提问"
          >
            <MessageCircle className="h-6 w-6 shrink-0" />
            <span className="text-sm font-semibold tracking-wide">讨论</span>
          </button>,
          document.body,
        )}
    </div>
  );
};


