import React from 'react';
import type { DictionaryEntry, LookupResult } from '../../packages/dictionary/contracts';
import { DictionaryOriginalContent } from './DictionaryOriginalContent';
import { dictionaryDisplayName } from '../lib/dictionaryDisplay';
import { WordCardRelatedButton } from './WordCardRelatedButton';
import { DictionarySourceProvenance } from './DictionarySourceProvenance';

/** Language-neutral entries use the same word-card sections as the English dictionary. */
export function NeutralDictionarySections({ result, onLookupRelated, onRetry }: {
  result: LookupResult; onLookupRelated: (word: string) => void; onRetry?: () => void;
}) {
  return <div className="word-card-dictionary-sources" aria-label="各词典释义">
    {result.sources.map(source => <details open className="word-card-dictionary-source" key={source.dictionaryId}
      aria-label={dictionaryDisplayName(source) || source.dictionaryId}>
      <summary className="word-card-dictionary-source__header">
        <span>{dictionaryDisplayName(source) || source.dictionaryId}</span>
        <span lang={result.request.language}>{source.matches[0]?.entry.headword}</span>
      </summary>
      {source.status === 'unavailable' ? <div className="word-card-source-extras" role="alert">
        <p>此词典暂时无法读取。</p>
        {onRetry && <button type="button" className="word-card-action" onClick={onRetry}>重试词典</button>}
      </div> : source.status === 'not_found' ? <p className="word-card-source-extras">未收录</p>
        : source.matches.map(match => <NeutralEntry key={match.entry.entryId} entry={match.entry} query={result.request.text}
          inflection={match.matchKind === 'inflection'} onLookupRelated={onLookupRelated} />)}
      <DictionarySourceProvenance items={[...(source.provenance ?? []), ...source.matches.flatMap(match => match.entry.provenance)]} />
    </details>)}
    {!result.sources.length && <p className="word-card-copy">请在词典设置中安装并启用此语言的词典。</p>}
    {result.status === 'invalid_request' && <p className="word-card-copy" role="alert">查询内容无效，请缩短文本后重试。</p>}
  </div>;
}

const NeutralEntry: React.FC<{
  entry: DictionaryEntry; query: string; inflection: boolean; onLookupRelated: (word: string) => void;
}> = ({ entry, query, inflection, onLookupRelated }) => {
  return <section className="word-card-section" lang={entry.language}>
    <div className="word-card-meta">
      <span className="word-card-chip">{entry.headword}</span>
      {entry.readings.map((reading, index) => <span key={index} className="word-card-meta__phonetic" lang={reading.language}>{reading.text}</span>)}
      {inflection && <span>由 {query} 还原</span>}
      {entry.levels?.map(level => <span key={level.system} className="word-card-chip">{level.system} {level.value}</span>)}
    </div>
    {entry.content.kind === 'structured' ? <>
      <ol className="word-card-senses">
        {entry.content.senses.map((sense, index) => <li key={sense.id} className="word-card-sense">
          <span className="word-card-sense__index">{index + 1}</span>
          <div className="word-card-sense__body">
            {sense.partOfSpeech && <span className="word-card-sense__pos">{sense.partOfSpeech}</span>}
            {sense.definitions.map((definition, i) => <p key={i} lang={definition.language}>{definition.text}</p>)}
            {sense.translations.map((translation, i) => <p key={i} lang={translation.language} className="word-card-sense__translation">{translation.text}</p>)}
            {!!sense.labels?.length && <p className="word-card-copy">{sense.labels.join(' · ')}</p>}
            {!!sense.examples.length && <ol className="word-card-examples">
              {sense.examples.map(example => <li key={example.id}>
                <p lang={example.text.language}>{example.text.text}</p>
                {example.translations?.map((translation, i) => <p key={i} lang={translation.language} className="word-card-sense__translation">{translation.text}</p>)}
              </li>)}
            </ol>}
          </div>
        </li>)}
      </ol>
      {entry.content.notes?.map((note, i) => <p key={i} lang={note.language} className="word-card-copy">{note.text}</p>)}
    </> : <DictionaryOriginalContent content={entry.content} onLookupRelated={onLookupRelated} />}
    {!!entry.forms?.length && <div className="word-card-source-extras">
      <span className="word-card-section__eyebrow">词形</span>
      <div className="word-card-chip-list">{entry.forms.map((form, i) => <WordCardRelatedButton key={i} word={form.text}
        language={entry.language} onLookup={onLookupRelated} className="word-card-chip word-card-chip--link">{form.label} {form.text}</WordCardRelatedButton>)}</div>
    </div>}
  </section>;
};
