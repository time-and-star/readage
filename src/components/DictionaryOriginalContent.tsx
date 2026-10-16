import React, { useContext, useMemo } from 'react';
import { WordCardText } from './WordCardText';
import { WordCardInteractionContext } from './WordCardInteractionContext';
import {
  parseDictionaryOriginalContent,
  type OriginalDictionaryContent,
  type SafeDictionaryContentNode,
} from '../lib/dictionaryOriginalContent';

interface DictionaryOriginalContentProps {
  content: OriginalDictionaryContent;
  onLookupRelated?: (word: string) => void;
}

/** Render only parser-produced inert nodes. No source HTML, attributes, CSS or URLs enter the DOM. */
export const DictionaryOriginalContent: React.FC<DictionaryOriginalContentProps> = ({ content, onLookupRelated }) => {
  const interactions = useContext(WordCardInteractionContext);
  const parsed = useMemo(() => parseDictionaryOriginalContent(content), [content.mediaType, content.content, content.plainText]);
  function renderNode(node: SafeDictionaryContentNode, key: string, inLookup = false): React.ReactNode {
    if (typeof node === 'string') return inLookup ? node : <WordCardText key={key} text={node} sentence={false} />;
    const children = node.children.map((child, index) => renderNode(child, `${key}:${index}`, inLookup || node.kind === 'lookup'));
    if (node.kind === 'lookup') {
      if (!onLookupRelated || inLookup) return <span key={key}>{children}</span>;
      return <button key={key} type="button" className="dictionary-original-content__related"
        data-word-card-text={interactions ? 'true' : undefined} onClick={event => {
          if (interactions) interactions.lookup(node.word, event.currentTarget.getBoundingClientRect());
          else onLookupRelated(node.word);
        }}>
        {children}
      </button>;
    }
    if (node.tag === 'br' || node.tag === 'hr') return React.createElement(node.tag, { key });
    const sentenceBlock = interactions && ['p', 'div', 'li', 'blockquote', 'td', 'th', 'dt', 'dd', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(node.tag);
    return React.createElement(node.tag, { key, ...node.attributes, ...(sentenceBlock ? { 'data-word-card-sentence': 'true' } : {}) }, children);
  }
  return (
    <div className={`dictionary-original-content${parsed.format === 'text' ? ' dictionary-original-content--text' : ''}`}
      data-word-card-sentence={interactions ? 'true' : undefined}>
      {parsed.nodes.map((node, index) => renderNode(node, String(index)))}
      {parsed.truncated && <p className="dictionary-original-content__notice" role="status">词条内容较长，仅显示前一部分。</p>}
    </div>
  );
};
