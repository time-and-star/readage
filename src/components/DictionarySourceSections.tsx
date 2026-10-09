import type { DictionarySourceView } from '../types';
import { DictionarySenseGroups } from './DictionarySenseGroups';
import { DictionaryOriginalContent } from './DictionaryOriginalContent';
import { WordCardText } from './WordCardText';
import { ReadAgeEntrySections } from './ReadAgeEntrySections';

export function DictionarySourceSections({ sources, onLookupRelated, initiallyExpanded = true }: {
  sources: readonly DictionarySourceView[]; onLookupRelated?: (word: string) => void; initiallyExpanded?: boolean;
}) {
  return <div className="word-card-dictionary-sources" aria-label="各词典释义">
    {sources.map(({ dictionaryRef, record, originalContent, readageContent }) => <details open={initiallyExpanded} className="word-card-dictionary-source"
      key={`${dictionaryRef.dictionaryId}:${dictionaryRef.entryId}`} aria-label={dictionaryRef.dictionaryName ?? dictionaryRef.dictionaryId}>
      <summary className="word-card-dictionary-source__header">
        <span>{dictionaryRef.dictionaryName ?? dictionaryRef.dictionaryId}</span>
        <span lang="en">{record.lemma}</span>
      </summary>
      {!readageContent && record.phonetic && <p className="word-card-meta__phonetic">{record.phonetic}</p>}
      {readageContent ? <ReadAgeEntrySections word={readageContent} onLookupRelated={onLookupRelated} />
        : originalContent ? <DictionaryOriginalContent content={originalContent} onLookupRelated={onLookupRelated} />
        : <DictionarySenseGroups record={record} idPrefix={`${dictionaryRef.dictionaryId}:${dictionaryRef.entryId}`} />}
      {!readageContent && record.wordForms.length > 0 && <div className="word-card-source-extras">
        <span className="word-card-section__eyebrow">词形</span>
        <div className="word-card-chip-list">{record.wordForms.map((form, index) =>
          <span key={index} className="word-card-chip word-card-chip--form">{form.label} <WordCardText text={form.value} /></span>)}</div>
      </div>}
      {!readageContent && record.wordFamily.length > 0 && <div className="word-card-source-extras">
        <span className="word-card-section__eyebrow">相关词</span>
        <div className="word-card-chip-list">{record.wordFamily.map(word => onLookupRelated
          ? <button key={word} type="button" className="word-card-chip word-card-chip--link" onClick={() => onLookupRelated(word)}>{word}</button>
          : <span key={word} className="word-card-chip"><WordCardText text={word} /></span>)}</div>
      </div>}
    </details>)}
  </div>;
}
