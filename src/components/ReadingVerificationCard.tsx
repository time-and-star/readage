import React, { useEffect, useId, useRef, useState } from 'react';
import type { ReadingVerificationQuestion } from '../lib/readingVerificationQuestions';
import {
  VerificationSubmissionGate,
  type ReadingVerificationOutcome,
  type VerificationSubmission,
} from '../lib/readingVerificationCardState';

export type { ReadingVerificationOutcome } from '../lib/readingVerificationCardState';

export interface ReadingVerificationCardProps {
  question: ReadingVerificationQuestion | null;
  available?: boolean;
  loading?: boolean;
  requestError?: string;
  onRequest: () => void | Promise<void>;
  onOutcome: (outcome: ReadingVerificationOutcome, selectedOptionId?: string) => Promise<void>;
  onActiveChange?: (active: boolean) => void;
}

const actionClass = 'min-h-11 rounded-xl border border-[#DDD6C8] bg-white px-4 py-2.5 text-sm text-[#5B544B] disabled:opacity-50';

/** A cancelled preparation releases its slot immediately and cannot finish a newer one. */
export class ReadingVerificationRequestGate {
  private epoch = 0;
  private active: number | null = null;

  begin(): number | null {
    if (this.active !== null) return null;
    this.active = ++this.epoch;
    return this.active;
  }

  isCurrent(epoch: number): boolean { return this.active === epoch; }

  cancel(): void {
    this.epoch += 1;
    this.active = null;
  }

  finish(epoch: number): boolean {
    if (!this.isCurrent(epoch)) return false;
    this.active = null;
    return true;
  }
}

/** Exact words and phrases are bold; a target never matches inside another word. */
export function renderVerificationSentence(sentence: string, wordId: string): React.ReactNode[] {
  const target = wordId.trim().split(/\s+/).filter(Boolean)
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
  if (!target) return [sentence];
  const pattern = new RegExp(`(?<![a-z])${target}(?![a-z])`, 'gi');
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (const match of sentence.matchAll(pattern)) {
    const index = match.index!;
    if (index > cursor) parts.push(sentence.slice(cursor, index));
    parts.push(<strong key={index} className="font-semibold text-[#2A2621]">{match[0]}</strong>);
    cursor = index + match[0].length;
  }
  if (cursor < sentence.length) parts.push(sentence.slice(cursor));
  return parts.length ? parts : [sentence];
}

interface VerificationQuestionViewProps {
  question: ReadingVerificationQuestion;
  answer?: VerificationSubmission | null;
  saving?: boolean;
  saveError?: boolean;
  canCorrectGuess?: boolean;
  onAnswer: (optionId: string) => void;
  onUncertain: () => void;
  onSkip: () => void;
  onGuessed: () => void;
  onRetry: () => void;
  onContinue: () => void;
}

