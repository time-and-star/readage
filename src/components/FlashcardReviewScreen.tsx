import React, { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowRight, Check, ChevronDown, RotateCcw, Settings2, Volume2 } from 'lucide-react';
import { AppPageHeader } from './AppPageHeader';
import { DictionarySenseGroups } from './DictionarySenseGroups';
import { DictionaryOriginalContent } from './DictionaryOriginalContent';
import { DictionarySourceSections } from './DictionarySourceSections';
import { DictionarySourceIssues } from './DictionarySourceIssues';
import { SpeechFeedback } from './SpeechControls';
import { ForgettingCurvePanel } from './ForgettingCurvePanel';
import { FlashcardStudySettings } from './FlashcardStudySettings';
import { WordMemoryDetailsPanel } from './WordMemoryDetailsPanel';
import { buildWordMemoryDetails } from '../lib/wordMemoryDetails';
import { resolveLearningWordIds } from '../lib/dictionaryClient';
import { createWordCardRequest, fetchWordCard } from '../lib/wordCard';
import { getCompactWordCard } from '../lib/compactWordCard';
import type { FlashcardStudyPreferences } from '../lib/flashcardPreferences';
import { getFlashcardPlanSettingsKey, reconcileFlashcardSession, shouldRefreshFlashcardSession } from '../lib/flashcardSessionSettings';
import { useMemoryStore } from '../lib/memoryV2';
import type { WordMemoryState } from '../lib/memoryV2/types';
import {
  advanceFlashcardSession,
  buildFlashcardQueue,
  correctFlashcardRating,
  getManagedFlashcardWordIds,
  previewFlashcardIntervals,
  submitFlashcardRating,
  type FlashcardQueueCard,
  type FlashcardRating,
} from '../lib/flashcardReview';
import { useSpeech } from '../lib/speech/useSpeech';
import type { GrammarExplanation } from '../types';
import './flashcardReview.css';

interface FlashcardReviewScreenProps {
  navigation: React.ReactNode;
  onBack: () => void;
  onOpenReading: () => void;
}

const ratings: Array<{ value: FlashcardRating; label: string; description: string }> = [
  { value: 'again', label: '忘记了', description: '没有想起来' },
  { value: 'hard', label: '有点模糊', description: '费力才想起' },
  { value: 'good', label: '记住了', description: '顺利想起来' },
  { value: 'easy', label: '很熟悉', description: '立刻想起来' },
];

interface SavedReview {
  key: string;
  rating: FlashcardRating;
  revision: number;
  attemptId?: string;
  state?: WordMemoryState;
}
function savedReviewFor(key: string, attemptId: string, state: WordMemoryState, fallback: FlashcardRating): SavedReview {
  const review = state.fsrsReviews.find(row => row.verificationAttemptIds?.includes(attemptId));
  return { key, attemptId, state, rating: ratings[(review?.rating ?? 0) - 1]?.value ?? fallback,
    revision: review?.flashcardRevisions?.length ?? 0 };
}

const artVariants = [
  '/art/word-memory-nocturne.webp',
  '/art/word-memory-verdant.webp',
  '/art/word-memory-violet.webp',
  '/art/word-memory-ochre.webp',
];

function artworkStyle(identity: string): React.CSSProperties {
  let seed = 2166136261;
  for (let index = 0; index < identity.length; index += 1) seed = Math.imul(seed ^ identity.charCodeAt(index), 16777619);
  return { '--flashcard-art': `url("${artVariants[(seed >>> 0) % artVariants.length]}")` } as React.CSSProperties;
}

function newAttemptId(): string {
  return `flashcard:${typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID() : `${Date.now()}:${Math.random().toString(36).slice(2)}`}`;
}

function intervalLabel(milliseconds: number): string {
  const minutes = Math.max(1, Math.round(milliseconds / 60_000));
  if (minutes < 60) return `${minutes} 分钟后`;
  const hours = Math.round(milliseconds / 3_600_000);
  if (hours < 24) return `${hours} 小时后`;
  const days = Math.max(1, Math.round(milliseconds / 86_400_000));
  return `${days} 天后`;
}

function reviewDateLabel(value: string | null | undefined, timezone: string): string | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: timezone,
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(value));
}

