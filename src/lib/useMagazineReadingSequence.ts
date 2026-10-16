import { useCallback, useEffect, useState } from 'react';
import type { Article } from '../types';
import { loadMagazineReadingContinuation, type MagazineReadingContinuation } from './magazineReadingSequence';

type SequenceState =
  | { articleId: string; status: 'loading' }
  | { articleId: string; status: 'ready'; continuation: MagazineReadingContinuation }
  | { articleId: string; status: 'error'; message: string };

/** Reconstructs the sequence after refresh; old requests cannot supply another issue's successor. */
export function useMagazineReadingSequence(article: Article | null, enabled: boolean) {
  const articleId = enabled ? article?.id : undefined;
  const issueId = enabled ? article?.magazineIssueId : undefined;
  const [state, setState] = useState<SequenceState | null>(null);
  const [retry, setRetry] = useState(0);
  const reload = useCallback(() => setRetry(value => value + 1), []);

  useEffect(() => {
    if (!articleId || !issueId) return;
    const controller = new AbortController();
    setState({ articleId, status: 'loading' });
    void loadMagazineReadingContinuation({ id: articleId, magazineIssueId: issueId }, { signal: controller.signal })
      .then(continuation => {
        if (!controller.signal.aborted) setState({ articleId, status: 'ready', continuation });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ articleId, status: 'error', message: '阅读目录或下一篇暂时无法加载，可以重试。' });
      });
    return () => controller.abort();
  }, [articleId, issueId, retry]);

  return {
    state: !articleId || !issueId ? null
      : state?.articleId === articleId ? state : { articleId, status: 'loading' as const },
    reload,
  };
}
