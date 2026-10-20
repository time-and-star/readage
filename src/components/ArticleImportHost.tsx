import React, { lazy, Suspense, useRef, useState } from 'react';
import type { Article } from '../types';
import type { LibraryEntry } from '../lib/contentLibraryEntry';
import type { BookImportActivity } from '../lib/bookImportActivity';
import { ArticleImportLoading, PageLoadBoundary } from './PageLoadBoundary';
import { LibraryBookTitle } from './LibraryBookTitle';
import './ArticleImportHost.css';

const EnterArticleModal = lazy(() => import('./EnterArticleModal').then(module => ({ default: module.EnterArticleModal })));

interface ArticleImportHostProps {
  open: boolean;
  entry: LibraryEntry;
  history: Article[];
  onOpen: () => void;
  onClose: () => void;
  onSubmitCustomArticles: (articles: Article[], notice?: string) => void;
}

const phaseLabels: Record<BookImportActivity['phase'], string> = {
  downloading: '正在下载书籍',
  preparing: '正在整理章节',
  ready: '已准备好加入书架',
  paused: '整理已暂停',
  error: '导入需要重试',
};

/** Keep the import session alive while its dialog is put away or the app changes pages. */
export function ArticleImportHost({ open, entry, history, onOpen, onClose, onSubmitCustomArticles }: ArticleImportHostProps) {
  const [activity, setActivity] = useState<BookImportActivity | null>(null);
  const mounted = open || Boolean(activity);
  const previousMounted = useRef(false);
  const sessionEntry = useRef(entry);
  if (mounted && !previousMounted.current) sessionEntry.current = entry;
  previousMounted.current = mounted;

  const working = activity?.phase === 'downloading' || activity?.phase === 'preparing';
  const progress = activity?.phase === 'downloading' && activity.totalBytes && activity.totalBytes > 0
    ? { value: Math.min(activity.receivedBytes ?? 0, activity.totalBytes), max: activity.totalBytes, label: '书籍下载进度' }
    : activity?.phase === 'preparing' && activity.totalCount && activity.totalCount > 0
      ? { value: Math.min(activity.preparedCount ?? 0, activity.totalCount), max: activity.totalCount, label: '章节整理进度' }
      : null;

  return <>
    {mounted && <div className="article-import-surface" hidden={!open}>
      <PageLoadBoundary onClose={onClose}>
        <Suspense fallback={open ? <ArticleImportLoading onClose={onClose} /> : null}>
          <EnterArticleModal history={history} entry={sessionEntry.current} visible={open} onClose={onClose}
            onActivityChange={setActivity} onSubmitCustomArticles={(articles, notice) => {
              setActivity(null);
              onSubmitCustomArticles(articles, notice);
            }} />
        </Suspense>
      </PageLoadBoundary>
    </div>}
    {!open && activity && <aside className="article-import-task" aria-label="书籍导入任务">
      <button type="button" className="article-import-task__open" onClick={onOpen} aria-label={`查看导入任务：${activity.title}`}>
        <span className={`article-import-task__marker${working ? ' is-working' : ''}`} aria-hidden="true">{working ? '' : activity.phase === 'ready' ? '✓' : '!'}</span>
        <span className="article-import-task__body">
          <span className="article-import-task__phase" role="status">{phaseLabels[activity.phase]}</span>
          <span className="article-import-task__title"><LibraryBookTitle title={activity.title} /></span>
          <span className="article-import-task__detail">{activity.detail}</span>
          {progress ? <progress className="article-import-task__progress" aria-label={progress.label} value={progress.value} max={progress.max} />
            : working ? <progress className="article-import-task__progress" aria-label={activity.phase === 'downloading' ? '正在下载书籍' : '正在整理章节'} /> : null}
        </span>
        <span className="article-import-task__arrow" aria-hidden="true">›</span>
      </button>
    </aside>}
  </>;
}
