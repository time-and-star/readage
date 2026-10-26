import React, { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowRight, Check, ChevronDown, RotateCcw, Settings2, Volume2, X } from 'lucide-react';
import { AppPageHeader } from './AppPageHeader';
import { DictionarySenseGroups } from './DictionarySenseGroups';
import { DictionaryOriginalContent } from './DictionaryOriginalContent';
import { DictionarySourceSections } from './DictionarySourceSections';
import { DictionarySourceIssues } from './DictionarySourceIssues';
import { SpeechFeedback } from './SpeechControls';
import { ForgettingCurvePanel } from './ForgettingCurvePanel';
import { FlashcardStudySettings } from './FlashcardStudySettings';
import { FlashcardStatisticsPanel } from './FlashcardStatisticsPanel';
import { createFlashcardSchedulingPolicy, type FlashcardSchedulingPolicy } from '../lib/flashcardScheduling';
import { projectUnratedFlashcardPractice } from '../lib/flashcardPractice';
import { FlashcardHeadword } from './FlashcardHeadword';
import { FlashcardStudyContent } from './FlashcardStudyContent';
import { WordMemoryDetailsPanel } from './WordMemoryDetailsPanel';
import { resolveLearningWordIds } from '../lib/dictionaryClient';
import { createWordCardRequest, fetchWordCard } from '../lib/wordCard';
import { getCompactWordCard } from '../lib/compactWordCard';
import type { FlashcardStudyPreferences } from '../lib/flashcardPreferences';
import { getFlashcardPlanSettingsKey, reconcileFlashcardSession, shouldRefreshFlashcardSession } from '../lib/flashcardSessionSettings';
import { useMemoryStore } from '../lib/memoryV2';
import type { FlashcardRecallEvidence, WordMemoryState } from '../lib/memoryV2/types';
import { getLocalDateInTimeZone } from '../lib/memoryV2/dateUtils';
import {
  buildFlashcardQueue,
  classifyFlashcardRecallEvidence,
  correctFlashcardRating,
  FLASHCARD_ANSWER_REHEARSAL_WINDOW_MS,
  getFlashcardIdentityWordIds,
  getFlashcardLearningProgress,
  getFlashcardRehearsalGap,
  getManagedFlashcardWordIds,
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
  { value: 'again', label: '不认识', description: '没有独立想对，或看答案才想起来；重新累计巩固进度' },
  { value: 'hard', label: '记不稳', description: '独立想对了，但费力或不稳；保留巩固进度，熟词按较保守间隔复习，没想起来应选不认识' },
  { value: 'good', label: '认识', description: '独立、正确地想起来；初学与重学累计三次，不认识后重新累计，再于次日确认' },
  { value: 'easy', label: '轻松答对', description: '立刻正确想起，没有依靠提示' },
];
const ratingChoices = ratings.filter(rating => rating.value !== 'easy');

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

function rehearsalLabel(gap: number, otherWordCount: number): string {
  return otherWordCount > 0 ? `约 ${Math.min(gap, otherWordCount)} 词后再练` : '本轮再练';
}

function reviewDateLabel(value: string | null | undefined, timezone: string): string | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: timezone,
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(value));
}

