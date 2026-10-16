import React, { useState } from 'react';
import { ChevronDown, History } from 'lucide-react';
import { useWordMemoryDetails } from '../lib/useWordMemoryDetails';
import { FLASHCARD_RATING_LABELS, memoryDateLabel } from '../lib/wordMemoryDetails';

export const WordMemoryDetailsPanel: React.FC<{ wordId: string; initiallyOpen?: boolean }> = ({ wordId, initiallyOpen = false }) => {
  const [open, setOpen] = useState(initiallyOpen);
  const { details, loading, error, timezone, retry } = useWordMemoryDetails(wordId, open);
  return <details className="word-memory-details" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><History size={15} aria-hidden="true" /><span>单词记忆记录</span><ChevronDown size={15} className="word-memory-details__chevron" aria-hidden="true" /></summary>
    {open && <div className="word-memory-details__body">
      {error ? <p role="alert">{error} <button type="button" onClick={retry}>重试</button></p>
        : loading || !details ? <p role="status">正在读取记忆记录…</p> : <>
          <div className="word-memory-details__heading"><span className="word-memory-details__status">{details.statusLabel}</span>
            {details.hasRecall && <span>正式回忆 {details.reviewCount} 次</span>}</div>
          {details.hasRecall ? <>
            <dl className="word-memory-details__metrics">
              <div><dt>识别熟悉度</dt><dd>L{details.level}<small>{Math.round(details.score!)} 分</small></dd><span>{details.levelLabel}</span></div>
              <div><dt>当前回忆率预测</dt><dd>{Math.round(details.recallPercent!)}<small>%</small></dd><span>随时间变化的估计</span></div>
            </dl>
            <dl className="word-memory-details__dates">
            <div><dt>上次回忆</dt><dd>{memoryDateLabel(details.lastReviewAt, timezone)}</dd></div>
            <div><dt>下次复习</dt><dd>{details.nextReviewAt ? memoryDateLabel(details.nextReviewAt, timezone)
              : details.status === 'paused' || details.status === 'removed' ? '安排已停止，恢复词卡后继续' : '尚未安排'}</dd></div>
            </dl>
          </> : <p className="word-memory-details__empty">还没有回忆记录。完成词卡回忆或延迟确认后，会在这里显示熟悉度。</p>}
          {(details.lastAssistedAt || details.exposureCount > 0) && <p className="word-memory-details__note">{details.exposureCount > 0 && <span>阅读接触 {details.exposureCount} 次</span>}
            {details.lastAssistedAt && <span>上次查词 {memoryDateLabel(details.lastAssistedAt, timezone)}</span>}</p>}
          {details.reviews.length > 0 && <ol className="word-memory-details__history" aria-label="最近正式回忆记录">
            {details.reviews.map((review, index) => <li key={`${review.review}:${index}`}>
              <span className="word-memory-details__event">{review.source === 'flashcard' ? '词卡' : review.source === 'verification' ? '延迟确认' : '历史复习'} · {FLASHCARD_RATING_LABELS[review.rating] ?? '已记录'}{review.flashcardRevisions?.length ? <small>已纠正</small> : null}</span>
              <time dateTime={review.review}>{memoryDateLabel(review.review, timezone)}</time>
            </li>)}
          </ol>}
          <details className="word-memory-details__explanation"><summary>这些数字如何理解</summary><p>熟悉度反映长期识别稳定程度。回忆率预测随时间变化，刚复习后的 100% 是模型起点，并非实测成绩。阅读接触和查词会留下记录；口语和写作能力尚未纳入评分。</p></details>
        </>}
    </div>}
  </details>;
};
