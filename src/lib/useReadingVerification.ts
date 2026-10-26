import { useCallback, useEffect, useRef, useState } from 'react';
import { useMemorySystem } from './memoryV2/hooks';
import { useMemoryStore } from './memoryV2/MemoryProvider';
import { getLocalDateInTimeZone } from './memoryV2/dateUtils';
import { resolveLearningWordIds } from './dictionaryClient';
import type { ReadingVerificationQuestion } from './readingVerificationQuestions';
import { requestAfterReadingAgent } from './afterReadingClient';
import { buildAfterReadingContext } from './afterReadingContext';
import { extractLearningUnits } from './readingExposure';
import { readingVerificationAttemptId, selectReadingVerificationCandidates, isReadingVerificationPauseAllowed,
  type ReadingVerificationAttemptSummary, type ReadingVerificationCandidate } from './readingVerification';

export interface ReadingVerificationPendingAttempt {
  id: string;
  questionId: string;
  qualified?: boolean;
}

/** Qualify once at answer time; storage retries and guess corrections keep that encounter. */
export async function qualifyReadingVerificationAttempt(
  attempt: ReadingVerificationPendingAttempt,
  wordId: string,
  { articleId, timezone, readCandidates, isCurrent }: {
    articleId: string;
    timezone: string;
    readCandidates: () => Promise<{ candidates: readonly Pick<ReadingVerificationCandidate, 'wordId'>[]; now: Date }>;
    isCurrent: () => boolean;
  },
): Promise<void> {
  if (!isCurrent()) throw new Error('这道题已更新，请重新打开词义核对。');
  if (attempt.qualified) return;
  const { candidates, now } = await readCandidates();
  if (!isCurrent()) throw new Error('这道题已更新，请重新打开词义核对。');
  if (!candidates.some(candidate => candidate.wordId === wordId)) {
    throw new Error('这个词暂时不适合核对，可以继续阅读。');
  }
  // The qualified answer owns its captured day, including a card open at midnight.
  attempt.id = readingVerificationAttemptId(articleId, getLocalDateInTimeZone(now, timezone));
  attempt.qualified = true;
}