function nextReviewLabel(value: string | null | undefined, timezone: string): string {
  if (!value || !Number.isFinite(Date.parse(value))) return '复习已安排';
  const today = getLocalDateInTimeZone(new Date(), timezone);
  const tomorrow = new Date(`${today}T12:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const dueDay = getLocalDateInTimeZone(new Date(value), timezone);
  if (dueDay === today) return '今天复习';
  if (dueDay === tomorrow.toISOString().slice(0, 10)) return '明天复习';
  return `${reviewDateLabel(value, timezone)} 复习`;
}

export const FlashcardReviewScreen: React.FC<FlashcardReviewScreenProps> = ({ navigation, onBack, onOpenReading }) => {
  const store = useMemoryStore();
  const version = useSyncExternalStore(store.subscribe, () => store.getSnapshot().version, () => store.getSnapshot().version);
  const speech = useSpeech();
  const answerId = useId();
  const recognitionGroupRef = useRef<HTMLDivElement>(null);
  const saveErrorRef = useRef<HTMLDivElement>(null);
  const nextActionsRef = useRef<HTMLDivElement>(null);
  const nextActionRef = useRef<HTMLButtonElement>(null);
  const mountedRef = useRef(true);
  const [states, setStates] = useState<WordMemoryState[]>([]);
  const [canonicalWordIds, setCanonicalWordIds] = useState<Map<string, string>>(new Map());
  const [preferences, setPreferences] = useState<FlashcardStudyPreferences>({ dailyNewWordLimit: 10, importedWordIds: [] });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [recordsOpen, setRecordsOpen] = useState(false);
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
  const [recognitionChoice, setRecognitionChoice] = useState<{ key: string; rating: 'again' | 'hard' | 'good' } | null>(null);
  const autoSubmissionRef = useRef<string | null>(null);
  const submissionStartedRef = useRef<string | null>(null);
  const lastResetKeyRef = useRef<string | null>(null);
  const activeKeyRef = useRef<string | null>(null);
  const [ratedReview, setRatedReview] = useState<SavedReview | null>(null);
  const ratedReviewRef = useRef<SavedReview | null>(null);
  const [correctionOpen, setCorrectionOpen] = useState(false);
  const correctionRef = useRef<{ correctionId: string; attemptId: string; wordId: string; rating: FlashcardRating; expectedRevision: number } | null>(null);
  const [flipTransition, setFlipTransition] = useState<{ key: string; phase: 'out' | 'in' } | null>(null);
  const flipLockRef = useRef(false);
  const autoSpeechStartedRef = useRef<string | null>(null);
  const flipTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const [dictionaryResult, setDictionaryCard] = useState<GrammarExplanation | null>(null);
  const [lookupLoading, setDictionaryLoading] = useState(false);
  const [lookupError, setDictionaryError] = useState<string | null>(null);
  const [dictionaryKey, setDictionaryKey] = useState<string | null>(null);
  const [dictionaryRetry, setDictionaryRetry] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [advanceError, setAdvanceError] = useState<string | null>(null);
  const [reloadAvailable, setReloadAvailable] = useState(false);
  const submissionRef = useRef<{ key: string; attemptId: string; wordId: string; rating: FlashcardRating;
    scheduling: FlashcardSchedulingPolicy; expectedReps: number; evidence: FlashcardRecallEvidence } | null>(null);
  const advanceLockRef = useRef(false);
  const [savedMessage, setSavedMessage] = useState('');
  const answerExposureRef = useRef<{ userId: string; times: Map<string, string> } | null>(null);

  const answerExposures = () => {
    if (answerExposureRef.current?.userId === store.userId) return answerExposureRef.current.times;
    const times = new Map<string, string>();
    try {
      const saved: unknown = JSON.parse(window.sessionStorage.getItem(`flashcard-answer-exposure:v1:${encodeURIComponent(store.userId)}`) ?? '{}');
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
        for (const [word, value] of Object.entries(saved)) {
          if (typeof value === 'string' && Number.isFinite(Date.parse(value))
            && Date.now() - Date.parse(value) < FLASHCARD_ANSWER_REHEARSAL_WINDOW_MS) times.set(word, value);
        }
      }
    } catch { /* Storage may be unavailable; the current window still retains its exposure map. */ }
    answerExposureRef.current = { userId: store.userId, times };
    return times;
  };

  const rememberClosedAnswer = (word: string) => {
    const times = answerExposures();
    const now = Date.now();
    for (const [key, value] of times) {
      if (now - Date.parse(value) >= FLASHCARD_ANSWER_REHEARSAL_WINDOW_MS) times.delete(key);
    }
    times.set(word, new Date(now).toISOString());
    try {
      window.sessionStorage.setItem(`flashcard-answer-exposure:v1:${encodeURIComponent(store.userId)}`, JSON.stringify(Object.fromEntries(times)));
    } catch { /* This interaction cache is optional and never changes the persisted learning journal. */ }
  };

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
        let [nextStates, nextPreferences] = await Promise.all([
          store.system.getReadingVerificationMemoryStates(store.userId),
          store.system.getFlashcardStudyPreferences(store.userId),
        ]);
        if (!active) return;
        const candidates = getFlashcardIdentityWordIds(nextStates, nextPreferences);
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
        const repairTargets = new Set(nextStates.filter(state => state.fsrsReviews
          .some(review => review.source === undefined && review.rating === 3)).map(state => state.wordId));
        const repairIdentities = new Map([...nextCanonical].filter(([, canonical]) => repairTargets.has(canonical)));
        if (repairIdentities.size && await store.repairCanonicalRecallHistory(repairIdentities)) {
          nextStates = await store.system.getReadingVerificationMemoryStates(store.userId);
        }
        if (!active) return;
        setStates(nextStates);
        setPreferences(nextPreferences);
        setCanonicalWordIds(nextCanonical);
        setLoadError(null);
        const nextQueue = buildFlashcardQueue(nextStates, { timezone: store.timezone, canonicalWordIds: nextCanonical,
          newWordLimit: nextPreferences.dailyNewWordLimit, enrolledWordIds: new Set(nextPreferences.importedWordIds), pausedWordIds: new Set(nextPreferences.pausedWordIds ?? []), excludedWordIds: new Set(nextPreferences.excludedWordIds ?? []) });
        const newlyDueLearning = nextQueue.cards.some(card => (card.kind === 'learning' || card.kind === 'relearning')
          && !queueRef.current?.some(queued => queued.wordId === card.wordId));
        if (newlyDueLearning || !sessionInitializedRef.current || shouldRefreshFlashcardSession(queueRef.current ?? [],
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
  activeKeyRef.current = currentKey;
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
  const hasAnswerDetails = hasDictionaryDetails || hasSourceNotices;
  useEffect(() => {
    if (!current || !revealed || !hasAnswer) return;
    // Returning to the list or leaving this screen also closes an answer.
    // Preserve that exposure across a quick return or a page reload.
    return () => rememberClosedAnswer(current.canonicalWordId);
  }, [store.userId, current?.canonicalWordId, revealed, hasAnswer]);

  useEffect(() => {
    if (!queueSummary.nextDueAt) return;
    const nextDue = Date.parse(queueSummary.nextDueAt);
    if (!Number.isFinite(nextDue)) return;
    const timer = window.setTimeout(() => setRefreshKey(key => key + 1), Math.min(2_147_483_647, Math.max(100, nextDue - Date.now() + 50)));
    return () => window.clearTimeout(timer);
  }, [queueSummary.nextDueAt]);

  useEffect(() => {
    // Native WebViews and desktop windows may suspend timers in the background.
    // Refresh the durable plan on return without replacing the answer being viewed.
    const resume = () => { if (!document.hidden) setRefreshKey(key => key + 1); };
    window.addEventListener('focus', resume);
    document.addEventListener('visibilitychange', resume);
    return () => {
      window.removeEventListener('focus', resume);
      document.removeEventListener('visibilitychange', resume);
    };
  }, []);

  useEffect(() => {
    flipTimersRef.current.forEach(timer => clearTimeout(timer));
    flipTimersRef.current = [];
    flipLockRef.current = false;
    setFlipTransition(null);
    if (lastResetKeyRef.current !== currentKey) {
      lastResetKeyRef.current = currentKey;
      setRecognitionChoice(null);
      autoSubmissionRef.current = null;
      submissionStartedRef.current = null;
      setRatedReview(null);
      ratedReviewRef.current = null;
      setCorrectionOpen(false);
      correctionRef.current = null;
      setSaveError(null);
      setAdvanceError(null);
      setReloadAvailable(false);
      setSavedMessage('');
      submissionRef.current = null;
      advanceLockRef.current = false;
    } else if (submissionRef.current?.key === currentKey) {
      // Effect replay must not discard a choice made before seeing the answer.
      setRevealedKey(currentKey);
    }
    speech.stop();
    return () => {
      flipTimersRef.current.forEach(timer => clearTimeout(timer));
      flipTimersRef.current = [];
      flipLockRef.current = false;
    };
  }, [currentKey, speech.stop]);

  useEffect(() => {
    if (flipPhase || saving || saveError || correctionOpen) return;
    if (!revealed) recognitionGroupRef.current?.focus({ preventScroll: true });
    else if (rated) nextActionRef.current?.focus({ preventScroll: true });
  }, [currentKey, revealed, flipPhase, rated, saving, saveError, correctionOpen]);

  useEffect(() => {
    if (!saveError || saving) return;
    saveErrorRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
    saveErrorRef.current?.scrollIntoView({ block: 'nearest',
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }, [saveError, saving]);

  useEffect(() => {
    if (!advanceError || saving) return;
    // Error text can wrap onto another row on narrow screens. Scroll after
    // that layout settles, keeping the retry control clear of viewport edges.
    const frame = requestAnimationFrame(() => {
      nextActionRef.current?.focus({ preventScroll: true });
      nextActionsRef.current?.scrollIntoView({ block: 'center',
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    });
    return () => cancelAnimationFrame(frame);
  }, [advanceError, saving]);

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
    if (!current || (preferences.autoSpeakCount ?? 0) > 0) return;
    let cancel: (() => void) | undefined;
    const timer = window.setTimeout(() => { cancel = speech.prepare(current.canonicalWordId); }, 150);
    return () => { window.clearTimeout(timer); cancel?.(); };
  }, [current?.canonicalWordId, preferences.autoSpeakCount, speech.prepare, speech.preferences.lang, speech.preferences.rate]);

  useEffect(() => {
    const repeatCount = preferences.autoSpeakCount ?? 0;
    if (!repeatCount) { autoSpeechStartedRef.current = null; return; }
    if (!current || !currentKey || revealed || flipPhase) return;
    const token = `${currentKey}:${repeatCount}`;
    if (autoSpeechStartedRef.current === token) return;
    let cancelled = false;
    const controller = new AbortController();
    void Promise.resolve().then(() => {
      if (cancelled || autoSpeechStartedRef.current === token) return;
      autoSpeechStartedRef.current = token;
      return speech.speakRepeated(current.canonicalWordId, repeatCount, undefined, controller.signal);
    }).catch(() => {});
    return () => { cancelled = true; controller.abort(); speech.stop(); };
  }, [current?.canonicalWordId, currentKey, preferences.autoSpeakCount, flipPhase, revealed, speech.speakRepeated, speech.stop]);

  const revealAnswer = () => {
    if (!currentKey || revealed || saving || saveError || correctionOpen || correctionRef.current
      || flipLockRef.current || advanceLockRef.current) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setRevealedKey(currentKey);
      return;
    }
    flipLockRef.current = true;
    setFlipTransition({ key: currentKey, phase: 'out' });
    const targetKey = currentKey;
    flipTimersRef.current = [
      setTimeout(() => {
        if (!mountedRef.current) return;
        setRevealedKey(targetKey);
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

  const chooseRecognition = (rating: 'again' | 'hard' | 'good') => {
    if (!current || !currentKey || revealed || saving || saveError || submissionRef.current
      || flipLockRef.current || advanceLockRef.current) return;
    // Capture the answer before revealing, including its optimistic version.
    submissionRef.current = { key: currentKey, attemptId: newAttemptId(), wordId: current.wordId, rating,
      scheduling: createFlashcardSchedulingPolicy(preferences.desiredRetention), expectedReps: current.state.fsrsCard.reps,
      evidence: classifyFlashcardRecallEvidence({ answerExposedAt: answerExposures().get(current.canonicalWordId) }) };
    setRecognitionChoice({ key: currentKey, rating });
    revealAnswer();
  };

  const advanceRatedCard = async () => {
    const saved = ratedReviewRef.current;
    if (!current || !saved || saved.key !== currentKey || saving || saveError || correctionOpen
      || correctionRef.current || flipLockRef.current || advanceLockRef.current) return;
    advanceLockRef.current = true;
    setSaving(true);
    setAdvanceError(null);
    try {
      // Every saved recall changes count-based interleaving. Read the durable
      // plan before moving, instead of advancing an outdated in-memory head.
      const [nextStates, nextPreferences] = await Promise.all([
        store.system.getReadingVerificationMemoryStates(store.userId),
        store.system.getFlashcardStudyPreferences(store.userId),
      ]);
      if (!mountedRef.current) return;
      const plan = buildFlashcardQueue(nextStates, { timezone: store.timezone, canonicalWordIds,
        newWordLimit: nextPreferences.dailyNewWordLimit, enrolledWordIds: new Set(nextPreferences.importedWordIds),
        pausedWordIds: new Set(nextPreferences.pausedWordIds ?? []), excludedWordIds: new Set(nextPreferences.excludedWordIds ?? []) });
      const skippedIds = new Set(skippedCardsRef.current.map(card => card.canonicalWordId));
      const cards = plan.cards.filter(card => !skippedIds.has(card.canonicalWordId));
      const nextReviewedCount = reviewedCountRef.current + (current.isPractice ? 0 : 1);
      reviewedCountRef.current = nextReviewedCount;
      queueRef.current = cards;
      settingsKeyRef.current = getFlashcardPlanSettingsKey(nextPreferences);
      setStates(nextStates);
      setPreferences(nextPreferences);
      setReviewedCount(nextReviewedCount);
      setInitialTotal(nextReviewedCount + skippedCardsRef.current.length + cards.length);
      // Start answer isolation when the answer actually closes, including a
      // long pause on its back; time spent reading it is not a recall delay.
      rememberClosedAnswer(current.canonicalWordId);
      setQueue(cards);
      setEncounter(value => value + 1);
    } catch (cause) {
      if (mountedRef.current) setAdvanceError(cause instanceof Error ? cause.message : '下一词暂未准备好，请重试；本次评分已经保存。');
    } finally {
      advanceLockRef.current = false;
      if (mountedRef.current) setSaving(false);
    }
  };

  const rate = async (rating: FlashcardRating) => {
    const submission = submissionRef.current;
    const recovering = submission?.attemptId === submissionStartedRef.current;
    if (!current || !currentKey || saving || advanceLockRef.current || flipLockRef.current
      || ratedReviewRef.current?.key === currentKey
      || !submission || submission.key !== currentKey || submission.rating !== rating
      || (!recovering && (!revealed || dictionaryLoading || dictionaryError || !hasAnswer))) return;
    advanceLockRef.current = true;
    submissionStartedRef.current = submission.attemptId;
    setSaving(true);
    setSaveError(null);
    try {
      const nextState = await submitFlashcardRating(store, submission);
      if (!mountedRef.current || activeKeyRef.current !== submission.key) return;
      setStates(previous => previous.map(state => state.wordId === current.wordId ? nextState : state));
      ratedReviewRef.current = savedReviewFor(currentKey, submission.attemptId, nextState, submission.rating);
      setRatedReview(ratedReviewRef.current);
      const gap = getFlashcardRehearsalGap(nextState);
      const others = queueSummary.cards.filter(card => card.canonicalWordId !== current.canonicalWordId).length;
      setSavedMessage(`${current.wordId} 已保存，${gap !== null ? rehearsalLabel(gap, others) : `下次复习 ${reviewDateLabel(projectUnratedFlashcardPractice(nextState)?.due ?? nextState.nextReview, store.timezone) ?? '已安排'}`}。`);
      advanceLockRef.current = false;
    } catch (cause) {
      if (mountedRef.current && activeKeyRef.current === submission.key) {
        advanceLockRef.current = false;
        const message = cause instanceof Error ? cause.message : '保存未完成，请重试；本次回忆记录已保留。';
        setSaveError(message);
        setReloadAvailable(/尚未到期|刷新词卡|不存在|校正时间|没有查询/.test(message));
      }
    } finally {
      if (mountedRef.current && activeKeyRef.current === submission.key) setSaving(false);
    }
  };

  useEffect(() => {
    const submission = submissionRef.current;
    if (!recognitionChoice || recognitionChoice.key !== currentKey || !submission || submission.key !== currentKey
      || !revealed || flipPhase || rated || saving || saveError || dictionaryLoading || dictionaryError || !hasAnswer
      || autoSubmissionRef.current === submission.attemptId) return;
    // A failed automatic write waits for an explicit retry, never a render loop.
    autoSubmissionRef.current = submission.attemptId;
    void rate(recognitionChoice.rating);
  }, [recognitionChoice, currentKey, revealed, flipPhase, rated, saving, saveError, dictionaryLoading, dictionaryError, hasAnswer]);

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
      const gap = getFlashcardRehearsalGap(nextState);
      const others = queueSummary.cards.filter(card => card.canonicalWordId !== current.canonicalWordId).length;
      setSavedMessage(`本次评分已改为“${ratings.find(row => row.value === ratedReviewRef.current!.rating)?.label}”，${gap !== null ? rehearsalLabel(gap, others) : `下次复习 ${reviewDateLabel(projectUnratedFlashcardPractice(nextState)?.due ?? nextState.nextReview, store.timezone) ?? '已安排'}`}。`);
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
    if (!current || saving || advanceLockRef.current || submissionStartedRef.current || flipLockRef.current || ratedReviewRef.current?.key === currentKey) return;
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
      if (sessionInitializedRef.current && reviewedCountRef.current > 0) {
        // A minute learning step belongs to this session; do not reset its
        // completed recall count merely because there was a short waiting gap.
        queueRef.current = cards;
        setQueue(cards);
        setInitialTotal(reviewedCountRef.current + cards.filter(card => !card.isPractice).length);
        return;
      }
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
  const saveDesiredRetention = async (desiredRetention: number) => {
    await store.saveFlashcardDesiredRetention(desiredRetention);
    await refreshStudyPlan();
  };

  const saveAutoSpeakCount = async (count: number) => {
    await store.saveFlashcardAutoSpeakCount(count);
    await refreshStudyPlan();
  };

  const updateStudyWords = async (wordIds: string[], action: 'pause' | 'resume' | 'remove') => {
    const targets = new Set(wordIds);
    // Keep legacy aliases excluded even if the dictionary resolver later goes offline.
    for (const [alias, canonical] of canonicalWordIds) if (targets.has(canonical)) targets.add(alias);
    if (action === 'resume') {
      await store.restoreFlashcardWords(wordIds.map(wordId => ({ wordId,
        relatedWordIds: [...targets].filter(id => id === wordId || canonicalWordIds.get(id) === wordId) })));
    } else await store.updateFlashcardWords([...targets], action);
    await refreshStudyPlan();
  };

  const importStudyWords = async (wordIds: string[]) => {
    const [existingStates, existingPreferences] = await Promise.all([
      store.system.getReadingVerificationMemoryStates(store.userId),
      store.system.getFlashcardStudyPreferences(store.userId),
    ]);
    const existingIds = getFlashcardIdentityWordIds(existingStates, existingPreferences);
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
  const nextDueLabel = reviewDateLabel(queueSummary.nextDueAt, store.timezone);
  const nextLearningLabel = reviewDateLabel(queueSummary.nextLearningDueAt, store.timezone);
  const learningProgress = current ? getFlashcardLearningProgress(current.state, current.kind === 'new') : null;
  const savedLearningProgress = ratedReview?.state ? getFlashcardLearningProgress(ratedReview.state) : null;
  const displayedLearningProgress = rated ? savedLearningProgress ?? (learningProgress !== null ? 3 : null) : learningProgress;
  const otherWordCount = current ? queueSummary.cards.filter(card => card.canonicalWordId !== current.canonicalWordId).length : 0;
  const savedRehearsalGap = ratedReview?.state ? getFlashcardRehearsalGap(ratedReview.state) : null;
  const savedStatusLabel = ratedReview?.rating === 'good' || ratedReview?.rating === 'easy' ? '认识'
    : ratedReview?.rating === 'hard' ? '记不稳' : '不认识';

  return <div className="flashcard-screen">
    <AppPageHeader onBack={onBack} navigation={navigation} />
    <main className="flashcard-review safe-pb">
      <div className="flashcard-review__heading">
        <h1>词卡学习</h1>
        <div className="flashcard-review__heading-actions">
          <button type="button" className="flashcard-review__settings" aria-label="学习设置" title="学习设置" disabled={loading || saving || !!flipPhase || !!saveError || correctionOpen} onClick={() => setSettingsOpen(true)}><Settings2 size={18} aria-hidden="true" /></button>
        </div>
      </div>

      <div className="sr-only" role="status" aria-live="polite">{savedMessage}</div>
      {savedMessage && !rated && <p className="flashcard-review__feedback">{savedMessage}</p>}

      {queue === null ? <section className="flashcard-review__state flashcard-review__state--collection" aria-busy={loading}>
        <div className="flashcard-collection-art" style={artworkStyle('ReadAge')} aria-hidden="true"><span className="flashcard-collection-art__edition">ReadAge — A WORD COLLECTION</span><span className="flashcard-collection-art__poem">A little.<br/>Every day.</span></div>
        <div className="flashcard-review__state-copy">{loadError ? <><RotateCcw size={25} aria-hidden="true" /><h2>词库暂时未能打开</h2><p role="alert">{loadError}</p><button type="button" className="flashcard-review__primary" onClick={() => setRefreshKey(key => key + 1)}>重新加载 <ArrowRight size={16} aria-hidden="true" /></button></>
          : <><span className="flashcard-review__loader" aria-hidden="true" /><h2>正在准备你的词卡</h2><p role="status">读取学习记录，优先安排到期的单词。</p></>}</div>
      </section> : current ? <section className="flashcard-session" aria-label="单词回忆练习">
        <div className="flashcard-session__status"><span>还剩 {queueSummary.cards.length} 词</span><span className="sr-only">本轮已回忆 {reviewedCount} 次，暂跳过 {skippedCards.length} 个词。</span>
          {displayedLearningProgress !== null && <span className="flashcard-session__learning" role="progressbar" aria-label="当前单词巩固进度" aria-valuemin={0} aria-valuemax={3} aria-valuenow={displayedLearningProgress} aria-valuetext={`本轮记住 ${displayedLearningProgress} / 3；不稳保留进度，忘记后重新累计`}>
            <span className="sr-only">本轮巩固</span>
            {[1, 2, 3].map(step => <i key={step} className={step <= displayedLearningProgress ? 'is-complete' : undefined} aria-hidden="true" />)}
          </span>}
        </div>

        <article className={`flashcard-sheet ${revealed ? 'flashcard-sheet--revealed' : ''} ${flipPhase ? `flashcard-sheet--flip-${flipPhase}` : ''}`} aria-labelledby={`${answerId}-word`} aria-busy={!!flipPhase || saving}>
          {!revealed ? <div className="flashcard-sheet__front">
            <div className="flashcard-sheet__front-word"><FlashcardHeadword id={`${answerId}-word`} word={current.canonicalWordId} />
              <div className="flashcard-sheet__pronunciation">{compactCard?.phonetic && <span className="flashcard-sheet__phonetic">{compactCard.phonetic}</span>}<button type="button" className="flashcard-sheet__sound" aria-label={`朗读 ${current.canonicalWordId}`} onClick={() => speech.speak(current.canonicalWordId)}><Volume2 size={24} aria-hidden="true" /></button></div>
            </div>
            <div ref={recognitionGroupRef} className="flashcard-recognition" role="group" tabIndex={-1} aria-label="先回忆释义，再判断记忆情况">
              <div className="flashcard-recognition__choices">
                <button type="button" data-recognition="known" disabled={!!flipPhase || saving || !!recognitionChoice} onClick={() => chooseRecognition('good')} aria-controls={answerId}><span>认识</span></button>
                <button type="button" data-recognition="unstable" disabled={!!flipPhase || saving || !!recognitionChoice} onClick={() => chooseRecognition('hard')} aria-controls={answerId}><span>记不稳</span></button>
                <button type="button" data-recognition="unknown" disabled={!!flipPhase || saving || !!recognitionChoice} onClick={() => chooseRecognition('again')} aria-controls={answerId}><span>不认识</span></button>
              </div>
            </div>
          </div> : <div className="flashcard-sheet__word">
            <div><FlashcardHeadword id={`${answerId}-word`} word={current.canonicalWordId} /><div className="flashcard-sheet__pronunciation">{compactCard?.phonetic && <span className="flashcard-sheet__phonetic">{compactCard.phonetic}</span>}<button type="button" className="flashcard-sheet__sound" aria-label={`朗读 ${current.canonicalWordId}`} onClick={() => speech.speak(current.canonicalWordId)}><Volume2 size={23} aria-hidden="true" /></button></div></div>
          </div>}
          {revealed &&
            <div className="flashcard-sheet__answer" id={answerId} aria-live="polite" aria-busy={dictionaryLoading}>
              {dictionaryLoading ? <p className="flashcard-sheet__notice" role="status">正在加载释义…</p> : dictionaryError || !hasAnswer ? <div className="flashcard-sheet__lookup-error"><p role="alert">{dictionaryError ?? '当前词典未提供可用于复习的释义。'}</p><div><button type="button" onClick={() => setDictionaryRetry(value => value + 1)}>重新查词</button>{!rated && !submissionStartedRef.current && <button type="button" onClick={skip}>先跳过这张卡</button>}</div></div> : <FlashcardStudyContent key={currentKey} card={dictionaryCard} word={current.wordId} contextTexts={current.contextTexts}
                aliases={[current.canonicalWordId, ...[...canonicalWordIds].filter(([, canonical]) => canonical === current.canonicalWordId).map(([alias]) => alias)]} />}
            </div>
          }
          {revealed && <div className="flashcard-sheet__footer">
            {!rated && saving && <p className="flashcard-sheet__pending" role="status">正在记录判断…</p>}
            {rated && !current.isPractice && ratedReview?.state && <section className="flashcard-result" aria-label="本次回忆结果" onClick={event => event.stopPropagation()}>
              <div className="flashcard-result__heading">
                <p className="flashcard-result__title" data-rating={ratedReview.rating} title={(ratedReview.revision ?? 0) > 0 ? '本次判断已修正' : undefined}>{ratedReview.rating === 'again' ? <X size={14} aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}{savedStatusLabel}</p>
                <span className="flashcard-result__schedule">{savedRehearsalGap !== null ? rehearsalLabel(savedRehearsalGap, otherWordCount) : nextReviewLabel(projectUnratedFlashcardPractice(ratedReview.state)?.due ?? ratedReview.state.nextReview, store.timezone)}</span>
                <button type="button" className="flashcard-result__edit" disabled={saving || !!flipPhase || !!saveError} aria-expanded={correctionOpen} aria-label="修改本次判断" onClick={() => setCorrectionOpen(value => !value)}>修改判断<ChevronDown size={12} aria-hidden="true" /></button>
              </div>
              {correctionOpen ? <div className="flashcard-result__correction" aria-label="修改本次评分">
                <p>修改为</p>
                <div>{ratingChoices.map(row => <button type="button" key={row.value} disabled={saving || !!saveError || ratedReview?.rating === row.value} aria-pressed={ratedReview?.rating === row.value} onClick={() => void correctRating(row.value)}>{row.label}</button>)}</div>
              </div> : null}
            </section>}
            {rated && <div ref={nextActionsRef} className={`flashcard-sheet__footer-actions${advanceError ? ' flashcard-sheet__footer-actions--retry' : ''}`} onClick={event => event.stopPropagation()}>
              {advanceError && <p className="flashcard-sheet__next-error" id={`${answerId}-next-error`} title={advanceError} role="alert">下一词读取失败，评分已保存。</p>}
              <button ref={nextActionRef} type="button" className="flashcard-sheet__next" id={`${answerId}-hint`} aria-describedby={advanceError ? `${answerId}-next-error` : undefined} disabled={saving || !!flipPhase || !!saveError || correctionOpen} onKeyDown={event => { if (event.repeat && (event.key === 'Enter' || event.key === ' ')) event.preventDefault(); }} onClick={() => void advanceRatedCard()}>{saving ? '正在保存…' : advanceError ? '重试下一词' : '下一词'}<ArrowRight size={16} aria-hidden="true" /></button>
            </div>}
            {saveError && <div ref={saveErrorRef} className="flashcard-review__error flashcard-sheet__save-error" role="alert"><p>{saveError}</p><div>{correctionRef.current ? <><button type="button" disabled={saving} onClick={() => void reloadRatedReview()}>重新读取本次评分</button><button type="button" disabled={saving} onClick={() => correctionRef.current && void correctRating(correctionRef.current.rating)}>{saving ? '保存中…' : '重试修改评分'}</button></> : <>{reloadAvailable && <button type="button" disabled={saving} onClick={() => void reloadQueue()}>重新加载词卡</button>}<button type="button" disabled={saving} onClick={() => submissionRef.current && void rate(submissionRef.current.rating)}>{saving ? '保存中…' : '重试保存'}</button></>}</div></div>}
            {!dictionaryLoading && !dictionaryError && hasAnswer && hasAnswerDetails && <details key={`dictionary:${currentKey}`} className="flashcard-sheet__details" open={dictionaryCard?.originalDictionaryContent ? true : undefined}>
              <summary>完整词典 <ChevronDown size={13} aria-hidden="true" /></summary>
              <div className="flashcard-sheet__details-content">
                {!hasDictionaryDetails && compactCard?.meaningZh && compactCard.definitionEn && <section className="flashcard-sheet__context"><h3>英文释义{compactCard.partOfSpeech && <span className="flashcard-sheet__pos" lang="en"> {compactCard.partOfSpeech}</span>}</h3><p lang="en">{compactCard.definitionEn}</p></section>}
                {!hasDictionaryDetails && !(compactCard?.meaningZh && compactCard.definitionEn) && compactCard?.partOfSpeech && <p>词性 <span className="flashcard-sheet__pos" lang="en">{compactCard.partOfSpeech}</span></p>}
                {hasDictionaryDetails && dictionaryCard && <section className="flashcard-sheet__dictionary">{dictionaryCard.dictionarySources?.length ? <DictionarySourceSections sources={dictionaryCard.dictionarySources} initiallyExpanded={false} preferAuthored />
                      : dictionaryCard.originalDictionaryContent ? <DictionaryOriginalContent content={dictionaryCard.originalDictionaryContent} />
                      : dictionaryCard.dictionaryRecord ? <DictionarySenseGroups record={dictionaryCard.dictionaryRecord} idPrefix={answerId} />
                      : <ol className="flashcard-sheet__legacy-senses">{dictionaryCard.senses?.map((sense, index) => <li key={index}>
                        {sense.partOfSpeech && <span className="flashcard-sheet__pos" lang="en">{sense.partOfSpeech}</span>}
                        {sense.definitionZh && <p>{sense.definitionZh}</p>}{sense.definition && <p lang="en">{sense.definition}</p>}
                      </li>)}</ol>}</section>}
                {hasSourceNotices && dictionaryCard && <div className="flashcard-sheet__sources"><DictionarySourceIssues issues={dictionaryCard.dictionarySourceIssues} misses={dictionaryCard.dictionarySourceMisses} onRetry={() => setDictionaryRetry(value => value + 1)} /></div>}
              </div>
            </details>}
          </div>}
        </article>

        <SpeechFeedback state={speech.state} onStop={speech.stop} />
      </section> : finished && queueSummary.pendingLearningCount > 0 ? <section className="flashcard-review__state flashcard-review__state--collection flashcard-review__state--waiting" aria-label="等待继续巩固">
        <div className="flashcard-collection-art" style={artworkStyle('ReadAge')} aria-hidden="true"><span className="flashcard-collection-art__edition">ReadAge — KEEP IT GROWING</span><span className="flashcard-collection-art__poem">A little<br/>more time.</span></div>
        <div className="flashcard-review__state-copy"><p className="flashcard-review__eyebrow">历史学习安排</p><h2>原有巩固尚未到期</h2><p>{reviewedCount > 0 && <>本轮已回忆 <strong>{reviewedCount}</strong> 次。</>}还有 <strong>{queueSummary.pendingLearningCount}</strong> 个词保留原来的到期安排，到期后会自动回到词卡。</p><p className="flashcard-review__next">下次巩固 · {nextLearningLabel}</p><p>下一次评分起采用本轮穿插巩固，累计记住三次后于次日确认；记不稳保留进度，不认识后重新累计。</p><div className="flashcard-review__state-actions">{skippedCards.length > 0 && <button type="button" className="flashcard-review__primary" onClick={() => startNextBatch(skippedCards)}>重试跳过的词 <ArrowRight size={16} aria-hidden="true" /></button>}<button type="button" className="flashcard-review__text-action" onClick={() => setRefreshKey(key => key + 1)}>检查到期词卡 <RotateCcw size={15} aria-hidden="true" /></button><button type="button" className="flashcard-review__text-action" onClick={onOpenReading}>去推荐阅读 <ArrowRight size={15} aria-hidden="true" /></button></div></div>
      </section> : finished && initialTotal > 0 ? <section className="flashcard-review__state flashcard-review__state--collection flashcard-review__state--done">
        <div className="flashcard-collection-art" style={artworkStyle(states[0]?.wordId ?? 'ReadAge')} aria-hidden="true"><span className="flashcard-collection-art__edition">ReadAge — ONE STEP FURTHER</span><span className="flashcard-collection-art__poem">Slowly,<br/>they stay.</span></div>
        <div className="flashcard-review__state-copy"><p className="flashcard-review__eyebrow">A MOMENT WELL SPENT</p><h2>这一轮，收好了</h2><p>本轮已回忆 <strong>{reviewedCount}</strong> 次{skippedCards.length ? `，${skippedCards.length} 个词暂时跳过` : '，下一次复习已安排'}。</p>
        {nextDueLabel && <p className="flashcard-review__next">下一批词卡：{nextDueLabel}</p>}
        <div className="flashcard-review__state-actions">{skippedCards.length > 0 ? <button type="button" className="flashcard-review__primary" onClick={() => startNextBatch(skippedCards)}>重试跳过的词 <ArrowRight size={16} aria-hidden="true" /></button> : !loading && queueSummary.cards.length > 0 ? <button type="button" className="flashcard-review__primary" onClick={() => startNextBatch(queueSummary.cards)}>继续下一轮 <ArrowRight size={16} aria-hidden="true" /></button> : null}<button type="button" className="flashcard-review__text-action" onClick={onOpenReading}>去推荐阅读 <ArrowRight size={15} aria-hidden="true" /></button></div></div>
      </section> : <section className="flashcard-review__state flashcard-review__state--collection">
        <div className="flashcard-collection-art" style={artworkStyle('ReadAge')} aria-hidden="true"><span className="flashcard-collection-art__edition">ReadAge — YOUR PERSONAL COLLECTION</span><span className="flashcard-collection-art__poem">The words<br/>we keep.</span></div>
        <div className="flashcard-review__state-copy"><p className="flashcard-review__eyebrow">ROOM FOR DISCOVERY</p><h2>{queueSummary.remainingNewCount ? preferences.dailyNewWordLimit === 0 ? '当前设置为仅复习' : '今日新词已学完' : states.length ? '暂时没有待学词卡' : '从阅读里，收藏第一张词卡'}</h2><p>{queueSummary.remainingNewCount ? `还有 ${queueSummary.remainingNewCount} 个待学词，调整每日新词数量后即可继续学习。` : states.length ? '词表中没有待学或到期的单词。阅读查词或导入词表，添加下一批词卡。' : '阅读时查过的词会来到这里，也可以导入自己的词表。'}</p>{nextDueLabel && <p className="flashcard-review__next">下次到期 · {nextDueLabel}</p>}<div className="flashcard-review__state-actions">{queueSummary.remainingNewCount ? <button type="button" className="flashcard-review__primary" onClick={() => setSettingsOpen(true)}>调整学习数量 <Settings2 size={15} aria-hidden="true" /></button> : <button type="button" className="flashcard-review__primary" onClick={onOpenReading}>去推荐阅读 <ArrowRight size={16} aria-hidden="true" /></button>}<button type="button" className="flashcard-review__text-action" onClick={() => setSettingsOpen(true)}>学习设置</button></div></div>
      </section>}

      {loadError && queue !== null && <div className="flashcard-review__error" role="alert"><p>{loadError}</p><button type="button" disabled={loading} onClick={() => setRefreshKey(key => key + 1)}>重新加载</button></div>}
      <details className="flashcard-learning-records" open={recordsOpen} onToggle={event => setRecordsOpen(event.currentTarget.open)}>
        <summary>学习记录<ChevronDown size={15} aria-hidden="true" /></summary>
        {recordsOpen && <div className="flashcard-learning-records__body">
          {current && <WordMemoryDetailsPanel key={`memory:${currentKey}`} wordId={current.wordId} initiallyOpen />}
          <FlashcardStatisticsPanel states={states} timezone={store.timezone} desiredRetention={preferences.desiredRetention} canonicalWordIds={canonicalWordIds} />
          <ForgettingCurvePanel states={states} currentWordId={current?.wordId} currentWordLabel={current?.canonicalWordId} canonicalWordIds={canonicalWordIds} />
        </div>}
      </details>
      {identityNotice && <p className="flashcard-review__identity-notice" role="status">{identityNotice}</p>}

    </main>
    <FlashcardStudySettings open={settingsOpen} onClose={() => setSettingsOpen(false)} preferences={preferences}
      introducedToday={queueSummary.newIntroducedToday} remainingNewCount={queueSummary.remainingNewCount}
      onSaveLimit={saveStudyLimit} onSaveAutoSpeakCount={saveAutoSpeakCount} onSaveDesiredRetention={saveDesiredRetention} onImportWords={importStudyWords} onUpdateWords={updateStudyWords}
      existingWordIds={states.map(state => state.wordId)} managedWordIds={getManagedFlashcardWordIds(states, preferences, canonicalWordIds)} canonicalWordIds={canonicalWordIds} memoryStates={states} />
  </div>;
};
