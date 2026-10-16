import type { DifficultyFeedback } from '../lib/readingPreference';

export function ReadingDifficultyControl({ value, onChange }: { value?: DifficultyFeedback; onChange: (value: DifficultyFeedback) => void }) {
  return <div className="my-6 flex flex-wrap items-center gap-2 border-t border-stone-200 pt-4 text-xs text-stone-600" data-reading-interaction="true">
    <span>这篇读起来</span>
    {([['hard', '偏难'], ['right', '合适'], ['easy', '偏易']] as const).map(([rating, label]) =>
      <button key={rating} aria-pressed={value === rating} onClick={() => onChange(rating)}
        className={`min-h-10 rounded-lg border px-3 ${value === rating ? 'border-[#A94E2B] bg-[#F3E4DA] text-[#8F3F22]' : 'border-stone-200 bg-white'}`}>{label}</button>)}
    <span role="status">{value ? '已记住，将调整后续推荐' : '可选，帮助调整下一篇'}</span>
  </div>;
}
