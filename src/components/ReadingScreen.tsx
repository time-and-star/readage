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
import {
  createReadingDwellState,
  getExpectedReadingDwellMs,
  getReadingIdleAllowanceMs,
  hasQualifiedReadingDwell,
  pauseReadingDwell,
  readReadingDwell,
  refreshReadingDwellActivity,
  resumeReadingDwell,
  type ReadingDwellState,
} from '../lib/readingDwell';
import { getArticleLearningTerms } from '../lib/readingLearningTerms';
import { postTutor } from '../lib/tutorClient';
import { useSpeech } from '../lib/speech/useSpeech';
import { SpeechControls, SpeechFeedback } from './SpeechControls';
import type { ImportJob } from '../lib/articleImport';
import { needsImportEnrichment } from '../lib/articleImport';
import { classifyArticleParagraph } from '../lib/articlePresentation';
import { tokenizeReadingParagraph } from '../lib/readingTokens';
import {
  buildReadingAdvancePayload,
  hasArticleExitedViewport,
  isLeftSwipeGesture,
  selectCurrentContinuousArticleId,
} from '../lib/continuousReading';
import { useMemoryV2Integration } from '../lib/memoryV2Integration';
import { createWordCardRequest, fetchWordCard } from '../lib/wordCard';
import { formatSelectionQuote } from '../lib/readingSelection';
import { ReadingLookupCard, type LookupAnchor } from './ReadingLookupCard';
import { getCompactWordCard } from '../lib/compactWordCard';
import { useReadingBookmark } from '../lib/readingBookmark';
import type { DifficultyFeedback } from '../lib/readingPreference';
import { ReadingDifficultyControl } from './ReadingDifficultyControl';
import { ReadingVerificationPause } from './ReadingVerificationPause';
import { ReadAgeBrand } from './ReadAgeBrand';
import { ArticleMediaFigures } from './ArticleMediaFigures';
import { PdfPagePreview } from './PdfPagePreview';
import { useArticleMedia } from '../lib/useArticleMedia';
import {
  emitVocabArticleComplete,
  startVocabSession,
  toVocabSnapshot,
} from '../lib/vocabTelemetry';

let recommendationNavigationHintShown = false;

const REWRITE_CEFR_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] as const;

export function getArticleHighlightTerms(readingArticle?: Article): string[] {
  return getArticleLearningTerms(readingArticle);
}

function getArticleReviewWords(readingArticle: Article): string[] {
  if (readingArticle.source === 'level_rewrite') return [];
  return Array.from(
    new Set((readingArticle.embeddedReviewWords || []).map((word) => word.trim()).filter(Boolean)),
  );
}

interface ReadingScreenProps {
  article: Article;
  difficultyFeedback?: DifficultyFeedback;
  onDifficultyFeedback?: (rating: DifficultyFeedback) => void;
  onNextArticle?: () => void;
  nextArticleLabel?: string;
  /** App-level navigation rendered in place of the article title header. */
  navigation?: React.ReactNode;
  /** Live job from the independent import module (translate + rate). */
  importJob?: ImportJob | null;
  onRetryImport?: () => void;
  /** CEFR level rewrite in progress (parent). */
  isRewriting?: boolean;
  /** Generate a new article version at the chosen CEFR level. */
  onRewriteAtLevel?: (level: string) => void;
  /** Preferred reading level for rewrite targets. */
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
  difficultyFeedback,
  onDifficultyFeedback,
  onNextArticle,
  nextArticleLabel = '换一篇',
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
  const speech = useSpeech();
  useEffect(() => () => speech.stop(), [article.id, speech.stop]);
  const [selectedText, setSelectedText] = useState<string>('');
  const [selectedContext, setSelectedContext] = useState<string>('');
  const [showRewriteLevels, setShowRewriteLevels] = useState(false);

  const [isExplaining, setIsExplaining] = useState(false);
  const [grammarResult, setGrammarResult] = useState<GrammarExplanation | null>(null);
  const [wordCardOpen, setWordCardOpen] = useState(false);
  const speechPreparationText = wordCardOpen && selectedText
    ? grammarResult ? getCompactWordCard(grammarResult, selectedText).word : selectedText
    : article.content.join('\n\n');
  useEffect(() => {
    let cancel: (() => void) | undefined;
    const timer = setTimeout(() => { cancel = speech.prepare(speechPreparationText); }, 600);
    return () => { clearTimeout(timer); cancel?.(); };
  }, [speechPreparationText, speech.prepare, speech.preferences.lang, speech.preferences.rate]);
  const [wordCardError, setWordCardError] = useState<string | null>(null);
  const [lookupAnchor, setLookupAnchor] = useState<LookupAnchor | null>(null);
  const [lookupRecordStatus, setLookupRecordStatus] = useState<string | null>(null);
  const retryLookupRef = useRef<() => void>(() => {});
  const retryRecordRef = useRef<(() => void) | null>(null);
  const [selectionAction, setSelectionAction] = useState<{ text: string; context: string; anchor: LookupAnchor } | null>(null);
  useEffect(() => {
    if (!selectionAction) return;
    const dismiss = (event: PointerEvent) => {
      if (!(event.target as Element).closest('.reading-selection-actions')) setSelectionAction(null);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setSelectionAction(null); };
    const onScroll = () => setSelectionAction(null);
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', onKey); window.removeEventListener('scroll', onScroll); };
  }, [selectionAction]);

