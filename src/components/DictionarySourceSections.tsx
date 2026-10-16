import type { DictionarySourceView } from '../types';
import { DictionarySenseGroups } from './DictionarySenseGroups';
import { DictionaryOriginalContent } from './DictionaryOriginalContent';
import { WordCardText } from './WordCardText';
import { ReadAgeEntrySections } from './ReadAgeEntrySections';
import { dictionaryDisplayName } from '../lib/dictionaryDisplay';
import { WordCardRelatedButton } from './WordCardRelatedButton';
import { DictionarySourceProvenance } from './DictionarySourceProvenance';

export function DictionarySourceSections({ sources, onLookupRelated, initiallyExpanded = true, preferAuthored = false }: {
  sources: readonly DictionarySourceView[]; onLookupRelated?: (word: string) => void; initiallyExpanded?: boolean; preferAuthored?: boolean;
}) {
  const authoredSource = preferAuthored ? sources.find(source => source.readageContent) : undefined;
  const orderedSources = authoredSource ? [authoredSource, ...sources.filter(source => source !== authoredSource)] : sources;
  return <div className="word-card-dictionary-sources" aria-label="各词典释义">
    {orderedSources.map(source => {
      const { dictionaryRef, record, originalContent, readageContent } = source;
      return <details open={source === authoredSource || initiallyExpanded} className="word-card-dictionary-source"
      key={`${dictionaryRef.dictionaryId}:${dictionaryRef.entryId}`} aria-label={dictionaryDisplayName(dictionaryRef) ?? dictionaryRef.dictionaryId}>
      <summary className="word-card-dictionary-source__header">
        <span>{dictionaryDisplayName(dictionaryRef) ?? dictionaryRef.dictionaryId}</span>
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
          ? <WordCardRelatedButton key={word} word={word} className="word-card-chip word-card-chip--link" onLookup={onLookupRelated} />
          : <span key={word} className="word-card-chip"><WordCardText text={word} /></span>)}</div>
      </div>}
      <DictionarySourceProvenance items={source.provenance ?? record.edit.source} />
    </details>;
    })}
  </div>;
}