/** Article completion triggers agent planning; the question remains optional. */
export function useReadingVerification(articleId: string, excludedContextTexts: readonly string[], level?: string,
  articleTitle?: string, readingComplete = false) {
  const { memorySystem, userId, ready, recordVerification } = useMemorySystem();
  const store = useMemoryStore();
  const [question, setQuestion] = useState<ReadingVerificationQuestion | null>(null);
  const [available, setAvailable] = useState(false);
  const [loading, setLoading] = useState(false);
  const [requestError, setRequestError] = useState<string>();
  const contextsRef = useRef(excludedContextTexts);
  contextsRef.current = excludedContextTexts;
  const requestGeneration = useRef(0);
  const attemptRef = useRef<ReadingVerificationPendingAttempt | null>(null);
  const mounted = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const pendingRequest = useRef<Promise<void> | null>(null);
  const autoPrepared = useRef(false);

  const readCandidates = useCallback(async () => {
    const [states, history] = await Promise.all([
        memorySystem.getReadingVerificationMemoryStates(userId),
        memorySystem.getVerificationHistory(userId),
      ]);
    const articleSurfaceWords = [...new Set<string>(contextsRef.current.flatMap(text => extractLearningUnits(text).map(unit => unit.wordId)))];
    const sourceIds = [...new Set<string>([...states.map(state => state.wordId), ...articleSurfaceWords])];
    const ids = await resolveLearningWordIds(sourceIds);
    const canonicalWordIds = new Map<string, string>(sourceIds.map((id, index) => [id, ids[index]]));
    const now = new Date();
    const candidates = selectReadingVerificationCandidates({ states, history, articleId,
      now, timezone: store.timezone, canonicalWordIds });
    const context = buildAfterReadingContext({ states, history, candidates,
      articleText: contextsRef.current.join('\n\n'), articleId, canonicalWordIds, now,
      articleWordIds: articleSurfaceWords.map(id => canonicalWordIds.get(id) || id) });
    const pauseAllowed = isReadingVerificationPauseAllowed(history, articleId, now, store.timezone);
    const practiceCandidates = pauseAllowed
      ? context.learnerWords.filter(row => row.inArticle).map(row => ({ wordId: row.wordId })) : [];
    const knownWords = new Set(context.learnerWords.map(row => row.wordId));
    const knownContexts = states.filter(state => knownWords.has(canonicalWordIds.get(state.wordId) || state.wordId))
      .flatMap(state => state.rme?.contextHistory.map(row => row.contextText).filter(Boolean) ?? []);
    return { candidates, practiceCandidates, pauseAllowed, knownContexts, history, now, ...context };
  }, [memorySystem, userId, articleId, store.timezone]);

  const cancelRequest = useCallback(() => {
    if (!abortRef.current) return;
    abortRef.current.abort();
    abortRef.current = null;
    pendingRequest.current = null;
    requestGeneration.current += 1;
    if (mounted.current) setLoading(false);
  }, []);

  const prepare = useCallback(async () => {
    if (!ready || !readingComplete) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const generation = ++requestGeneration.current;
    setLoading(true);
    setRequestError(undefined);
    setQuestion(null);
    setAvailable(true);
    attemptRef.current = null;
    try {
      const { pauseAllowed, knownContexts, learnerWords, learningSummary, history, now } = await readCandidates();
      if (controller.signal.aborted || !mounted.current) return;
      if (!pauseAllowed) { setAvailable(false); return; }
      const checkedQuestionIds = history.map(attempt => attempt.questionId);
      const priorQuestionContexts = history.map(attempt => attempt.questionSentence).filter(Boolean);
      const excluded = [...knownContexts,
        ...priorQuestionContexts, ...contextsRef.current];
      const transportContexts = [...new Set(excluded.map(text => text.replace(/\s+/g, ' ').trim()))]
        .filter(Boolean).map(text => text.slice(0, 500)).slice(0, 12);
      const requestedLevel = level?.trim().toUpperCase();
      const result = await requestAfterReadingAgent({
        request: { intent: 'after_reading', articleId, articleTitle,
          articleContext: contextsRef.current.join('\n\n'), learnerWords, learningSummary,
          allowImmediatePractice: true, verificationContexts: transportContexts,
          level: requestedLevel && /^(A1|A2|B1|B2|C1|C2)$/.test(requestedLevel) ? requestedLevel : 'B1' },
        excludedContextTexts: excluded, excludedQuestionIds: checkedQuestionIds, signal: controller.signal,
      });
      const nextQuestion = result.question;
      if (!mounted.current || generation !== requestGeneration.current) return;
      setQuestion(nextQuestion);
      setAvailable(Boolean(nextQuestion));
      attemptRef.current = nextQuestion ? {
        id: readingVerificationAttemptId(articleId, getLocalDateInTimeZone(now, store.timezone)),
        questionId: nextQuestion.id,
      } : null;
    } catch {
      if (!mounted.current || generation !== requestGeneration.current) return;
      if (controller.signal.aborted) return;
      setRequestError('暂时无法准备词义核对，请稍后重试。');
    } finally {
      if (generation === requestGeneration.current) {
        abortRef.current = null;
        if (mounted.current) setLoading(false);
      }
    }
  }, [ready, readingComplete, readCandidates, articleId, articleTitle, store.timezone, level]);

  const request = useCallback(() => {
    if (pendingRequest.current) return pendingRequest.current;
    const promise = prepare();
    pendingRequest.current = promise;
    const release = () => { if (pendingRequest.current === promise) pendingRequest.current = null; };
    void promise.then(release, release);
    return promise;
  }, [prepare]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      autoPrepared.current = false;
      abortRef.current?.abort(); abortRef.current = null;
      pendingRequest.current = null;
      requestGeneration.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!ready || !readingComplete || autoPrepared.current) return;
    autoPrepared.current = true;
    void request();
  }, [ready, readingComplete, request]);

  const onOutcome = useCallback(async (
    outcome: ReadingVerificationAttemptSummary['outcome'], selectedOptionId?: string,
  ) => {
    const attempt = attemptRef.current;
    if (!question || !attempt || attempt.questionId !== question.id) {
      throw new Error('这道题已更新，请重新打开词义核对。');
    }
    // Learning or an answer in another pause/tab can invalidate an open question.
    await qualifyReadingVerificationAttempt(attempt, question.wordId, {
      articleId, timezone: store.timezone, readCandidates: async () => {
        const fresh = await readCandidates();
        return { candidates: question.purpose === 'immediate_practice' ? fresh.practiceCandidates : fresh.candidates,
          now: fresh.now };
      },
      isCurrent: () => attemptRef.current === attempt && attempt.questionId === question.id,
    });
    await recordVerification({ attemptId: attempt.id, questionId: question.id,
      wordId: question.wordId, articleId, outcome, selectedOptionId, questionSentence: question.sentence,
      purpose: question.purpose, readingTask: { type: 'context_choice', contextVisible: true,
        answerExposed: question.purpose === 'immediate_practice',
        mapping: question.purpose === 'immediate_practice' ? 'practice_only' : 'hard_on_correct' } });
  }, [question, articleId, readCandidates, recordVerification, store.timezone]);

  return { question, available, loading, requestError, onRequest: request, onOutcome, cancelRequest };
}
