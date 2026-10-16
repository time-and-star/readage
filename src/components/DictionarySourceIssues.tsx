import type { DictionarySourceIssue, DictionarySourceMiss } from '../../packages/dictionary/compat/englishTypes';
import { dictionaryDisplayName } from '../lib/dictionaryDisplay';

export function DictionarySourceIssues({ issues, misses, onRetry }: {
  issues?: readonly DictionarySourceIssue[]; misses?: readonly DictionarySourceMiss[]; onRetry?: () => void;
}) {
  if (!issues?.length && !misses?.length) return null;
  return <>
    {issues?.length ? <div className="dictionary-source-issues" role="status">
      <p>{issues.map(dictionaryDisplayName).join('、')}暂时无法读取，已显示其他词典的结果。</p>
      {onRetry && <button type="button" onClick={onRetry}>重试词典</button>}
    </div> : null}
    {misses?.length ? <p className="dictionary-source-misses" role="status">
      {misses.map(dictionaryDisplayName).join('、')}未收录此词。
    </p> : null}
  </>;
}