  const [isTranslating, setIsTranslating] = useState(false);
  const [translationResult, setTranslationResult] = useState<TranslationResult | null>(null);

  const [addedWordSuccess, setAddedWordSuccess] = useState<string | null>(null);
  const [copyHint, setCopyHint] = useState<string | null>(null);

  const [userInput, setUserInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(initialChatMessages);
  const [showChatPanel, setShowChatPanel] = useState(false);
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
    setShowChatPanel(false);
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
  const [activeVerificationArticleIds, setActiveVerificationArticleIds] = useState<Set<string>>(new Set());
  const [verificationReadyArticleIds, setVerificationReadyArticleIds] = useState<Set<string>>(new Set());
  const markVerificationReady = useCallback((articleId: string) => {
    setVerificationReadyArticleIds(previous => {
      if (previous.has(articleId)) return previous;
      return new Set([...previous, articleId]);
    });
  }, []);
  const handleVerificationActiveChange = useCallback((articleId: string, active: boolean) => {
    setActiveVerificationArticleIds(previous => {
      if (previous.has(articleId) === active) return previous;
      const next = new Set(previous);
      if (active) next.add(articleId);
      else next.delete(articleId);
      return next;
    });
  }, []);

  const contentRef = useRef<HTMLDivElement>(null);
  useReadingBookmark(article.id, contentRef, article);
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
  const exposureActivityChangedRef = useRef<(() => void) | null>(null);
  const exposureFlushRef = useRef<((articleId?: string) => Promise<void>) | null>(null);
  const readingOverlayOpen = wordCardOpen || isExplaining || showChatPanel || isComposerExpanded
    || isTranslating || Boolean(translationResult) || showMenu || showRewriteLevels || showLevelDetail
    || activeVerificationArticleIds.size > 0;
  const readingOverlayOpenRef = useRef(readingOverlayOpen);
  readingOverlayOpenRef.current = readingOverlayOpen;

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
    setActiveVerificationArticleIds(new Set());
    setVerificationReadyArticleIds(new Set());
    setArticleVisible(false);
    const frame = window.requestAnimationFrame(() => {
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

  // Progress needs sustained visibility. Memory evidence keeps measuring actual
  // foreground dwell after that checkpoint, including rereads of the paragraph.
  useEffect(() => {
    const container = contentRef.current;
    if (!container || typeof IntersectionObserver === 'undefined') return;

    let isActive = true;
    let windowFocused = document.hasFocus();
    const visibleParagraphs = new Set<Element>();
    const completedParagraphs = new Set<Element>();
    const observedParagraphs = new Set<Element>();
    const activeParagraphs = new Set<Element>();
    const idleParagraphs = new Set<Element>();
    const exposureTimers = new Map<Element, number>();
    const retryTimers = new Map<Element, number>();
    const paragraphReadings = new Map<Element, {
      state: ReadingDwellState;
      articleId: string;
      paragraphIndex: number;
      text: string;
      units: ReturnType<typeof extractLearningUnits>;
      minimumDwellTimeMs: number;
      expectedDwellTimeMs: number;
      exposureOccurredAt?: string;
      lastSavedMs: number;
      lastRequestedMs: number;
      retryCount: number;
      writeChain: Promise<void>;
    }>();
    exposedLemmasByArticleRef.current = new Map();

    const canTrackReading = () => isActive && windowFocused
      && document.visibilityState === 'visible' && !readingOverlayOpenRef.current;

    const clearExposureTimer = (paragraph: Element) => {
      const timerId = exposureTimers.get(paragraph);
      if (timerId === undefined) return;
      window.clearTimeout(timerId);
      exposureTimers.delete(paragraph);
    };

    const readingFor = (paragraph: Element) => {
      const existing = paragraphReadings.get(paragraph);
      if (existing) return existing;
      const element = paragraph as HTMLElement;
      const primary = primaryArticleRef.current;
      const paragraphIndex = Number(element.dataset.readingParagraph);
      const articleId = element.dataset.readingArticleId || primary.id;
      const readingArticle = articleId === primary.id ? primary
        : continuousArticlesRef.current?.find((candidate) => candidate.id === articleId);
      const text = readingArticle?.content[paragraphIndex] ?? element.textContent ?? '';
      const reading = {
        state: createReadingDwellState(),
        articleId,
        paragraphIndex,
        text,
        units: extractLearningUnits(text, getArticleHighlightTerms(readingArticle)),
        minimumDwellTimeMs: getMinimumExposureDwellMs(text),
        expectedDwellTimeMs: getExpectedReadingDwellMs(text),
        exposureOccurredAt: undefined as string | undefined,
        lastSavedMs: -1,
        lastRequestedMs: -1,
        retryCount: 0,
        writeChain: Promise.resolve(),
      };
      paragraphReadings.set(paragraph, reading);
      return reading;
    };

    const persistParagraph = (paragraph: Element, now: number): Promise<void> => {
      const reading = readingFor(paragraph);
      if (!hasQualifiedReadingDwell(reading.state, now, reading.minimumDwellTimeMs)
        || reading.units.length === 0) return reading.writeChain;
      const dwellTimeMs = Math.round(readReadingDwell(reading.state, now).dwellTimeMs);
      if (dwellTimeMs <= reading.lastRequestedMs) return reading.writeChain;
      reading.exposureOccurredAt ??= new Date().toISOString();
      reading.lastRequestedMs = dwellTimeMs;
      reading.writeChain = reading.writeChain.then(async () => {
        try {
          await recordParagraphExposure(reading.paragraphIndex, reading.units, reading.articleId, {
            contextText: reading.text.slice(0, 2_000),
            dwellTimeMs,
            expectedDwellTimeMs: reading.expectedDwellTimeMs,
            exposureOccurredAt: reading.exposureOccurredAt,
          });
          reading.lastSavedMs = dwellTimeMs;
          reading.retryCount = 0;
        } catch (error) {
          if (reading.lastRequestedMs === dwellTimeMs) reading.lastRequestedMs = reading.lastSavedMs;
          console.error('Memory V2.2 exposure recording failed:', error);
          // A failed persistent write can retry without needing another scroll.
          if (isActive && reading.retryCount < 2 && !retryTimers.has(paragraph)) {
            reading.retryCount += 1;
            retryTimers.set(paragraph, window.setTimeout(() => {
              retryTimers.delete(paragraph);
              if (isActive) void persistParagraph(paragraph, performance.now());
            }, 2_000));
          }
        }
      });
      return reading.writeChain;
    };

    const pauseParagraph = (paragraph: Element, now: number) => {
      clearExposureTimer(paragraph);
      activeParagraphs.delete(paragraph);
      const reading = paragraphReadings.get(paragraph);
      if (!reading) return;
      reading.state = pauseReadingDwell(reading.state, now);
      stageParagraph(paragraph, now);
      void persistParagraph(paragraph, now);
    };

    const flushParagraphs = async (articleId?: string, pause = true) => {
      const now = performance.now();
      const writes: Promise<void>[] = [];
      for (const [paragraph, reading] of paragraphReadings) {
        if (articleId && reading.articleId !== articleId) continue;
        if (pause) pauseParagraph(paragraph, now);
        writes.push(persistParagraph(paragraph, now));
      }
      await Promise.all(writes);
    };

    const finishSingleReading = () => {
      if (!isActive || hasAdvancedRef.current || mode === 'recommendation-feed') return;
      hasAdvancedRef.current = true;
      const exposed = [...(exposedLemmasByArticleRef.current.get(article.id) ?? new Set<string>())];
      // Completion bookkeeping does not stop measuring paragraphs still being read.
      void flushParagraphs(article.id, false).then(() => snapshotWordsRef.current(exposed)).then((words) => {
        emitVocabArticleComplete({
          articleId: article.id,
          exposedLemmas: exposed,
          words,
        });
        if (isActive) markVerificationReady(article.id);
      });
      onReadingCompleteRef.current?.();
    };

    const stageParagraph = (paragraph: Element, now: number) => {
      if (!isActive) return;
      const reading = readingFor(paragraph);
      if (completedParagraphs.has(paragraph)
        || !hasQualifiedReadingDwell(reading.state, now, reading.minimumDwellTimeMs)) return;
      const staged = stagedExposuresFor(reading.articleId);
      const newWordIds = [...new Set(reading.units.map((unit) => unit.wordId))]
        .filter((wordId) => !staged.has(wordId));
      newWordIds.forEach((wordId) => staged.add(wordId));
      completedParagraphs.add(paragraph);
      if (newWordIds.length > 0 && mode === 'single') onExposuresRef.current?.(newWordIds);
      if (mode === 'single') {
        const paragraphCount = container.querySelectorAll('[data-reading-paragraph]').length;
        if (paragraphCount > 0 && completedParagraphs.size === paragraphCount) finishSingleReading();
      }
    };

    const scheduleExposureTimer = (paragraph: Element) => {
      clearExposureTimer(paragraph);
      if (!canTrackReading() || !activeParagraphs.has(paragraph)) return;
      const reading = readingFor(paragraph);
      const now = performance.now();
      const snapshot = readReadingDwell(reading.state, now);
      const checkpoints = [reading.expectedDwellTimeMs, reading.expectedDwellTimeMs * 2];
      const nextCheckpoint = checkpoints.find((checkpoint) => checkpoint > snapshot.dwellTimeMs);
      const remainingContinuousMs = completedParagraphs.has(paragraph) ? Infinity
        : Math.max(0, reading.minimumDwellTimeMs - snapshot.continuousTimeMs);
      const remainingCheckpointMs = completedParagraphs.has(paragraph) && nextCheckpoint !== undefined
        ? nextCheckpoint - snapshot.dwellTimeMs : Infinity;
      const idleRemainingMs = Math.max(0, (reading.state.idleDeadline ?? now) - now);
      const waitMs = Math.max(1, Math.min(remainingContinuousMs, remainingCheckpointMs, idleRemainingMs));
      exposureTimers.set(paragraph, window.setTimeout(() => {
        exposureTimers.delete(paragraph);
        if (!canTrackReading() || !visibleParagraphs.has(paragraph)) {
          pauseParagraph(paragraph, performance.now());
          return;
        }
        const tickNow = performance.now();
        stageParagraph(paragraph, tickNow);
        void persistParagraph(paragraph, tickNow);
        if (!readReadingDwell(reading.state, tickNow).isActive) {
          idleParagraphs.add(paragraph);
          pauseParagraph(paragraph, tickNow);
          scheduleVisibleExposureTimers();
        } else scheduleExposureTimer(paragraph);
      }, waitMs));
    };

    const scheduleVisibleExposureTimers = () => {
      if (!canTrackReading()) return;
      const candidates = (Array.from(container.querySelectorAll('[data-reading-paragraph]')) as Element[])
        .filter((paragraph) => visibleParagraphs.has(paragraph) && !idleParagraphs.has(paragraph)
          && !activeParagraphs.has(paragraph)
          && !completedContinuousArticleIdsRef.current.has(readingFor(paragraph).articleId));
      for (const paragraph of limitConcurrentExposureCandidates(candidates, activeParagraphs.size)) {
        const reading = readingFor(paragraph);
        reading.state = resumeReadingDwell(reading.state, performance.now(),
          getReadingIdleAllowanceMs(reading.expectedDwellTimeMs));
        activeParagraphs.add(paragraph);
        scheduleExposureTimer(paragraph);
      }
    };

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!isActive) return;

          const paragraph = entry.target as HTMLElement;
          const isSufficientlyVisible =
            entry.isIntersecting
            && hasSufficientExposureVisibility(
              entry.intersectionRect.height,
              entry.boundingClientRect.height,
              window.innerHeight,
            );

          if (!isSufficientlyVisible) {
            visibleParagraphs.delete(paragraph);
            pauseParagraph(paragraph, performance.now());
            return;
          }

          visibleParagraphs.add(paragraph);
        });
        scheduleVisibleExposureTimers();
      },
      { threshold: Array.from({ length: 101 }, (_, index) => index / 100) },
    );