/** Presentational view also makes every answer/feedback state easy to verify. */
export function ReadingVerificationQuestionView({
  question, answer = null, saving = false, saveError = false, canCorrectGuess = false,
  onAnswer, onUncertain, onSkip, onGuessed, onRetry, onContinue,
}: VerificationQuestionViewProps) {
  const correctOption = question.options.find(option => option.id === question.correctOptionId);
  const selectedOption = question.options.find(option => option.id === answer?.selectedOptionId);
  const showExplanation = answer && answer.outcome !== 'skipped';
  return <div className="space-y-4">
    {question.purpose === 'immediate_practice' && <p className="text-xs leading-relaxed text-[#8C8478]">
      巩固这次阅读的理解；答对并不表示已经长期记住。
    </p>}
    <p className="text-xs leading-relaxed text-[#8C8478]">这句里的粗体表达，最接近哪个意思？</p>
    <p lang="en" className="break-words font-serif text-base leading-relaxed text-[#443E36]">
      {renderVerificationSentence(question.sentence, question.wordId)}
    </p>
    <div className="grid gap-2" role="group" aria-label="选择这个表达在句子里的意思">
      {question.options.map(option => <button
        key={option.id} type="button" disabled={Boolean(answer) || saving}
        aria-pressed={answer?.selectedOptionId === option.id}
        onClick={() => onAnswer(option.id)}
        className={`min-h-11 w-full rounded-xl border px-3 py-3 text-left disabled:cursor-default ${answer?.selectedOptionId === option.id
          ? 'border-[#A94E2B] bg-[#F4EAE2]' : 'border-[#DDD6C8] bg-white'}`}
      >
        <span lang="en" className="block break-words text-sm font-medium leading-relaxed text-[#443E36]">{option.en}</span>
        <span lang="zh" className="mt-1 block break-words text-xs leading-relaxed text-[#8C8478]">{option.zh}</span>
      </button>)}
    </div>
    {!answer && <div className="flex flex-wrap gap-2">
      <button type="button" disabled={saving} className={actionClass} onClick={onUncertain}>不确定，看看解释</button>
      <button type="button" disabled={saving} className={actionClass} onClick={onSkip}>这次跳过</button>
    </div>}
    {answer && <div role="status" className="space-y-2 rounded-xl bg-[#F3F0E8] p-3 text-sm leading-relaxed text-[#5B544B]">
      <p>{answer.outcome === 'recognized' ? '这次识别出来了。'
        : answer.outcome === 'incorrect' ? '这个句子里，下面的意思更合适。'
          : answer.outcome === 'uncertain' ? '可以先看看这个表达在句子里的意思。'
            : answer.outcome === 'guessed' ? '已标记为猜测，下次再遇见时可以留意一下。'
              : '已跳过，继续读就好。'}</p>
      {showExplanation && correctOption && <p>
        <span lang="en" className="block font-medium">{correctOption.en}</span>
        <span lang="zh" className="block text-xs text-[#756D63]">{correctOption.zh}</span>
      </p>}
      {showExplanation && <p className="break-words text-xs">{answer.outcome === 'incorrect'
        ? selectedOption?.explanationZh || question.explanationZh : question.explanationZh}</p>}
    </div>}
    {saving && <p role="status" className="text-xs text-[#8C8478]">正在保存学习记录…</p>}
    {saveError && <div role="alert" className="space-y-2 text-xs text-[#8F3F22]">
      <p>学习记录暂时没保存，可以重试。</p>
      <button type="button" disabled={saving} className={actionClass} onClick={onRetry}>重试保存</button>
    </div>}
    <div className="flex flex-wrap gap-2">
      {answer?.outcome === 'recognized' && <button type="button" disabled={saving || saveError || !canCorrectGuess}
        className={actionClass} onClick={onGuessed}>其实我是猜的</button>}
      <button type="button" disabled={saving} className={actionClass} onClick={onContinue}>继续阅读</button>
    </div>
  </div>;
}

