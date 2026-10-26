import React, { useMemo, useState } from 'react';
import { buildFlashcardStatistics } from '../lib/flashcardStatistics';
import type { WordMemoryState } from '../lib/memoryV2/types';
import './flashcardStatistics.css';

export interface FlashcardStatisticsPanelProps {
  states: readonly WordMemoryState[];
  timezone: string;
  desiredRetention?: number;
  now?: Date;
  canonicalWordIds?: ReadonlyMap<string, string>;
}

export function FlashcardStatisticsPanel({ states, timezone, desiredRetention, now, canonicalWordIds }: FlashcardStatisticsPanelProps) {
  const [open, setOpen] = useState(false);
  const statistics = useMemo(() => open
    ? buildFlashcardStatistics(states, { timezone, desiredRetention, now, canonicalWordIds }) : null,
  [open, states, timezone, desiredRetention, now, canonicalWordIds]);
  return <details className="flashcard-statistics" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>近30天复习效果</summary>
    {statistics && <div className="flashcard-statistics__body">
      <p className="flashcard-statistics__range">{statistics.fromLocalDate} — {statistics.throughLocalDate} · 当前目标 {Math.round(statistics.desiredRetention * 100)}%</p>
      <dl className="flashcard-statistics__metrics">
        <div><dt>延迟回忆</dt><dd>{statistics.delayedRecallCount}<small> 次</small></dd></div>
        <div><dt>自评回忆率</dt><dd>{statistics.recallRate === null ? '暂无' : `${Math.round(statistics.recallRate * 100)}%`}</dd></div>
        <div><dt>反复遗忘词</dt><dd>{statistics.repeatedForgottenWords.length}<small> 个</small></dd></div>
      </dl>
      <p>{statistics.comparisonNote}</p>
      {statistics.repeatedForgottenWords.length > 0 && <p className="flashcard-statistics__forgotten">
        本期至少3次隔日忘记：{statistics.repeatedForgottenWords.map((word, index) => <React.Fragment key={word.wordId}>
          {index > 0 && '、'}<span>{word.wordId}（{word.failureCount}次）</span>
        </React.Fragment>)}。
      </p>}
      <details className="flashcard-statistics__note"><summary>统计口径</summary><p>只统计每词每天首次词卡回忆，距前次评审至少24小时，且已进入长期复习。初学、学习／重学、当天重复、查词和阅读接触不计入；评分以纠正后的记录为准。提前或逾期复习、词的难度和自评尺度都会影响结果。统一 FSRS 参数尚未进行个人拟合；与目标的比较仅供观察，不代表统计显著。</p></details>
    </div>}
  </details>;
}
