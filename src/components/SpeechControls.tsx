import React from 'react';
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
  if (!active && !state.error && !state.notice) return null;
  return (
    <div className={floating
      ? 'fixed top-20 left-1/2 z-[80] w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 rounded-xl border border-[#E0D9CB] bg-[#FAF8F3] p-3 text-xs text-[#524B43] shadow-lg'
      : 'mx-auto flex w-full max-w-3xl items-center justify-between gap-3 px-5 py-2 text-xs text-[#524B43]'}>
      <p role={state.error ? 'alert' : 'status'} className="leading-5">
        {state.error || state.notice || (state.status === 'loading' ? '正在准备朗读…' : '正在朗读')}
      </p>
      <button type="button" onClick={onStop}
        className="min-h-10 shrink-0 rounded-lg border border-[#E0D9CB] px-3 hover:bg-[#EFEAE0]"
        aria-label={active ? '停止朗读' : '关闭朗读提示'}>{active ? '停止' : '关闭'}</button>
    </div>
  );
}