export function ReadingVerificationCard({
  question, available = true, loading = false, requestError,
  onRequest, onOutcome, onActiveChange,
}: ReadingVerificationCardProps) {
  const contentId = useId();
  const [expanded, setExpanded] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [localRequestError, setLocalRequestError] = useState(false);
  const [displayedQuestion, setDisplayedQuestion] = useState<ReadingVerificationQuestion | null>(null);
  const [answer, setAnswer] = useState<VerificationSubmission | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [finished, setFinished] = useState(false);
  const gateRef = useRef(new VerificationSubmissionGate());
  const requestGateRef = useRef(new ReadingVerificationRequestGate());
  const answeredRef = useRef(false);
  const activeCallbackRef = useRef(onActiveChange);
  activeCallbackRef.current = onActiveChange;

  useEffect(() => {
    activeCallbackRef.current?.(expanded);
  }, [expanded]);
  useEffect(() => () => {
    requestGateRef.current.cancel();
    activeCallbackRef.current?.(false);
  }, []);

  useEffect(() => {
    if (!expanded || requesting || loading || answeredRef.current) return;
    if (available && question) setDisplayedQuestion(question);
    else if (!available && !requestError && !localRequestError) {
      setDisplayedQuestion(null);
      setExpanded(false);
    }
  }, [expanded, requesting, loading, question, available, requestError, localRequestError]);

  const requestQuestion = async () => {
    const epoch = requestGateRef.current.begin();
    if (epoch === null) return;
    setRequesting(true);
    setLocalRequestError(false);
    setDisplayedQuestion(null);
    try { await onRequest(); }
    catch { if (requestGateRef.current.isCurrent(epoch)) setLocalRequestError(true); }
    finally { if (requestGateRef.current.finish(epoch)) setRequesting(false); }
  };

  const expandCard = () => {
    setExpanded(true);
    if (!answer && !question) void requestQuestion();
  };

  const submit = async (submission: VerificationSubmission) => {
    const gate = gateRef.current;
    if (!gate.canSubmit(submission)) return;
    // The gate reserves the answer synchronously, before React disables buttons.
    answeredRef.current = true;
    setAnswer(submission);
    setSaving(true);
    setSaveError(false);
    try { await gate.submit(submission, onOutcome); }
    catch { setSaveError(true); }
    finally { setSaving(false); }
  };

  const continueReading = () => {
    if (gateRef.current.busy) return;
    requestGateRef.current.cancel();
    setRequesting(false);
    if (!answer) setDisplayedQuestion(null);
    // Abort synchronously, so an immediate reopen starts a separate request.
    activeCallbackRef.current?.(false);
    setExpanded(false);
    // Unsaved answers stay folded and can retry; completed questions disappear.
    if (gateRef.current.saved && !gateRef.current.failed) setFinished(true);
  };

  if (finished || (!available && !expanded && !saveError)) return null;
  const error = requestError || (localRequestError ? '暂时没能准备好这道题，可以重试。' : undefined);
  return <section data-reading-interaction="true" aria-label="可选的阅读理解确认"
    className="my-6 min-w-0 rounded-2xl border border-[#E0DBCF] bg-[#FAF8F3] p-4 sm:p-5">
    {!expanded ? <button type="button" aria-expanded={false} aria-controls={contentId}
      className="flex min-h-11 w-full min-w-0 flex-col gap-1 text-left" onClick={expandCard}>
      <span className="text-sm font-medium text-[#5B544B]">用一个新句子确认一下理解</span>
      <span className="text-xs leading-relaxed text-[#8C8478]">{saveError ? '学习记录待保存，点开后可以重试' : '可选 · 一句话，三个意思 · 不影响继续阅读'}</span>
    </button> : <div id={contentId} className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-[#5B544B]">换个句子，看看是否理解</p>
        <button type="button" disabled={saving} className={actionClass} onClick={continueReading}>收起</button>
      </div>
      {(requesting || loading) && !answer ? <p role="status" className="text-sm text-[#8C8478]">正在准备一个新句子…</p>
        : displayedQuestion ? <ReadingVerificationQuestionView
          question={displayedQuestion} answer={answer} saving={saving} saveError={saveError}
          canCorrectGuess={gateRef.current.saved?.outcome === 'recognized'}
          onAnswer={optionId => {
            if (answeredRef.current) return;
            void submit({ outcome: optionId === displayedQuestion.correctOptionId ? 'recognized' : 'incorrect', selectedOptionId: optionId });
          }}
          onUncertain={() => { if (!answeredRef.current) void submit({ outcome: 'uncertain' }); }}
          onSkip={() => { if (!answeredRef.current) void submit({ outcome: 'skipped' }); }}
          onGuessed={() => { void submit({ outcome: 'guessed', selectedOptionId: answer?.selectedOptionId }); }}
          onRetry={() => { if (gateRef.current.failed) void submit(gateRef.current.failed); }}
          onContinue={continueReading}
        /> : <div className="space-y-3">
          <p role={error ? 'alert' : 'status'} className="break-words text-sm text-[#756D63]">{error || '暂时没有适合的新句子，可以继续阅读。'}</p>
          {error && <button type="button" className={actionClass} onClick={() => { void requestQuestion(); }}>重试准备</button>}
          <button type="button" className={actionClass} onClick={continueReading}>继续阅读</button>
        </div>}
    </div>}
  </section>;
}