    const observeNewParagraphs = () => {
      if (!isActive) return;
      const paragraphs = Array.from(
        container.querySelectorAll('[data-reading-paragraph]')
      ) as HTMLElement[];
      for (const paragraph of paragraphs) {
        if (observedParagraphs.has(paragraph)) continue;
        observedParagraphs.add(paragraph);
        observer.observe(paragraph);
      }
    };

    exposureObserveNewRef.current = observeNewParagraphs;
    exposureFlushRef.current = (articleId) => flushParagraphs(articleId);
    observeNewParagraphs();

    const pauseExposureTracking = () => {
      const now = performance.now();
      [...activeParagraphs].forEach((paragraph) => pauseParagraph(paragraph, now));
    };

    const refreshVisibleParagraphs = () => {
      observedParagraphs.forEach((paragraph) => {
        const bounds = paragraph.getBoundingClientRect();
        const visibleHeight = Math.max(0, Math.min(window.innerHeight, bounds.bottom) - Math.max(0, bounds.top));
        if (hasSufficientExposureVisibility(visibleHeight, bounds.height, window.innerHeight)) {
          visibleParagraphs.add(paragraph);
        } else {
          visibleParagraphs.delete(paragraph);
          pauseParagraph(paragraph, performance.now());
        }
      });
    };

