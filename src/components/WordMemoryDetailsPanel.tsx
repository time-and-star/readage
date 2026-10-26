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
            {details.hasRecall && <span>正式回忆 {details.reviewCount} 次</span>}
          </div>
          {details.hasRecall ? <>
            <dl className="word-memory-details__metrics">
              <div><dt>长期熟练度</dt><dd>L{details.level}<small>{Math.round(details.score!)} 分</small></dd><span>{details.levelLabel}</span></div>
              <div><dt>当前遗忘风险</dt><dd>{Math.round(details.forgettingRiskPercent!)}<small>%</small></dd><span>模型估计</span></div>
            </dl>
            <dl className="word-memory-details__dates">
            <div><dt>上次回忆</dt><dd>{memoryDateLabel(details.lastReviewAt, timezone)}</dd></div>
            <div><dt>下次复习</dt><dd>{details.nextReviewAt ? memoryDateLabel(details.nextReviewAt, timezone)
              : details.status === 'paused' || details.status === 'removed' ? '安排已停止，恢复词卡后继续' : '尚未安排'}</dd></div>
            </dl>
          </> : <p className="word-memory-details__empty">还没有正式回忆记录。完成独立词卡回忆或延迟确认后，会在这里显示熟练度。{details.practiceCount > 0 && details.nextReviewAt && <span>练习已记录，下次复习 {memoryDateLabel(details.nextReviewAt, timezone)}。</span>}</p>}
          {(details.lastAssistedAt || details.exposureCount > 0 || details.reviews.length > 0 || details.practiceCount > 0) && <details className="word-memory-details__audit">
          <summary>回忆与查词明细</summary>
          {(details.lastAssistedAt || details.exposureCount > 0 || details.practiceCount > 0) && <p className="word-memory-details__note">{details.exposureCount > 0 && <span>阅读接触 {details.exposureCount} 次</span>}
            {details.practiceCount > 0 && <span>即时练习 {details.practiceCount} 次</span>}
            {details.lastAssistedAt && <span>上次查词 {memoryDateLabel(details.lastAssistedAt, timezone)}</span>}</p>}
          {details.reviews.length > 0 && <ol className="word-memory-details__history" aria-label="最近正式回忆记录">
            {details.reviews.map((review, index) => <li key={`${review.review}:${index}`}>
              <span className="word-memory-details__event">{review.source === 'flashcard' ? '词卡' : review.source === 'verification' ? '延迟确认' : '历史复习'} · {FLASHCARD_RATING_LABELS[review.rating] ?? '已记录'}{review.flashcardRevisions?.length ? <small>已纠正</small> : null}</span>
              <time dateTime={review.review}>{memoryDateLabel(review.review, timezone)}</time>
            </li>)}
          </ol>}
          </details>}
          <details className="word-memory-details__explanation"><summary>这些数字如何理解</summary>
            <p>长期熟练度根据记忆稳定性计算，与词卡、我的学习共用同一记录。时间经过只改变当前风险，不自动降低等级。</p>
            <p>普通查词只记录求助，不自动扣分；实际回忆失败会更新稳定性，旧评分按当时的规则保留。</p>
            {details.hasRecall && <p>预计回忆率 {Math.round(details.recallPercent!)}%，与当前遗忘风险互补。风险来自默认模型，尚未按个人记录拟合；刚复习后的 0% 是模型起点，不保证不会忘记。</p>}
            <p>分数不是掌握百分比，口语、写作和全部词义尚未纳入评分。</p>
          </details>
        </>}
    </div>}
  </details>;
};