export const FlashcardReviewScreen: React.FC<FlashcardReviewScreenProps> = ({ navigation, onBack, onOpenReading }) => {
  const store = useMemoryStore();
  const version = useSyncExternalStore(store.subscribe, () => store.getSnapshot().version, () => store.getSnapshot().version);
  const speech = useSpeech();
  const answerId = useId();
  const revealRef = useRef<HTMLButtonElement>(null);
  const backActionRef = useRef<HTMLButtonElement>(null);
  const mountedRef = useRef(true);
  const [states, setStates] = useState<WordMemoryState[]>([]);
  const [canonicalWordIds, setCanonicalWordIds] = useState<Map<string, string>>(new Map());
  const [preferences, setPreferences] = useState<FlashcardStudyPreferences>({ dailyNewWordLimit: 10, importedWordIds: [] });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [identityNotice, setIdentityNotice] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [queue, setQueue] = useState<FlashcardQueueCard[] | null>(null);
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const sessionInitializedRef = useRef(false);
  const settingsKeyRef = useRef<string | null>(null);
  const [encounter, setEncounter] = useState(0);
  const [initialTotal, setInitialTotal] = useState(0);
  const [reviewedCount, setReviewedCount] = useState(0);
  const reviewedCountRef = useRef(reviewedCount);
  reviewedCountRef.current = reviewedCount;
  const [skippedCards, setSkippedCards] = useState<FlashcardQueueCard[]>([]);
  const skippedCardsRef = useRef(skippedCards);
  skippedCardsRef.current = skippedCards;
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [ratedReview, setRatedReview] = useState<SavedReview | null>(null);
  const ratedReviewRef = useRef<SavedReview | null>(null);
  const [correctionOpen, setCorrectionOpen] = useState(false);
  const correctionRef = useRef<{ correctionId: string; attemptId: string; wordId: string; rating: FlashcardRating; expectedRevision: number } | null>(null);
  const [flipTransition, setFlipTransition] = useState<{ key: string; phase: 'out' | 'in' } | null>(null);
  const flipLockRef = useRef(false);
  const flipTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const [dictionaryResult, setDictionaryCard] = useState<GrammarExplanation | null>(null);
  const [lookupLoading, setDictionaryLoading] = useState(false);
  const [lookupError, setDictionaryError] = useState<string | null>(null);
  const [dictionaryKey, setDictionaryKey] = useState<string | null>(null);
  const [dictionaryRetry, setDictionaryRetry] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [reloadAvailable, setReloadAvailable] = useState(false);
  const submissionRef = useRef<{ attemptId: string; wordId: string; rating: FlashcardRating } | null>(null);
  const advanceLockRef = useRef(false);
  const [savedMessage, setSavedMessage] = useState('');

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void (async () => {
      try {
        await store.ensureReady();
        const [nextStates, nextPreferences] = await Promise.all([
          store.system.getReadingVerificationMemoryStates(store.userId),
          store.system.getFlashcardStudyPreferences(store.userId),
        ]);
        if (!active) return;
        const candidates = nextStates.map(state => state.wordId);
        const nextCanonical = new Map<string, string>();
        let resolverTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          const ids = await Promise.race([
            resolveLearningWordIds(candidates),
            new Promise<never>((_, reject) => { resolverTimer = setTimeout(() => reject(new Error('Word identity lookup timed out')), 5000); }),
          ]);
          candidates.forEach((word, index) => nextCanonical.set(word, ids[index]));
          if (active) setIdentityNotice(null);
        } catch {
          if (active) setIdentityNotice('词形归并暂不可用，已按现有词汇记录准备词卡。');
        } finally {
          if (resolverTimer) clearTimeout(resolverTimer);
        }
        if (!active) return;
        setStates(nextStates);
        setPreferences(nextPreferences);
        setCanonicalWordIds(nextCanonical);
        setLoadError(null);
        const nextQueue = buildFlashcardQueue(nextStates, { timezone: store.timezone, canonicalWordIds: nextCanonical,
          newWordLimit: nextPreferences.dailyNewWordLimit, enrolledWordIds: new Set(nextPreferences.importedWordIds), pausedWordIds: new Set(nextPreferences.pausedWordIds ?? []), excludedWordIds: new Set(nextPreferences.excludedWordIds ?? []) });
        if (!sessionInitializedRef.current || shouldRefreshFlashcardSession(queueRef.current ?? [],
          settingsKeyRef.current, getFlashcardPlanSettingsKey(nextPreferences))) {
          applyFreshStudyPlan(nextStates, nextPreferences, nextCanonical, nextQueue.cards);
        }
      } catch {
        if (active) setLoadError('词汇记录暂时无法读取，请再试一次。');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [store, version, refreshKey]);

  const current = queue?.[0] ?? null;
  const currentKey = current ? `${encounter}:${current.wordId}:${current.isPractice}` : null;
  const currentKeyRef = useRef(currentKey);
  currentKeyRef.current = currentKey;
  const revealed = !!currentKey && revealedKey === currentKey;
  const rated = !!currentKey && ratedReview?.key === currentKey;
  const flipPhase = flipTransition?.key === currentKey ? flipTransition.phase : null;
  const dictionaryCard = dictionaryKey === currentKey ? dictionaryResult : null;
  const dictionaryLoading = !!current && (dictionaryKey !== currentKey || lookupLoading);
  const dictionaryError = dictionaryKey === currentKey ? lookupError : null;
  const queueSummary = useMemo(() => buildFlashcardQueue(states, { timezone: store.timezone, canonicalWordIds,
    newWordLimit: preferences.dailyNewWordLimit, enrolledWordIds: new Set(preferences.importedWordIds), pausedWordIds: new Set(preferences.pausedWordIds ?? []), excludedWordIds: new Set(preferences.excludedWordIds ?? []) }), [states, store.timezone, canonicalWordIds, preferences]);
  const compactCard = useMemo(() => dictionaryCard ? getCompactWordCard(dictionaryCard, current?.wordId) : null, [dictionaryCard, current?.wordId]);
  const hasAnswer = Boolean(compactCard?.meaningZh || compactCard?.definitionEn || compactCard?.originalText);
  const hasDictionaryDetails = Boolean(dictionaryCard?.dictionarySources?.length || dictionaryCard?.dictionaryRecord || dictionaryCard?.originalDictionaryContent || dictionaryCard?.senses?.length);
  const hasSourceNotices = Boolean(dictionaryCard?.dictionarySourceIssues?.length || dictionaryCard?.dictionarySourceMisses?.length);
  const hasAnswerDetails = Boolean(current?.contextTexts?.[0] || hasDictionaryDetails || hasSourceNotices || compactCard?.partOfSpeech || (compactCard?.meaningZh && compactCard?.definitionEn));
  const previews = useMemo(() => {
    if (!current || current.isPractice) return null;
    try { return previewFlashcardIntervals(current.state); } catch { return null; }
  }, [current]);

  useEffect(() => {
    if (!queueSummary.nextDueAt) return;
    const nextDue = Date.parse(queueSummary.nextDueAt);
    if (!Number.isFinite(nextDue)) return;
    const timer = window.setTimeout(() => setRefreshKey(key => key + 1), Math.min(2_147_483_647, Math.max(100, nextDue - Date.now() + 50)));
    return () => window.clearTimeout(timer);
  }, [queueSummary.nextDueAt]);

  useEffect(() => {
    flipTimersRef.current.forEach(timer => clearTimeout(timer));
    flipTimersRef.current = [];
    flipLockRef.current = false;
    setFlipTransition(null);
    setRatedReview(null);
    ratedReviewRef.current = null;
    setCorrectionOpen(false);
    correctionRef.current = null;
    setSaveError(null);
    setReloadAvailable(false);
    setSavedMessage('');
    submissionRef.current = null;
    advanceLockRef.current = false;
    speech.stop();
    return () => {
      flipTimersRef.current.forEach(timer => clearTimeout(timer));
      flipTimersRef.current = [];
      flipLockRef.current = false;
    };
  }, [currentKey, speech.stop]);

  useEffect(() => {
    if (flipPhase || saving) return;
    if (revealed) backActionRef.current?.focus({ preventScroll: true });
    else revealRef.current?.focus({ preventScroll: true });
  }, [currentKey, revealed, flipPhase, rated, saving]);

  useEffect(() => {
    setDictionaryKey(currentKey);
    setDictionaryCard(null);
    setDictionaryError(null);
    if (!current) { setDictionaryLoading(false); return; }
    const controller = new AbortController();
    setDictionaryLoading(true);
    const request = createWordCardRequest(current.canonicalWordId);
    if (!request) { setDictionaryLoading(false); setDictionaryError('这个词的查询内容无效。'); return; }
    void fetchWordCard(request, { signal: controller.signal, forceRefresh: dictionaryRetry > 0 }).then(card => {
      if (controller.signal.aborted) return;
      setDictionaryCard(card);
    }).catch(error => {
      if (!controller.signal.aborted) setDictionaryError(error instanceof Error ? error.message : '释义暂时无法加载。重试成功后即可继续复习。');
    }).finally(() => {
      if (!controller.signal.aborted) setDictionaryLoading(false);
    });
    return () => controller.abort();
  }, [currentKey, dictionaryRetry]);

  useEffect(() => {
    const refresh = () => setDictionaryRetry(value => value + 1);
    window.addEventListener('dictionary-settings-changed', refresh);
    return () => window.removeEventListener('dictionary-settings-changed', refresh);
  }, []);

  useEffect(() => {
    if (!current) return;
    let cancel: (() => void) | undefined;
    const timer = window.setTimeout(() => { cancel = speech.prepare(current.canonicalWordId); }, 150);
    return () => { window.clearTimeout(timer); cancel?.(); };
  }, [current?.canonicalWordId, speech.prepare, speech.preferences.lang, speech.preferences.rate]);

  const turnCard = (showAnswer: boolean) => {
    if (!currentKey || showAnswer === revealed || flipLockRef.current) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setRevealedKey(showAnswer ? currentKey : null);
      return;
    }
    flipLockRef.current = true;
    setFlipTransition({ key: currentKey, phase: 'out' });
    const targetKey = currentKey;
    flipTimersRef.current = [
      setTimeout(() => {
        if (!mountedRef.current) return;
        setRevealedKey(showAnswer ? targetKey : null);
        setFlipTransition({ key: targetKey, phase: 'in' });
      }, 225),
      setTimeout(() => {
        if (!mountedRef.current) return;
        flipLockRef.current = false;
        setFlipTransition(null);
        flipTimersRef.current = [];
      }, 450),
    ];
  };

  const advanceRatedCard = () => {
    const saved = ratedReviewRef.current;
    if (!current || !saved || saved.key !== currentKey || saving || saveError || correctionOpen
      || correctionRef.current || flipLockRef.current || advanceLockRef.current) return;
    advanceLockRef.current = true;
    if (!current.isPractice) setReviewedCount(value => value + 1);
    setQueue(previous => advanceFlashcardSession(previous ?? [], current.wordId, saved.rating));
    setEncounter(value => value + 1);
  };

  const activateCard = () => {
    if (saving || saveError || correctionOpen || correctionRef.current || flipLockRef.current || advanceLockRef.current) return;
    if (revealed && ratedReviewRef.current?.key === currentKey) advanceRatedCard();
    else turnCard(!revealed);
  };

  const rate = async (rating: FlashcardRating) => {
    if (!current || !currentKey || saving || advanceLockRef.current || flipLockRef.current
      || ratedReviewRef.current?.key === currentKey || (revealed && !submissionRef.current)) return;
    if (current.isPractice) {
      ratedReviewRef.current = { key: currentKey, rating, revision: 0 };
      setRatedReview(ratedReviewRef.current);
      setSavedMessage(rating === 'again' ? '这张卡稍后再巩固一次。' : '巩固完成。');
      turnCard(true);
      return;
    }
    advanceLockRef.current = true;
    const submission = submissionRef.current ?? { attemptId: newAttemptId(), wordId: current.wordId, rating };
    submissionRef.current = submission;
    setSaving(true);
    setSaveError(null);
    try {
      const nextState = await submitFlashcardRating(store, submission);
      if (!mountedRef.current) return;
      setStates(previous => previous.map(state => state.wordId === current.wordId ? nextState : state));
      ratedReviewRef.current = savedReviewFor(currentKey, submission.attemptId, nextState, submission.rating);
      setRatedReview(ratedReviewRef.current);
      setSavedMessage(`${current.wordId} 已保存，下次复习 ${reviewDateLabel(nextState.nextReview, store.timezone) ?? '已安排'}。`);
      advanceLockRef.current = false;
      turnCard(true);
    } catch (cause) {
      if (mountedRef.current) {
        advanceLockRef.current = false;
        const message = cause instanceof Error ? cause.message : '保存未完成，请重试；本次回忆记录已保留。';
        setSaveError(message);
        setReloadAvailable(/尚未到期|刷新词卡|不存在|校正时间|没有查询/.test(message));
      }
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };

  const correctRating = async (rating: FlashcardRating) => {
    const saved = ratedReviewRef.current;
    if (!current || !currentKey || !saved?.attemptId || saved.key !== currentKey || !revealed
      || saving || flipLockRef.current || advanceLockRef.current) return;
    const correction = correctionRef.current ?? { correctionId: newAttemptId(), attemptId: saved.attemptId,
      wordId: current.wordId, rating, expectedRevision: saved.revision };
    correctionRef.current = correction;
    advanceLockRef.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      const nextState = await correctFlashcardRating(store, correction);
      if (!mountedRef.current) return;
      setStates(previous => previous.map(state => state.wordId === current.wordId ? nextState : state));
      ratedReviewRef.current = savedReviewFor(currentKey, saved.attemptId, nextState, correction.rating);
      setRatedReview(ratedReviewRef.current);
      correctionRef.current = null;
      setCorrectionOpen(false);
      setSavedMessage(`本次评分已改为“${ratings.find(row => row.value === ratedReviewRef.current!.rating)?.label}”，下次复习 ${reviewDateLabel(nextState.nextReview, store.timezone) ?? '已安排'}。`);
    } catch (cause) {
      if (mountedRef.current) {
        setCorrectionOpen(true);
        setSaveError(cause instanceof Error ? cause.message : '评分修改未完成，请重试。');
      }
    } finally {
      if (mountedRef.current) { advanceLockRef.current = false; setSaving(false); }
    }
  };

  const reloadRatedReview = async () => {
    const saved = ratedReviewRef.current;
    const original = submissionRef.current;
    if (!currentKey || !saved?.attemptId || !original || saving) return;
    setSaving(true);
    advanceLockRef.current = true;
    try {
      // Replaying the original identity repairs a saved correction without
      // allowing the old submission to replace the corrected rating.
      const nextState = await submitFlashcardRating(store, original);
      if (!mountedRef.current) return;
      setStates(previous => previous.map(state => state.wordId === original.wordId ? nextState : state));
      ratedReviewRef.current = savedReviewFor(currentKey, saved.attemptId, nextState, saved.rating);
      setRatedReview(ratedReviewRef.current);
      correctionRef.current = null;
      setCorrectionOpen(false);
      setSaveError(null);
      setSavedMessage(`已重新读取本次评分：“${ratings.find(row => row.value === ratedReviewRef.current!.rating)?.label}”。`);
    } catch (cause) {
      if (mountedRef.current) setSaveError(cause instanceof Error ? cause.message : '本次评分暂未重新读取，请重试。');
    } finally {
      if (mountedRef.current) { advanceLockRef.current = false; setSaving(false); }
    }
  };

  const skip = () => {
    if (!current || saving || advanceLockRef.current || submissionRef.current || flipLockRef.current || ratedReviewRef.current?.key === currentKey) return;
    advanceLockRef.current = true;
    if (!current.isPractice) setSkippedCards(previous => [...previous, current]);
    setQueue(previous => (previous ?? []).filter(card => card.wordId !== current.wordId));
    setEncounter(value => value + 1);
    setSavedMessage(`${current.wordId} 已暂时跳过，复习时间未改变。`);
  };

  const startNextBatch = (cards: FlashcardQueueCard[]) => {
    queueRef.current = cards;
    reviewedCountRef.current = 0;
    skippedCardsRef.current = [];
    setInitialTotal(cards.filter(card => !card.isPractice).length);
    setReviewedCount(0);
    setSkippedCards([]);
    setSavedMessage('');
    setQueue(cards);
    setEncounter(value => value + 1);
  };

  const applyFreshStudyPlan = (nextStates: WordMemoryState[], nextPreferences: FlashcardStudyPreferences,
    nextCanonical: Map<string, string>, plannedCards?: FlashcardQueueCard[]) => {
    setStates(nextStates);
    setPreferences(nextPreferences);
    setCanonicalWordIds(nextCanonical);
    settingsKeyRef.current = getFlashcardPlanSettingsKey(nextPreferences);
    const cards = plannedCards ?? buildFlashcardQueue(nextStates, { timezone: store.timezone, canonicalWordIds: nextCanonical,
      newWordLimit: nextPreferences.dailyNewWordLimit, enrolledWordIds: new Set(nextPreferences.importedWordIds), pausedWordIds: new Set(nextPreferences.pausedWordIds ?? []), excludedWordIds: new Set(nextPreferences.excludedWordIds ?? []) }).cards;
    const previous = queueRef.current ?? [];
    const inactive = new Set([...nextPreferences.pausedWordIds ?? [], ...nextPreferences.excludedWordIds ?? []]);
    const activeSkipped = skippedCardsRef.current.filter(card => !inactive.has(nextCanonical.get(card.wordId) ?? card.canonicalWordId) && !inactive.has(card.wordId));
    if (!previous.length && !activeSkipped.length) {
      startNextBatch(cards);
      sessionInitializedRef.current = cards.length > 0;
      return;
    }
    skippedCardsRef.current = activeSkipped;
    setSkippedCards(activeSkipped);
    const normalizedPrevious = previous.filter(card => !inactive.has(nextCanonical.get(card.wordId) ?? card.canonicalWordId) && !inactive.has(card.wordId)).map(card => {
      const canonicalWordId = nextCanonical.get(card.wordId) ?? card.canonicalWordId;
      return canonicalWordId === card.canonicalWordId ? card : { ...card, canonicalWordId };
    });
    const nextQueue = reconcileFlashcardSession(normalizedPrevious, cards,
      new Set(activeSkipped.map(card => nextCanonical.get(card.wordId) ?? card.canonicalWordId)),
      ratedReviewRef.current?.key === currentKeyRef.current
        || submissionRef.current?.wordId === previous[0]?.wordId && Boolean(submissionRef.current));
    queueRef.current = nextQueue;
    setQueue(nextQueue);
    setInitialTotal(reviewedCountRef.current + activeSkipped.length + nextQueue.filter(card => !card.isPractice).length);
    sessionInitializedRef.current = true;
  };

  const refreshStudyPlan = async (nextCanonical = canonicalWordIds) => {
    const [nextStates, nextPreferences] = await Promise.all([
      store.system.getReadingVerificationMemoryStates(store.userId),
      store.system.getFlashcardStudyPreferences(store.userId),
    ]);
    if (mountedRef.current) applyFreshStudyPlan(nextStates, nextPreferences, nextCanonical);
  };

  const saveStudyLimit = async (dailyNewWordLimit: number | null) => {
    await store.saveFlashcardStudyPreferences(dailyNewWordLimit);
    await refreshStudyPlan();
  };

  const updateStudyWords = async (wordIds: string[], action: 'pause' | 'resume' | 'remove') => {
    const targets = new Set(wordIds);
    // Keep legacy aliases excluded even if the dictionary resolver later goes offline.
    for (const [alias, canonical] of canonicalWordIds) if (targets.has(canonical)) targets.add(alias);
    await store.updateFlashcardWords([...targets], action);
    await refreshStudyPlan();
  };

  const importStudyWords = async (wordIds: string[]) => {
    const existingStates = await store.system.getReadingVerificationMemoryStates(store.userId);
    const existingIds = existingStates.map(state => state.wordId);
    const ids = await resolveLearningWordIds(existingIds);
    const nextCanonical = new Map(existingIds.map((word, index) => [word, ids[index]]));
    wordIds.forEach(word => nextCanonical.set(word, word));
    const result = await store.importFlashcardWords(wordIds, nextCanonical);
    await refreshStudyPlan(nextCanonical);
    return result;
  };

  const reloadQueue = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await store.ensureReady();
      const pending = submissionRef.current;
      if (pending) {
        // A write-ahead attempt can exist even after a failed derived-state write.
        // Repair that exact attempt before changing the visible session.
        const history = await store.system.getFlashcardReviewHistory(store.userId);
        if (history.some(attempt => attempt.attemptId === pending.attemptId)) {
          await submitFlashcardRating(store, pending);
        }
      }
      const nextStates = await store.system.getReadingVerificationMemoryStates(store.userId);
      if (!mountedRef.current) return;
      setStates(nextStates);
      const nextPreferences = await store.system.getFlashcardStudyPreferences(store.userId);
      setPreferences(nextPreferences);
      startNextBatch(buildFlashcardQueue(nextStates, { timezone: store.timezone, canonicalWordIds,
        newWordLimit: nextPreferences.dailyNewWordLimit, enrolledWordIds: new Set(nextPreferences.importedWordIds), pausedWordIds: new Set(nextPreferences.pausedWordIds ?? []), excludedWordIds: new Set(nextPreferences.excludedWordIds ?? []) }).cards);
      setSaveError(null);
      setReloadAvailable(false);
      setSavedMessage('已重新读取复习安排。');
    } catch (cause) {
      if (mountedRef.current) setSaveError(cause instanceof Error ? cause.message : '词卡暂未重新加载，请重试。');
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };

  const finished = queue !== null && queue.length === 0;
  const progress = initialTotal ? Math.min(100, (reviewedCount + skippedCards.length) / initialTotal * 100) : 0;
  const nextDueLabel = reviewDateLabel(queueSummary.nextDueAt, store.timezone);
  const currentArtwork = artworkStyle(current?.canonicalWordId ?? 'ReadAge');
  const savedDetails = ratedReview?.key === currentKey && ratedReview.state
    ? buildWordMemoryDetails(ratedReview.state, preferences, new Date(), current?.canonicalWordId) : null;

  return <div className="flashcard-screen">
    <AppPageHeader onBack={onBack} navigation={navigation} />
    <main className="flashcard-review safe-pb">
      <div className="flashcard-review__heading">
        <h1>词卡学习</h1>
        <div className="flashcard-review__heading-actions">
          {queue !== null && <p className="flashcard-review__counts"><span>到期 <strong>{queueSummary.dueCount}</strong></span><span>待学 <strong>{queueSummary.remainingNewCount}</strong></span></p>}
          <button type="button" className="flashcard-review__settings" aria-label="学习设置" title="学习设置" disabled={loading || saving || !!flipPhase || !!saveError || correctionOpen} onClick={() => setSettingsOpen(true)}><Settings2 size={18} aria-hidden="true" /></button>
        </div>
      </div>

      <div className="sr-only" role="status" aria-live="polite">{savedMessage}</div>
      {savedMessage && !rated && <p className="flashcard-review__feedback">{savedMessage}</p>}

      {queue === null ? <section className="flashcard-review__state flashcard-review__state--collection" aria-busy={loading}>
        <div className="flashcard-collection-art" style={artworkStyle('ReadAge')} aria-hidden="true"><span className="flashcard-collection-art__edition">READAGE — A WORD COLLECTION</span><span className="flashcard-collection-art__poem">A little.<br/>Every day.</span></div>
        <div className="flashcard-review__state-copy">{loadError ? <><RotateCcw size={25} aria-hidden="true" /><h2>词库暂时未能打开</h2><p role="alert">{loadError}</p><button type="button" className="flashcard-review__primary" onClick={() => setRefreshKey(key => key + 1)}>重新加载 <ArrowRight size={16} aria-hidden="true" /></button></>
          : <><span className="flashcard-review__loader" aria-hidden="true" /><h2>正在准备你的词卡</h2><p role="status">读取学习记录，优先安排到期的单词。</p></>}</div>
      </section> : current ? <section className="flashcard-session" aria-label="单词回忆练习">
        <div className="flashcard-session__progress-copy"><span>{current.isPractice ? '再巩固一次' : current.kind === 'due' ? '到期复习' : '初次回忆'}</span><span>已复习 {reviewedCount} / {initialTotal}</span></div>
        <div className="flashcard-session__progress" role="progressbar" aria-label="本轮词卡进度" aria-valuemin={0} aria-valuemax={initialTotal || 1} aria-valuenow={reviewedCount + skippedCards.length} aria-valuetext={`已复习 ${reviewedCount} 个，暂跳过 ${skippedCards.length} 个，共 ${initialTotal} 个`}><span style={{ width: `${progress}%` }} /></div>

        <article className={`flashcard-sheet ${revealed ? 'flashcard-sheet--revealed' : ''} ${flipPhase ? `flashcard-sheet--flip-${flipPhase}` : ''}`} style={currentArtwork} aria-labelledby={`${answerId}-word`} aria-describedby={revealed ? `${answerId}-hint` : undefined}
          onClick={event => { if (!(event.target as Element).closest('button,a,summary,details,input,select,textarea')) activateCard(); }}
          aria-busy={!!flipPhase || saving}>
          <div className="flashcard-sheet__hero">
          <div className="flashcard-sheet__art" aria-hidden="true" />
          <div className="flashcard-sheet__top">{!revealed && <span className="flashcard-sheet__edition">READAGE / NO. {String(reviewedCount + 1).padStart(2, '0')}</span>}<button type="button" className="flashcard-sheet__sound" aria-label={`朗读 ${current.canonicalWordId}`} onClick={event => { event.stopPropagation(); speech.speak(current.canonicalWordId); }}><Volume2 size={19} aria-hidden="true" /></button></div>
          {!revealed ? <button ref={revealRef} type="button" className="flashcard-sheet__front" onClick={event => { event.stopPropagation(); activateCard(); }} disabled={!!flipPhase || saving} aria-label={`翻开词卡 ${current.canonicalWordId}`} aria-expanded={false} aria-controls={answerId}>
            <h2 id={`${answerId}-word`} lang="en">{current.canonicalWordId}</h2>
            {dictionaryCard?.phonetic && <span className="flashcard-sheet__phonetic">{dictionaryCard.phonetic}</span>}
          </button> :
            <div className="flashcard-sheet__word"><h2 id={`${answerId}-word`} lang="en"><button ref={backActionRef} type="button" className="flashcard-sheet__back-action" disabled={!!flipPhase || saving || !!saveError || correctionOpen} aria-label={`${rated ? '进入下一张词卡' : '返回正面评分'}，${current.canonicalWordId}`} aria-describedby={`${answerId}-hint`} onClick={event => { event.stopPropagation(); activateCard(); }}>{current.canonicalWordId}</button></h2>{dictionaryCard?.phonetic && <p className="flashcard-sheet__phonetic">{dictionaryCard.phonetic}</p>}</div>
          }
          {!revealed && <div className="flashcard-response" aria-label="选择本次回忆情况" aria-busy={saving || !!flipPhase} onClick={event => event.stopPropagation()}>
            {current.isPractice ? <div className="flashcard-response__practice"><button type="button" disabled={!!flipPhase || saving || rated} onClick={() => void rate('again')}>仍需巩固</button><button type="button" disabled={!!flipPhase || saving || rated} onClick={() => void rate('good')}>想起来了 <Check size={16} aria-hidden="true" /></button></div>
              : <div className="flashcard-response__ratings">{ratings.map(rating => <button type="button" key={rating.value} data-rating={rating.value} disabled={saving || !!saveError || !!flipPhase || rated} onClick={() => void rate(rating.value)} title={rating.description}>
                <span>{rating.label}</span><small>{saving && submissionRef.current?.rating === rating.value ? '保存中…' : previews ? intervalLabel(previews[rating.value].intervalMs) : rating.description}</small>
              </button>)}</div>}
          </div>}
          </div>
          {revealed &&
            <div className="flashcard-sheet__answer" id={answerId} aria-live="polite" aria-busy={dictionaryLoading}>
              {dictionaryLoading ? <p className="flashcard-sheet__notice" role="status">正在加载释义…</p> : dictionaryError || !hasAnswer ? <div className="flashcard-sheet__lookup-error"><p role="alert">{dictionaryError ?? '当前词典未提供可用于复习的释义。'}</p><div><button type="button" onClick={() => setDictionaryRetry(value => value + 1)}>重新查词</button>{!rated && !submissionRef.current && <button type="button" onClick={skip}>先跳过这张卡</button>}</div></div> : <>
                <div className="flashcard-sheet__meaning">
                  {compactCard?.meaningZh ? <p className="flashcard-sheet__chinese">{compactCard.meaningZh}</p>
                    : compactCard?.definitionEn ? <p className="flashcard-sheet__english flashcard-sheet__english--primary" lang="en">{compactCard.definitionEn}</p>
                    : <p className="flashcard-sheet__original">{compactCard?.originalText}</p>}
                </div>
              </>}
            </div>
          }
          {revealed && <div className="flashcard-sheet__footer">
            {rated && !current.isPractice && savedDetails && <section className="flashcard-result" aria-label="本次回忆结果" onClick={event => event.stopPropagation()}>
              <div className="flashcard-result__heading">
                <p className="flashcard-result__title"><Check size={14} aria-hidden="true" />{(ratedReview?.revision ?? 0) > 0 ? '已修正' : '已保存'} · {ratings.find(row => row.value === ratedReview?.rating)?.label}</p>
                <button type="button" className="flashcard-result__edit" disabled={saving || !!flipPhase || !!saveError} aria-expanded={correctionOpen} aria-label="修改本次评分" onClick={() => setCorrectionOpen(value => !value)}>修改评分<ChevronDown size={12} aria-hidden="true" /></button>
              </div>
              <div className="flashcard-result__summary"><span>当前 L{savedDetails.level} · {savedDetails.levelLabel}</span><span>下次复习 {reviewDateLabel(savedDetails.nextReviewAt, store.timezone) ?? '暂未安排'}</span></div>
              {correctionOpen ? <div className="flashcard-result__correction" aria-label="修改本次评分">
                <p>核对释义后，本次实际回忆是：</p>
                <div>{ratings.map(row => <button type="button" key={row.value} disabled={saving || !!saveError || ratedReview?.rating === row.value} aria-pressed={ratedReview?.rating === row.value} onClick={() => void correctRating(row.value)}>{row.label}</button>)}</div>
              </div> : null}
            </section>}
            <div className="flashcard-sheet__footer-actions"><button type="button" className="flashcard-sheet__back-hint" id={`${answerId}-hint`} disabled={saving || !!flipPhase || !!saveError || correctionOpen} onClick={activateCard}>{saving ? '正在保存…' : rated ? '下一词' : '返回评分'}<ArrowRight size={16} aria-hidden="true" /></button></div>
            {!dictionaryLoading && !dictionaryError && hasAnswer && hasAnswerDetails && <details key={`dictionary:${currentKey}`} className="flashcard-sheet__details">
              <summary>查看详解 <ChevronDown size={13} aria-hidden="true" /></summary>
              <div className="flashcard-sheet__details-content">
                {current.contextTexts?.[0] && <section className="flashcard-sheet__context"><h3>阅读语境</h3><p lang="en">{current.contextTexts[0]}</p></section>}
                {!hasDictionaryDetails && compactCard?.meaningZh && compactCard.definitionEn && <section className="flashcard-sheet__context"><h3>英文释义{compactCard.partOfSpeech && <span className="flashcard-sheet__pos" lang="en"> {compactCard.partOfSpeech}</span>}</h3><p lang="en">{compactCard.definitionEn}</p></section>}
                {!hasDictionaryDetails && !(compactCard?.meaningZh && compactCard.definitionEn) && compactCard?.partOfSpeech && <p>词性 <span className="flashcard-sheet__pos" lang="en">{compactCard.partOfSpeech}</span></p>}
                {hasDictionaryDetails && dictionaryCard && <section className="flashcard-sheet__dictionary">{dictionaryCard.dictionarySources?.length ? <DictionarySourceSections sources={dictionaryCard.dictionarySources} initiallyExpanded={false} />
                      : dictionaryCard.originalDictionaryContent ? <DictionaryOriginalContent content={dictionaryCard.originalDictionaryContent} />
                      : dictionaryCard.dictionaryRecord ? <DictionarySenseGroups record={dictionaryCard.dictionaryRecord} idPrefix={answerId} />
                      : <ol className="flashcard-sheet__legacy-senses">{dictionaryCard.senses?.map((sense, index) => <li key={index}>
                        {sense.partOfSpeech && <span className="flashcard-sheet__pos" lang="en">{sense.partOfSpeech}</span>}
                        {sense.definitionZh && <p>{sense.definitionZh}</p>}{sense.definition && <p lang="en">{sense.definition}</p>}
                      </li>)}</ol>}</section>}
                {hasSourceNotices && dictionaryCard && <div className="flashcard-sheet__sources"><DictionarySourceIssues issues={dictionaryCard.dictionarySourceIssues} misses={dictionaryCard.dictionarySourceMisses} onRetry={() => setDictionaryRetry(value => value + 1)} /></div>}
              </div>
            </details>}
            <WordMemoryDetailsPanel key={`memory:${currentKey}`} wordId={current.wordId} />
          </div>}
        </article>

        <SpeechFeedback state={speech.state} onStop={speech.stop} />
        {saveError && <div className="flashcard-review__error" role="alert"><p>{saveError}</p><div>{correctionRef.current ? <><button type="button" disabled={saving} onClick={() => void reloadRatedReview()}>重新读取本次评分</button><button type="button" disabled={saving} onClick={() => correctionRef.current && void correctRating(correctionRef.current.rating)}>{saving ? '保存中…' : '重试修改评分'}</button></> : <>{reloadAvailable && <button type="button" disabled={saving} onClick={() => void reloadQueue()}>重新加载词卡</button>}<button type="button" disabled={saving} onClick={() => submissionRef.current && void rate(submissionRef.current.rating)}>{saving ? '保存中…' : '重试保存'}</button></>}</div></div>}
        {!revealed && <p className="flashcard-session__hint">{current.isPractice ? '本轮巩固' : '先回忆，再选择熟悉程度。'}</p>}
      </section> : finished && initialTotal > 0 ? <section className="flashcard-review__state flashcard-review__state--collection flashcard-review__state--done">
        <div className="flashcard-collection-art" style={artworkStyle(states[0]?.wordId ?? 'ReadAge')} aria-hidden="true"><span className="flashcard-collection-art__edition">READAGE — ONE STEP FURTHER</span><span className="flashcard-collection-art__poem">Slowly,<br/>they stay.</span></div>
        <div className="flashcard-review__state-copy"><p className="flashcard-review__eyebrow">A MOMENT WELL SPENT</p><h2>这一轮，收好了</h2><p>已复习 <strong>{reviewedCount}</strong> 个词{skippedCards.length ? `，${skippedCards.length} 个词暂时跳过` : '，下一次复习已安排'}。</p>
        {nextDueLabel && <p className="flashcard-review__next">下一批词卡：{nextDueLabel}</p>}
        <div className="flashcard-review__state-actions">{skippedCards.length > 0 ? <button type="button" className="flashcard-review__primary" onClick={() => startNextBatch(skippedCards)}>重试跳过的词 <ArrowRight size={16} aria-hidden="true" /></button> : !loading && queueSummary.cards.length > 0 ? <button type="button" className="flashcard-review__primary" onClick={() => startNextBatch(queueSummary.cards)}>继续下一轮 <ArrowRight size={16} aria-hidden="true" /></button> : null}<button type="button" className="flashcard-review__text-action" onClick={onOpenReading}>去推荐阅读 <ArrowRight size={15} aria-hidden="true" /></button></div></div>
      </section> : <section className="flashcard-review__state flashcard-review__state--collection">
        <div className="flashcard-collection-art" style={artworkStyle('ReadAge')} aria-hidden="true"><span className="flashcard-collection-art__edition">READAGE — YOUR PERSONAL COLLECTION</span><span className="flashcard-collection-art__poem">The words<br/>we keep.</span></div>
        <div className="flashcard-review__state-copy"><p className="flashcard-review__eyebrow">ROOM FOR DISCOVERY</p><h2>{queueSummary.remainingNewCount ? preferences.dailyNewWordLimit === 0 ? '当前设置为仅复习' : '今日新词已学完' : states.length ? '暂时没有待学词卡' : '从阅读里，收藏第一张词卡'}</h2><p>{queueSummary.remainingNewCount ? `还有 ${queueSummary.remainingNewCount} 个待学词，调整每日新词数量后即可继续学习。` : states.length ? '词表中没有待学或到期的单词。阅读查词或导入词表，添加下一批词卡。' : '阅读时查过的词会来到这里，也可以导入自己的词表。'}</p>{nextDueLabel && <p className="flashcard-review__next">下次到期 · {nextDueLabel}</p>}<div className="flashcard-review__state-actions">{queueSummary.remainingNewCount ? <button type="button" className="flashcard-review__primary" onClick={() => setSettingsOpen(true)}>调整学习数量 <Settings2 size={15} aria-hidden="true" /></button> : <button type="button" className="flashcard-review__primary" onClick={onOpenReading}>去推荐阅读 <ArrowRight size={16} aria-hidden="true" /></button>}<button type="button" className="flashcard-review__text-action" onClick={() => setSettingsOpen(true)}>学习设置</button></div></div>
      </section>}

      {loadError && queue !== null && <div className="flashcard-review__error" role="alert"><p>{loadError}</p><button type="button" disabled={loading} onClick={() => setRefreshKey(key => key + 1)}>重新加载</button></div>}
      {identityNotice && <p className="flashcard-review__identity-notice" role="status">{identityNotice}</p>}

      <ForgettingCurvePanel states={states} currentWordId={current?.wordId} currentWordLabel={current?.canonicalWordId} canonicalWordIds={canonicalWordIds} />
    </main>
    <FlashcardStudySettings open={settingsOpen} onClose={() => setSettingsOpen(false)} preferences={preferences}
      introducedToday={queueSummary.newIntroducedToday} remainingNewCount={queueSummary.remainingNewCount}
      onSaveLimit={saveStudyLimit} onImportWords={importStudyWords} onUpdateWords={updateStudyWords}
      existingWordIds={states.map(state => state.wordId)} managedWordIds={getManagedFlashcardWordIds(states, preferences, canonicalWordIds)} canonicalWordIds={canonicalWordIds} memoryStates={states} />
  </div>;
};