    const handleActivityChanged = () => {
      if (!canTrackReading()) { pauseExposureTracking(); return; }
      refreshVisibleParagraphs();
      scheduleVisibleExposureTimers();
    };
    exposureActivityChangedRef.current = handleActivityChanged;
    const handleVisibilityChange = () => {
      windowFocused = document.hasFocus();
      handleActivityChanged();
    };
    const handleBlur = () => { windowFocused = false; pauseExposureTracking(); };
    const handleFocus = () => { windowFocused = true; handleActivityChanged(); };
    const handleUserActivity = (event: Event) => {
      if (!event.isTrusted || !canTrackReading()) return;
      idleParagraphs.clear();
      const now = performance.now();
      for (const paragraph of activeParagraphs) {
        const reading = readingFor(paragraph);
        reading.state = refreshReadingDwellActivity(reading.state, now,
          getReadingIdleAllowanceMs(reading.expectedDwellTimeMs));
        scheduleExposureTimer(paragraph);
      }
      scheduleVisibleExposureTimers();
    };
    const handlePageHide = () => { pauseExposureTracking(); };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('blur', handleBlur);
    window.addEventListener('focus', handleFocus);
    window.addEventListener('pagehide', handlePageHide);
    const activityEvents = ['pointerdown', 'pointermove', 'keydown', 'scroll', 'touchstart'];
    activityEvents.forEach((event) => document.addEventListener(event, handleUserActivity, { passive: true, capture: true }));

    return () => {
      // Snapshot before discarding this article's state, including the last visible paragraph.
      isActive = false;
      pauseExposureTracking();
      void flushParagraphs();
      exposureObserveNewRef.current = null;
      exposureActivityChangedRef.current = null;
      exposureFlushRef.current = null;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('blur', handleBlur);
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('pagehide', handlePageHide);
      activityEvents.forEach((event) => document.removeEventListener(event, handleUserActivity, true));
      observer.disconnect();
      retryTimers.forEach((timerId) => window.clearTimeout(timerId));
      completedParagraphs.clear();
      observedParagraphs.clear();
    };
    // The exposure set intentionally resets only when the article lifecycle changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [article.id, mode]);

