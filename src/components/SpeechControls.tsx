import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Square, X } from 'lucide-react';
import type { SpeechPreferences, SpeechState } from '../lib/speech';

export function SpeechControls({ preferences, onChange }: {
  preferences: SpeechPreferences;
  onChange: (preferences: Partial<SpeechPreferences>) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2 px-3 py-2">
      <label className="text-xs text-[#7B7267]">
        英语口音
        <select aria-label="朗读英语口音" value={preferences.lang}
          onChange={(event) => onChange({ lang: event.target.value as SpeechPreferences['lang'] })}
          className="mt-1 w-full min-h-10 rounded-lg border border-[#E0D9CB] bg-white px-2 text-sm text-[#3D372E]">
          <option value="en-US">美音</option>
          <option value="en-GB">英音</option>
        </select>
      </label>
      <label className="text-xs text-[#7B7267]">
        语速
        <select aria-label="朗读语速" value={preferences.rate}
          onChange={(event) => onChange({ rate: Number(event.target.value) })}
          className="mt-1 w-full min-h-10 rounded-lg border border-[#E0D9CB] bg-white px-2 text-sm text-[#3D372E]">
          {[0.75, 0.9, 1, 1.1, 1.25, 1.5].map((rate) => <option key={rate} value={rate}>{rate}×</option>)}
        </select>
      </label>
    </div>
  );
}

export function SpeechFeedback({ state, onStop, floating = false }: {
  state: SpeechState;
  onStop: () => void;
  floating?: boolean;
}) {
  const active = state.status === 'loading' || state.status === 'speaking';
  const [hidden, setHidden] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  useEffect(() => {
    setHidden(false);
    if (active || state.error || detailsOpen) return;
    const timer = window.setTimeout(() => setHidden(true), 3000);
    return () => window.clearTimeout(timer);
  }, [active, state.status, state.error, state.notice, state.timing, detailsOpen]);
  if (hidden || (!active && !state.error && !state.notice && !state.timing)) return null;
  const message = state.error || (active
    ? state.status === 'loading' ? '准备朗读…' : '正在朗读'
    : state.notice || '朗读完成');
  const feedback = (
    <div className={floating
      ? 'fixed top-20 left-1/2 z-[80] flex w-max max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-full border border-[#E0D9CB] bg-[#FAF8F3] py-1 pl-4 pr-1 text-xs text-[#524B43] shadow-sm'
      : 'mx-auto flex w-full max-w-3xl items-center justify-between gap-3 px-5 py-2 text-xs text-[#524B43]'}>
      <p role={state.error ? 'alert' : 'status'} title={state.notice} className="leading-5">
        {message}
      </p>
      {state.timing?.firstPlaybackMs !== undefined && <details
        onToggle={(event) => setDetailsOpen(event.currentTarget.open)}
        className="text-[#7B7267]">
        <summary aria-label="播放耗时详情" className="cursor-pointer whitespace-nowrap text-[11px]">{(state.timing.firstPlaybackMs / 1000).toFixed(2)} 秒</summary>
        <dl className={floating
          ? 'absolute right-0 top-full mt-2 grid w-56 max-w-[calc(100vw-2rem)] grid-cols-2 gap-x-3 gap-y-2 rounded-xl border border-[#E0D9CB] bg-[#FAF8F3] p-3 shadow-sm'
          : 'mt-1 grid grid-cols-2 gap-x-3 gap-y-1'}>
          <dt>音频来源</dt><dd>{state.timing.cache === 'browser' ? '浏览器缓存' : state.timing.cache === 'server' ? '服务端缓存' : state.timing.cache === 'shared' ? '共用请求' : '新合成'}</dd>
          <dt>首段音频就绪</dt><dd>{((state.timing.firstAudioMs || 0) / 1000).toFixed(2)} 秒</dd>
          {state.timing.queueMs !== undefined && <><dt>模型排队</dt><dd>{(state.timing.queueMs / 1000).toFixed(2)} 秒</dd></>}
          {state.timing.inferenceMs !== undefined && <><dt>CPU 合成</dt><dd>{(state.timing.inferenceMs / 1000).toFixed(2)} 秒</dd></>}
          {state.timing.preprocessingMs !== undefined && <><dt>文字预处理</dt><dd>{(state.timing.preprocessingMs / 1000).toFixed(2)} 秒</dd></>}
        </dl>
      </details>}
      <button type="button" onClick={onStop}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full hover:bg-[#EFEAE0]"
        title={active ? '停止朗读' : '关闭朗读提示'}
        aria-label={active ? '停止朗读' : '关闭朗读提示'}>
        {active ? <Square size={12} fill="currentColor" /> : <X size={14} />}
      </button>
    </div>
  );
  return floating && typeof document !== 'undefined' ? createPortal(feedback, document.body) : feedback;
}
