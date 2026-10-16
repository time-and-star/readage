import type { FC } from 'react';
import type { EntryProvenance } from '../../packages/dictionary/contracts';

export const DictionarySourceProvenance: FC<{ items?: readonly EntryProvenance[] }> = ({ items }) => {
  const unique = [...new Map<string, EntryProvenance>((items ?? []).map((item: EntryProvenance) => [JSON.stringify(item), item])).values()];
  if (!unique.length) return null;
  return <details className="word-card-source-extras" aria-label="来源与许可">
    <summary>来源与许可</summary>
    <ul>{unique.map((item, index) => <li key={index}>
      <span>{item.label || item.kind}</span>
      {item.detail && <> · {/^https?:\/\/\S+$/i.test(item.detail)
        ? <a href={item.detail} target="_blank" rel="noreferrer">{item.detail}</a> : <span>{item.detail}</span>}</>}
      {item.status && <span> · {item.status === 'confirmed' ? '已确认' : item.status}</span>}
    </li>)}</ul>
  </details>;
};