  useEffect(() => {
    exposureActivityChangedRef.current?.();
  }, [readingOverlayOpen]);

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
        const flush = exposureFlushRef.current?.(articleId) ?? Promise.resolve();
        void flush.then(async () => {
          const exposed = exposedLemmasByArticleRef.current.get(articleId) ?? new Set<string>();
          const exposedList = [...exposed];
          const words = await snapshotWordsRef.current(exposedList);
          emitVocabArticleComplete({
            articleId,
            exposedLemmas: exposedList,
            words,
          });
          markVerificationReady(articleId);
          onAdvanceRef.current?.(
            buildReadingAdvancePayload(articleId, 'completed', exposed)
          );
        });
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
    (lastIndex, paragraph, index) => {
      const kind = classifyArticleParagraph(paragraph, article.title);
      return kind === 'furniture' || kind === 'title' ? lastIndex : index;
    },
    -1,
  );
  const continuationArticleList = mode === 'recommendation-feed'
    ? (continuousArticles || []).filter((candidate) => candidate.id !== article.id)
    : [];
  const articleMedia = useArticleMedia([article, ...continuationArticleList]);

  const closeWordCard = useCallback(() => {
    wordCardAbortRef.current?.abort();
    wordCardAbortRef.current = null;
    setWordCardOpen(false);
    setIsExplaining(false);
    setGrammarResult(null);
    setWordCardError(null);
  }, []);

  const openWordCard = useCallback(
    async (wordOrPhrase: string, contextSentence = '', contextArticle: Article = article, onResolved?: (result: GrammarExplanation) => Promise<void>) => {
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
      setWordCardError(null);
      setLookupRecordStatus(null);
      retryRecordRef.current = null;
      retryLookupRef.current = () => { void openWordCard(wordOrPhrase, contextSentence, contextArticle, onResolved); };

      try {
        const result = await fetchWordCard(request, {
          articleId: contextArticle.id,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setGrammarResult(result);
        setIsExplaining(false);
        if (onResolved) setLookupRecordStatus('正在保存学习记录…');
        if (onResolved) {
          let saved = false;
          let saving = false;
          const save = async () => {
            if (saved || saving) return;
            saving = true;
            try {
              await onResolved(result);
              saved = true;
              if (!controller.signal.aborted) { retryRecordRef.current = null; setLookupRecordStatus('学习记录已保存'); }
            } catch {
              if (!controller.signal.aborted) { retryRecordRef.current = () => { void save(); }; setLookupRecordStatus('释义已显示，学习记录待保存'); }
            } finally { saving = false; }
          };
          await save();
        } else onGrammarQuery?.(request.selectedText, contextArticle.id);
      } catch (error) {
        if (error instanceof Error && /cancelled|abort/i.test(error.message)) return;
        if (!controller.signal.aborted) setWordCardError(error instanceof Error ? error.message : '查询暂时不可用，请重试。');
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
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;
    const request = createWordCardRequest(word, paragraph);
    if (!request) return;
    const cleanWord = request.selectedText;

    // Memory V2.2: record clicks for any article in the continuous stream
    const paragraphElement = (e.target as HTMLElement).closest('[data-reading-paragraph], [data-reading-context]');
    // A word lookup records the clicked word even inside an article learning phrase.
    const learningUnit = findLearningUnitAtTokenIndex(
      paragraph,
      [cleanWord],
      tokenIndex,
    );
    // Title lookups have their own occurrence; they must not collide with body paragraph 0.
    const paragraphIndex = Number(paragraphElement?.getAttribute('data-reading-paragraph') ?? -1);
    setSelectionAction(null);
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setLookupAnchor({ left: rect.left, top: rect.top, bottom: rect.bottom });
    void openWordCard(cleanWord, paragraph, readingArticle, async result => {
      const lemma = result.source === 'dictionary' ? result.wordOrPhrase : cleanWord;
      if (learningUnit) await recordWordClick(learningUnit, paragraphIndex, readingArticle.id, { contextText: paragraph.slice(0, 2_000) }, lemma);
      onWordClick?.(lemma, readingArticle.id);
    });
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

  /** Selecting text offers help without copying or opening discussion automatically. */
  const handleTextSelection = (e: React.MouseEvent) => {
    if ((e.target as Element).closest('[data-reading-interaction="true"]')) return;
    const button = e.button ?? e.nativeEvent.button;
    if (button !== 0) return;

    const selection = window.getSelection();
    if (!isArticleSelection(selection)) { setSelectionAction(null); return; }

    const text = selection.toString().trim();
    // Ignore pure click noise; require a real selection (phrase/sentence)
    if (text.length < 2 || text.length > 4000) return;

    const rect = selection.getRangeAt(0).getBoundingClientRect();
    setSelectionAction({ text, context: selection.anchorNode?.parentElement?.closest('[data-reading-paragraph], [data-reading-context]')?.textContent || text,
      anchor: { left: rect.left, top: rect.top, bottom: rect.bottom } });
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
    speech.speak(text);
  };

  const getFontSizeClass = () => {
    if (fontSize === 'large') return 'text-[1.25rem] leading-[1.8] sm:text-[1.375rem]';
    if (fontSize === 'xlarge') return 'text-[1.375rem] leading-[1.85] sm:text-2xl';
    return 'text-lg leading-[1.8] sm:text-xl';
  };

  const renderInteractiveParagraph = (
    paragraph: string,
    readingArticle: Article,
  ): React.ReactNode => {
    return tokenizeReadingParagraph(paragraph).map((part, partIndex) => {
      if (part.type === 'link') {
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

      if (part.type === 'text') return part.value;
      return (
        <span
          key={`word-${partIndex}`}
          onClick={(event) => handleWordClick(
            part.value,
            paragraph,
            part.tokenIndex,
            event,
            readingArticle,
          )}
          className="cursor-pointer"
          title="点击查词"
        >
          {part.value}
        </span>
      );
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
    const flush = exposureFlushRef.current?.(articleId) ?? Promise.resolve();
    pendingSwipeScrollArticleIdRef.current = articleId;
    suppressNextWordClickRef.current = true;
    window.setTimeout(() => {
      suppressNextWordClickRef.current = false;
    }, 0);
    void flush.then(() => {
      onAdvanceRef.current?.(
        buildReadingAdvancePayload(
          articleId,
          'skipped',
          exposedLemmasByArticleRef.current.get(articleId) ?? new Set<string>(),
        )
      );
    });
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
      className={`reading-page min-h-screen bg-[#F8F6F0] text-[#2B2723] flex flex-col justify-between relative selection:bg-[#FDE68A] transition-all duration-150 ease-out overflow-x-clip ${
        articleVisible ? 'opacity-100 translate-x-0' : 'opacity-0 translate-x-2'
      }`}
    >
      {showNavigationHint && (
        <div className="fixed top-[max(4.5rem,calc(env(safe-area-inset-top,0px)+3.5rem))] left-1/2 -translate-x-1/2 z-40 rounded-full bg-[#2C2723]/90 px-4 py-2 text-xs font-medium text-white shadow-lg pointer-events-none max-w-[90vw] text-center">
          上下滑动阅读 · 电脑右键切换下一篇
        </div>
      )}

      <header className="app-page-header sticky top-0 z-20 bg-[#F8F6F0]/90 px-4 backdrop-blur-md safe-pt sm:px-6">
        <div className="app-page-header__inner mx-auto grid h-16 w-full max-w-[1040px] grid-cols-[auto_minmax(0,1fr)_auto] items-center sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
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
            <div className="min-w-0">
            <h1 className="[font-family:var(--font-display)] text-base sm:text-xl font-semibold leading-tight text-[#2C2723] truncate max-w-[min(58vw,16rem)] sm:max-w-lg mx-auto">
              {article.title}
            </h1>
            {(article.levelRating || article.level || article.source) && (
              <p className="text-xs leading-5 text-[#7B7267] mt-0.5 truncate max-w-[min(58vw,16rem)] sm:max-w-lg mx-auto">
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
            </div>
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
              <div className="absolute right-0 mt-2 w-[min(16rem,calc(100vw-1.5rem))] bg-[#FAF8F3] border border-[#E0D9CB] rounded-2xl shadow-xl p-2 z-30 text-sm text-[#3D372E]">
              <p className="px-3 pb-2 pt-1 text-xs font-medium text-[#7B7267]">阅读字号</p>
              <div className="flex gap-1 p-1 mb-2 bg-[#EFECE3] rounded-lg">
                {(['normal', 'large', 'xlarge'] as const).map((size) => (
                  <button
                    key={size}
                    type="button"
                    onClick={() => setFontSize(size)}
                    aria-label={size === 'normal' ? '标准字号' : size === 'large' ? '大字号' : '特大字号'}
                    aria-pressed={fontSize === size}
                    className={`flex-1 min-h-11 py-2 rounded-md text-center font-medium ${
                      fontSize === size
                        ? 'bg-white shadow-2xs text-[#2B2723]'
                        : 'text-[#6C655C]'
                    }`}
                  >
                    {size === 'normal' ? 'Aa' : size === 'large' ? 'Aa+' : 'Aa++'}
                  </button>
                ))}
              </div>

              <SpeechControls preferences={speech.preferences} onChange={speech.setPreferences} />
              <button
                type="button"
                onClick={() => {
                  setShowMenu(false);
                  handleSpeakText(article.content.join('\n\n'));
                }}
                className="w-full min-h-11 px-3 py-2.5 hover:bg-[#F0EBE0] active:bg-[#EFEAE0] rounded-lg flex items-center gap-3 text-left"
                title="Listen to full article"
                aria-label="Listen to full article"
              >
                <Volume2 className="w-4 h-4 text-[#C35E37] shrink-0" />
                <span>听全文</span>
              </button>

              {article.paragraphTranslations && article.paragraphTranslations.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setShowParagraphTranslations((v) => !v);
                    setShowMenu(false);
                  }}
                  className="w-full min-h-11 px-3 py-2.5 hover:bg-[#F0EBE0] active:bg-[#EFEAE0] rounded-lg flex items-center gap-3 text-left"
                  title={showParagraphTranslations ? 'Hide paragraph translations' : 'Show paragraph translations'}
                  aria-label={showParagraphTranslations ? 'Hide paragraph translations' : 'Show paragraph translations'}
                >
                  <Globe className="w-4 h-4 text-[#2563EB] shrink-0" />
                  <span>{showParagraphTranslations ? '隐藏段落翻译' : '显示段落翻译'}</span>
                </button>
              )}

              {onRewriteAtLevel && (
                <div className="mt-1 border-t border-[#E7E2D5] pt-1">
                  <button
                    type="button"
                    disabled={isRewriting}
                    onClick={() => setShowRewriteLevels((v) => !v)}
                    className="w-full min-h-11 px-3 py-2.5 hover:bg-[#F0EBE0] active:bg-[#EFEAE0] rounded-lg flex items-center gap-3 text-left disabled:opacity-50"
                    title={isRewriting ? '正在改写' : '按等级改写'}
                    aria-label={isRewriting ? '正在改写' : '按等级改写'}
                  >
                    <PenLine className="w-4 h-4 text-[#C35E37] shrink-0" />
                    <span>{isRewriting ? '正在改写…' : '按等级改写'}</span>
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
                            className={`min-h-11 py-2 rounded-lg text-center text-xs font-semibold border transition-colors ${
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

      <SpeechFeedback state={speech.state} onStop={speech.stop} floating />

      <main className="reading-content flex-1 max-w-3xl w-full mx-auto px-5 py-8 sm:px-8 sm:py-12 pb-10 sm:pb-[max(7rem,calc(5.5rem+env(safe-area-inset-bottom,0px)))]">
        <header className="reading-article-header mb-8 sm:mb-10">
          <h2
            data-reading-article-title="true"
            data-reading-context="title"
            data-reading-article-id={article.id}
            className="[font-family:var(--font-display)] text-[1.875rem] sm:text-[2.5rem] font-semibold leading-[1.15] tracking-[-0.025em] text-[#2A2621] break-words"
          >
            {renderInteractiveParagraph(article.title, article)}
          </h2>
          {(article.levelRating?.level || article.level || article.source) && (
            <p className="mt-3 text-xs leading-6 text-[#7B7267]">
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
        {article.sourceDocument && <PdfPagePreview source={article.sourceDocument} scanned={!article.content.length} autoOpen={!article.content.length && !articleMedia[article.id]?.length} />}
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

        {importJob?.status !== 'completed' && (importJob?.status === 'queued'
          || importJob?.status === 'processing'
          || article.importEnrichmentStatus === 'pending'
          || article.importEnrichmentStatus === 'processing'
          || (needsImportEnrichment(article) && article.importEnrichmentStatus !== 'failed')) && (
          <div className="mb-4 p-3 bg-[#E0F2FE] border border-[#BAE6FD] rounded-xl text-xs text-[#075985] space-y-1">
            <p>原文已就绪，译文正在准备。可继续阅读。</p>
          </div>
        )}

        {(importJob?.status === 'failed' || article.importEnrichmentStatus === 'failed') && (
          <div className="mb-4 p-3 bg-[#FEE2E2] border border-[#FECACA] rounded-xl text-xs text-[#991B1B] flex items-start justify-between gap-3">
            <div>
              <p className="font-semibold">译文或难度信息暂未完成，原文仍可阅读</p>
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
          className={`reading-prose [font-family:var(--font-reading)] text-[#2B2723] space-y-8 sm:space-y-10 select-text break-words [overflow-wrap:anywhere] ${getFontSizeClass()}`}
        >
          <section className="space-y-6 sm:space-y-7" data-reading-article-section={article.id} data-reading-article-id={article.id}>
            <ArticleMediaFigures media={articleMedia[article.id]} paragraphs={article.content} afterParagraphIndex={-1} />
            {article.content.map((paragraph, pIdx) => {
            const paragraphKind = classifyArticleParagraph(paragraph, article.title);
            if (paragraphKind === 'furniture' || paragraphKind === 'title') {
              return <ArticleMediaFigures key={pIdx} media={articleMedia[article.id]} paragraphs={article.content} afterParagraphIndex={pIdx} />;
            }

            const zh = article.paragraphTranslations?.[pIdx];
            const inlineContent = paragraphKind === 'author'
              ? paragraph
              : renderInteractiveParagraph(paragraph, article);

            const translationClassName = paragraphKind === 'author'
              ? 'font-sans text-xs sm:text-sm leading-relaxed text-[#9A9185] pl-3'
              : 'font-sans text-[0.85em] leading-relaxed text-[#6B645B] bg-[#F3F0E8] border border-[#E7E2D5] rounded-xl px-3 py-2.5';

            return (
              <div
                key={pIdx}
                className={
                  paragraphKind === 'author'
                    ? 'space-y-2 pt-1 pb-2'
                    : 'space-y-2'
                }
              >
                <p
                    data-reading-paragraph={pIdx}
                    data-reading-article-id={article.id}
                    data-reading-last-paragraph={pIdx === currentLastParagraphIndex ? 'true' : undefined}
                    className={
                      paragraphKind === 'author'
                        ? 'font-sans text-sm sm:text-base font-bold leading-relaxed tracking-normal text-[#6C655C] pl-3 border-l-2 border-[#C35E37]'
                        : 'tracking-normal'
                    }
                  >
                    {inlineContent}
                </p>
                {showParagraphTranslations && zh && (
                  <p className={translationClassName}>
                    {zh}
                  </p>
                )}
                <ArticleMediaFigures media={articleMedia[article.id]} paragraphs={article.content} afterParagraphIndex={pIdx} />
              </div>
            );
            })}
            <ReadingVerificationPause key={article.id} articleId={article.id}
              excludedContextTexts={article.content}
              articleTitle={article.title} readingComplete={verificationReadyArticleIds.has(article.id)}
              level={article.levelRating?.level || article.level || preferredCefrLevel}
              onActiveChange={handleVerificationActiveChange} />
          </section>

          {onDifficultyFeedback && <ReadingDifficultyControl value={difficultyFeedback} onChange={onDifficultyFeedback} />}
          {onNextArticle && <button data-reading-interaction="true" className="mb-4 min-h-11 rounded-xl border border-stone-300 px-4 font-sans text-sm" onClick={() => {
            window.getSelection()?.removeAllRanges();
            if (mode === 'recommendation-feed') advanceToNextRecommendedArticle();
            else onNextArticle();
          }}>{nextArticleLabel}</button>}
          {continuationArticleList.map((nextArticle) => {
            const nextLastParagraphIndex = nextArticle.content.reduce(
              (lastIndex, paragraph, index) => {
                const kind = classifyArticleParagraph(paragraph, nextArticle.title);
                return kind === 'furniture' || kind === 'title' ? lastIndex : index;
              },
              -1,
            );
            return (
              <section
                key={nextArticle.id}
                data-reading-article-section={nextArticle.id}
                data-reading-article-id={nextArticle.id}
                className="mt-12 border-t border-[#E7E2D5] pt-10"
              >
                <header className="reading-article-header mb-8 sm:mb-10">
                  <h2
                    data-reading-article-title="true"
                    data-reading-context="title"
                    data-reading-article-id={nextArticle.id}
                    className="[font-family:var(--font-display)] text-[1.875rem] sm:text-[2.5rem] font-semibold leading-[1.15] tracking-[-0.025em] text-[#2A2621]"
                  >
                    {renderInteractiveParagraph(nextArticle.title, nextArticle)}
                  </h2>
                  {(nextArticle.levelRating?.level || nextArticle.level || nextArticle.source) && (
                    <p className="mt-3 font-sans text-xs leading-6 text-[#7B7267]">
                      {nextArticle.levelRating?.level || nextArticle.level
                        ? `CEFR ${nextArticle.levelRating?.level || nextArticle.level}`
                        : null}
                      {(nextArticle.levelRating?.level || nextArticle.level) && nextArticle.source ? ' · ' : null}
                      {nextArticle.source || null}
                    </p>
                  )}
                </header>
                <div className="space-y-6 sm:space-y-7">
                  {nextArticle.sourceDocument && <PdfPagePreview source={nextArticle.sourceDocument} scanned={!nextArticle.content.length} autoOpen={!nextArticle.content.length && !articleMedia[nextArticle.id]?.length} />}
                  <ArticleMediaFigures media={articleMedia[nextArticle.id]} paragraphs={nextArticle.content} afterParagraphIndex={-1} />
                  {nextArticle.content.map((paragraph, pIdx) => {
                    const paragraphKind = classifyArticleParagraph(paragraph, nextArticle.title);
                    if (paragraphKind === 'furniture' || paragraphKind === 'title') {
                      return <ArticleMediaFigures key={pIdx} media={articleMedia[nextArticle.id]} paragraphs={nextArticle.content} afterParagraphIndex={pIdx} />;
                    }
                    const inlineContent = paragraphKind === 'author'
                      ? paragraph
                      : renderInteractiveParagraph(paragraph, nextArticle);
                    const translation = nextArticle.paragraphTranslations?.[pIdx];
                    return (
                      <div key={pIdx} className="space-y-2">
                        <p
                            data-reading-paragraph={pIdx}
                            data-reading-article-id={nextArticle.id}
                            data-reading-last-paragraph={pIdx === nextLastParagraphIndex ? 'true' : undefined}
                            className={paragraphKind === 'author'
                              ? 'font-sans text-sm sm:text-base font-bold leading-relaxed text-[#6C655C] pl-3 border-l-2 border-[#C35E37]'
                              : 'tracking-normal'}
                          >
                            {inlineContent}
                        </p>
                        {showParagraphTranslations && translation && (
                          <p className="font-sans text-[0.85em] leading-relaxed text-[#6B645B] bg-[#F3F0E8] border border-[#E7E2D5] rounded-xl px-3 py-2.5">
                            {translation}
                          </p>
                        )}
                        <ArticleMediaFigures media={articleMedia[nextArticle.id]} paragraphs={nextArticle.content} afterParagraphIndex={pIdx} />
                      </div>
                    );
                  })}
                </div>
                <ReadingVerificationPause key={nextArticle.id} articleId={nextArticle.id}
                  excludedContextTexts={nextArticle.content}
                  articleTitle={nextArticle.title} readingComplete={verificationReadyArticleIds.has(nextArticle.id)}
                  level={nextArticle.levelRating?.level || nextArticle.level || preferredCefrLevel}
                  onActiveChange={handleVerificationActiveChange} />
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

      {selectionAction && createPortal(
        <div className="reading-selection-actions" role="toolbar" aria-label="选中文本操作"
          style={{ left: Math.max(12, Math.min(selectionAction.anchor.left, window.innerWidth - 270)), top: Math.max(12, Math.min(selectionAction.anchor.bottom + 8, window.innerHeight - 60)) }}
          onPointerDown={event => event.preventDefault()}>
          <button onClick={() => { setLookupAnchor(selectionAction.anchor); void openWordCard(selectionAction.text, selectionAction.context); setSelectionAction(null); }}>解释</button>
          <button onClick={() => { quoteSelectedText(selectionAction.text); setSelectionAction(null); }}>讨论</button>
          <button onClick={() => { void copyTextToClipboard(selectionAction.text).then(ok => flashCopyHint(ok ? '已复制' : '复制失败')); setSelectionAction(null); }}>复制</button>
          <button aria-label="关闭选词操作" onClick={() => setSelectionAction(null)}>×</button>
        </div>, document.body,
      )}
      <ReadingLookupCard
        open={wordCardOpen}
        anchor={lookupAnchor}
        error={wordCardError}
        onRetry={() => retryLookupRef.current()}
        recordStatus={lookupRecordStatus}
        onRetryRecord={retryRecordRef.current ?? undefined}
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
              <p className="text-xs leading-5 text-[#7B7267] mt-0.5 pl-5">
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


