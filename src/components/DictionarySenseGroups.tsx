import React, { useEffect, useState } from 'react';
import type { DictionaryPartOfSpeechGroup, DictionaryRecord } from '../types';
import { isDictionaryExampleVisible } from '../../packages/dictionary/compat/englishPresentation';
import { WordCardText } from './WordCardText';

interface Props {
  record: DictionaryRecord;
  idPrefix?: string;
}

function labelForPartOfSpeech(value: string): string {
  return ({
    'n.': '名词',
    'v.': '动词',
    'adj.': '形容词',
    'adv.': '副词',
    'prep.': '介词',
    'pron.': '代词',
  } as Record<string, string>)[value] ?? value;
}

const SenseGroup: React.FC<{ group: DictionaryPartOfSpeechGroup; imported: boolean; idPrefix?: string }> = ({ group, imported, idPrefix }) => {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => setExpanded(false), [group.id]);
  const senses = expanded ? group.senses : group.senses.slice(0, 2);
  const headingId = `dictionary-pos-${idPrefix ? `${idPrefix}:` : ''}${group.id}`;
  return (
    <section className="word-card-pos-group" aria-labelledby={headingId}>
      <div className="word-card-pos-group__header">
        <h4 id={headingId}>{labelForPartOfSpeech(group.partOfSpeech)}</h4>
        <span className="word-card-chip word-card-chip--accent">{group.partOfSpeech}</span>
        {group.usageLabels.filter((label) => label !== group.partOfSpeech).map((label) => (
          <span key={label} className="word-card-chip">{label}</span>
        ))}
      </div>
      <ol className="word-card-senses">
        {senses.map((sense, index) => (
          <li key={sense.id} className="word-card-sense">
            <span className="word-card-sense__index">{index + 1}</span>
            <div className="word-card-sense__body">
              {(sense.definitionZh || !imported) && <p className="word-card-sense__translation">{sense.definitionZh || '中文释义待审核'}</p>}
              <p>
                {sense.usageLabels.length > 0 && <span className="word-card-sense__pos">{sense.usageLabels.join(' / ')}</span>}
                <WordCardText text={sense.definitionEn} />
              </p>
              {sense.definitionZhCandidates && sense.definitionZhCandidates.length > 1 && (
                <p className="word-card-sense__note">中文候选：{sense.definitionZhCandidates.join('；')}</p>
              )}
              {sense.examples.some(isDictionaryExampleVisible) && (
                <div className="word-card-sense__examples">
                  <span className="word-card-sense__label">例句</span>
                  {sense.examples.filter(isDictionaryExampleVisible).map((example) => (
                    <p key={example.id}>
                      <WordCardText text={example.en} />
                      {example.zh && <span className="word-card-sense__example-zh">{example.zh}</span>}
                    </p>
                  ))}
                </div>
              )}
              {sense.collocations.length > 0 && (
                <div className="word-card-sense__collocations">
                  <span className="word-card-sense__label">搭配</span>
                  {sense.collocations.map((collocation, collocationIndex) => (
                    <span key={`${sense.id}-collocation-${collocationIndex}`} className="word-card-chip word-card-chip--collocation">
                      <WordCardText text={collocation.en} />{collocation.zh && <span> · {collocation.zh}</span>}
                    </span>
                  ))}
                </div>
              )}
              {sense.grammarNotes.length > 0 && (
                <ul className="word-card-bullet-list">
                  {sense.grammarNotes.map((note) => <li key={note}><WordCardText text={note} /></li>)}
                </ul>
              )}
            </div>
          </li>
        ))}
      </ol>
      {group.senses.length > 2 && (
        <button type="button" className="word-card-expand" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
          {expanded ? '收起义项' : `展开全部 ${group.senses.length} 个义项`}
        </button>
      )}
    </section>
  );
};

export const DictionarySenseGroups: React.FC<Props> = ({ record, idPrefix }) => (
  <section className="word-card-section" aria-label="词性与义项">
    <span className="word-card-section__eyebrow">词性与义项</span>
    {record.partOfSpeechGroups.map((group) => <SenseGroup key={group.id} group={group} imported={record.edit.authoringMethod === 'pack-import'} idPrefix={idPrefix} />)}
    {record.supplementaryChinese.length > 0 && (
      <div className="word-card-supplementary">
        <span className="word-card-section__eyebrow">补充简释</span>
        <p>{record.supplementaryChinese.join('；')}</p>
      </div>
    )}
    {record.phrases.length > 0 && (
      <div className="word-card-phrases">
        <span className="word-card-section__eyebrow">短语</span>
        {record.phrases.map((phrase) => (
          <div key={phrase.id} className="word-card-phrase">
            <strong><WordCardText text={phrase.phrase} /></strong>
            {phrase.definitionZh && <span>{phrase.definitionZh}</span>}
            {phrase.definitionEn && <span><WordCardText text={phrase.definitionEn} /></span>}
          </div>
        ))}
      </div>
    )}
  </section>
);
