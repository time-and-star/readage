import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ReadAgeExample, ReadAgeSense, ReadAgeWord } from '../../packages/dictionary/readage';
import { DictionaryOriginalContent } from './DictionaryOriginalContent';
import { WordCardRelatedButton } from './WordCardRelatedButton';

type Item = Record<string, unknown>;
type Lookup = ((word: string) => void) | undefined;
const labels: Record<string, string> = {
  cefr: '语言等级', frequency: '词频', register: '语域', domains: '使用领域', britishAmerican: '英美差异',
  tone: '语气', examTags: '考试范围', commonConfusion: '常见混淆', syllables: '音节', stress: '重音',
  level: '语言等级', levelSource: '等级来源', levelLabel: '难度说明', note: '说明', title: '说明',
  paragraphs: '补充说明', spellingDiff: '拼写', phoneticDiff: '发音', ipa: '音标',
  grammarNote: '语法说明', structure: '句子结构', analysis: '句子分析', rule: '用法规则', special: '其他情况',
};
const values: Record<string, string> = {
  noun: '名词', verb: '动词', adjective: '形容词', adverb: '副词', preposition: '介词', pronoun: '代词', conjunction: '连词',
  transitive: '及物', intransitive: '不及物', countable: '可数', uncountable: '不可数',
  visual: '形近', phonetic: '音近', homophone: '同音', synonym: '近义', antonym: '反义', confusable: '易混', cognate: '同根',
  contextual: '视语境而定', yes: '可以替换', no: '不可直接替换', base: '原形', plural: '复数', third: '第三人称单数',
  past: '过去式', pastParticiple: '过去分词', presentParticiple: '现在分词', variant: '拼写变体',
};
const internal = new Set(['id', 'wordId', 'senseId', 'sourceWordId', 'targetWordId', 'sourceSenseId', 'targetSenseId',
  'index', 'known', 'score', 'weight', 'sourceType', 'isCore', 'language', 'relationType']);
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const object = (value: unknown): Item => value && typeof value === 'object' && !Array.isArray(value) ? value as Item : {};
const items = (value: unknown): Item[] => Array.isArray(value) ? value.filter(item => item && typeof item === 'object').map(object) : [];
function present(value: unknown): boolean {
  return value !== null && value !== undefined && value !== '' && (Array.isArray(value) ? value.some(present)
    : typeof value === 'object' ? Object.entries(value).some(([key, item]) => !internal.has(key) && present(item)) : true);
}
/** Detailed entries keep a full reading line; CSS sizes short entries by their actual text width. */
function needsReadingRow(item: Item, compactFields: string[]): boolean {
  return Object.entries(item).some(([key, value]) => !internal.has(key) && !compactFields.includes(key) && present(value));
}
const collocationFields = ['phrase', 'meaningZh'];
const familyFields = ['word', 'pos', 'zh'];
const comparisonFields = ['word', 'target', 'targetLemma', 'pos', 'zh', 'relationTypes', 'interchangeable'];
const formFields = ['form', 'formType', 'label', 'irregular'];
function Prose({ value, onLookup, className = '' }: { value: unknown; onLookup?: Lookup; className?: string }) {
  if (!present(value)) return null;
  const content = typeof value === 'string' ? values[value] ?? value : String(value);
  return <div className={`readage-prose ${className}`}><DictionaryOriginalContent
    content={{ mediaType: 'text/html', content, plainText: content }} onLookupRelated={onLookup} /></div>;
}
const ExtraContent: React.FC<{ value: unknown; onLookup?: Lookup }> = ({ value, onLookup }) => {
  if (!present(value)) return null;
  if (Array.isArray(value)) return <div className="readage-stack">{value.filter(present).map((item, i) => <ExtraContent key={i} value={item} onLookup={onLookup} />)}</div>;
  if (typeof value === 'object') return <dl className="readage-facts">{Object.entries(value).filter(([key, item]) => !internal.has(key) && present(item)).map(([key, item]) =>
    <div key={key}><dt>{labels[key] ?? '补充说明'}</dt><dd><ExtraContent value={item} onLookup={onLookup} /></dd></div>)}</dl>;
  return <Prose value={typeof value === 'boolean' ? value ? '是' : '否' : value} onLookup={onLookup} />;
};
function Remaining({ item, used, onLookup }: { item: Item; used: string[]; onLookup?: Lookup }) {
  const extra = Object.fromEntries(Object.entries(item).filter(([key]) => !used.includes(key) && !internal.has(key)));
  return present(extra) ? <Note title="补充说明"><ExtraContent value={extra} onLookup={onLookup} /></Note> : null;
}
function RelatedWord({ word, onLookup }: { word: string; onLookup?: Lookup }) {
  return onLookup ? <WordCardRelatedButton word={word} className="readage-related-word" onLookup={onLookup} /> : <strong lang="en">{word}</strong>;
}
function Module({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return <section className="readage-module"><h4 className="readage-module-heading"><strong>{title}</strong>{description && <small>{description}</small>}</h4>
    <div className="readage-module-body">{children}</div></section>;
}
function Note({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="readage-inline-section"><h6>{title}</h6>{children}</div>;
}
function Empty({ children = '这个词条暂未补充这部分内容。' }: { children?: React.ReactNode }) {
  return <p className="readage-empty">{children}</p>;
}
const Example: React.FC<{ example: ReadAgeExample; onLookup?: Lookup }> = ({ example, onLookup }) => {
  return <div className="readage-example"><Prose value={example.english} onLookup={onLookup} className="readage-example-en" />
    <Prose value={example.chinese} onLookup={onLookup} className="readage-translation" />
    {(present(example.structure) || present(example.analysis)) && <Note title="句子分析">
      {present(example.structure) && <div className="readage-note"><h6>句子结构</h6><Prose value={example.structure} onLookup={onLookup} /></div>}
      <Prose value={example.analysis} onLookup={onLookup} /></Note>}
    <Remaining item={example} used={['english', 'chinese', 'structure', 'analysis', 'label']} onLookup={onLookup} />
  </div>;
};
const Sense: React.FC<{ sense: ReadAgeSense; index: number; onLookup?: Lookup }> = ({ sense, index, onLookup }) => {
  const notes = [sense.explanationZh, sense.grammar, sense.usageScenes, sense.cautions].some(present);
  return <section className="readage-sense" aria-label={`义项 ${index + 1} ${sense.titleZh ?? ''}`}>
    <div className="readage-sense-heading"><span className="readage-sense-number">{String(index + 1).padStart(2, '0')}</span><h5>{sense.titleZh || '释义'}</h5>
      <span className="readage-sense-pos">{values[sense.partOfSpeech] ?? sense.partOfSpeech}{text(sense.transitivity) && ` · ${values[text(sense.transitivity)] ?? text(sense.transitivity)}`}</span></div>
    <Prose value={sense.definitionEn} onLookup={onLookup} className="readage-definition" />
    <Prose value={sense.definitionZhTranslation} onLookup={onLookup} className="readage-translation" />
    {sense.examples.map((example, i) => <Example key={example.id ?? i} example={example} onLookup={onLookup} />)}
    {notes && <Note title={`用法说明${text(sense.domain) ? ` · ${text(sense.domain)}` : ''}`}>
      {present(sense.explanationZh) && <div className="readage-note"><h6>中文详解</h6><Prose value={sense.explanationZh} onLookup={onLookup} /></div>}
      {present(sense.grammar) && <div className="readage-note"><h6>语法与句型</h6><ExtraContent value={sense.grammar} onLookup={onLookup} /></div>}
      {present(sense.usageScenes) && <div className="readage-note"><h6>使用场景</h6><ExtraContent value={sense.usageScenes} onLookup={onLookup} /></div>}
      <Prose value={sense.cautions} onLookup={onLookup} />
      {text(sense.register) && <p className="readage-caption">语域：{text(sense.register)}</p>}
    </Note>}
    <Remaining item={sense} used={['titleZh', 'partOfSpeech', 'transitivity', 'domain', 'register', 'definitionEn', 'definitionZhTranslation', 'explanationZh', 'examples', 'grammar', 'usageScenes', 'cautions', 'synonyms', 'antonyms', 'collocations']} onLookup={onLookup} />
  </section>;
};
function BilingualExample({ item, onLookup }: { item: Item; onLookup?: Lookup }) {
  return text(item.exampleEn) ? <Example example={{ id: '', english: text(item.exampleEn), chinese: text(item.exampleZh) }} onLookup={onLookup} /> : null;
}
function ComparisonDetail({ label, content, onLookup }: { label: string; content: unknown[]; onLookup?: Lookup }) {
  const paragraphs = [...new Set(content.filter(present))];
  if (!paragraphs.length) return null;
  return <div className="readage-comparison-detail"><span className="readage-detail-label">{label}</span><div>
    {paragraphs.map((value, i) => <div key={i}><Prose value={value} onLookup={onLookup} /></div>)}
  </div></div>;
}
const Comparison: React.FC<{ item: Item; onLookup?: Lookup }> = ({ item, onLookup }) => {
  const lemma = text(item.word) || text(item.targetLemma) || text(item.target) || text(item.targetWordId);
  const relationLabels = Array.isArray(item.relationTypes) ? item.relationTypes.map(type => values[String(type)] ?? String(type)) : [];
  return <article className={`readage-item readage-comparison${needsReadingRow(item, comparisonFields) ? ' readage-flow-wide' : ''}`}><div className="readage-item-heading"><RelatedWord word={lemma} onLookup={onLookup} />
    {text(item.pos) && <span className="readage-caption">{values[text(item.pos)] ?? text(item.pos)}</span>}
    <Prose value={item.zh} className="readage-comparison-gloss" onLookup={onLookup} />
    {relationLabels.length > 0 && <span className="readage-comparison-tag">{relationLabels.join(' · ')}</span>}
    {text(item.interchangeable) && <span className="readage-comparison-tag">{values[text(item.interchangeable)] ?? text(item.interchangeable)}</span>}</div>
    <ComparisonDetail label="区别" content={[item.semanticDiff, item.focus, item.explanation]} onLookup={onLookup} />
    <ComparisonDetail label="替换" content={[item.reason]} onLookup={onLookup} />
    <ComparisonDetail label="搭配" content={[item.collocationDiff, item.collocation]} onLookup={onLookup} />
    <Prose value={item.note} className="readage-comparison-note" onLookup={onLookup} />
    <BilingualExample item={item} onLookup={onLookup} />
    {present(item.spellingDiff) || present(item.phoneticDiff) || present(item.ipa) ? <Note title="拼写和发音">
      <ExtraContent value={{ spellingDiff: item.spellingDiff, phoneticDiff: item.phoneticDiff, ipa: item.ipa }} onLookup={onLookup} /></Note> : null}
    <Remaining item={item} used={['word', 'target', 'targetLemma', 'pos', 'relationTypes', 'zh', 'semanticDiff', 'focus', 'explanation', 'reason', 'note', 'interchangeable', 'collocationDiff', 'collocation', 'exampleEn', 'exampleZh', 'spellingDiff', 'phoneticDiff', 'ipa']} onLookup={onLookup} />
  </article>;
};
const Context: React.FC<{ item: Item; onLookup?: Lookup }> = ({ item, onLookup }) => {
  return <article className="readage-item">{text(item.domain) && <p className="readage-caption">{text(item.domain)}</p>}
    <Example example={{ id: '', english: text(item.en) || text(item.english) || text(item.sentence), chinese: text(item.zh) || text(item.chinese) }} onLookup={onLookup} />
    <ExtraContent value={{ structure: item.structure, grammarNote: item.grammar ?? item.grammarPoint, analysis: item.rationale ?? item.analysis }} onLookup={onLookup} />
    <Remaining item={item} used={['domain', 'en', 'english', 'sentence', 'zh', 'chinese', 'structure', 'grammar', 'grammarPoint', 'rationale', 'analysis']} onLookup={onLookup} />
  </article>;
};
function Etymology({ value, onLookup }: { value: unknown; onLookup?: Lookup }) {
  if (!present(value)) return <Empty />;
  if (typeof value === 'string') return <Prose value={value} onLookup={onLookup} />;
  const item = object(value);
  return <div><Prose value={item.origin} onLookup={onLookup} />
    {(['prefix', 'root', 'suffix'] as const).some(key => present(item[key])) && <div className="readage-word-parts">{(['prefix', 'root', 'suffix'] as const).filter(key => present(item[key])).map(key => {
      const part = object(item[key]);
      return <div key={key}><span className="readage-caption">{{ prefix: '前缀', root: '词根', suffix: '后缀' }[key]}</span><strong>{text(part.text) || text(item[key])}</strong>
        <Prose value={part.gloss} onLookup={onLookup} /><Remaining item={part} used={['text', 'gloss']} onLookup={onLookup} /></div>;
    })}</div>}
    {items(item.history).map((step, i) => <div className="readage-history" key={i}><strong>{text(step.label)}</strong><Prose value={step.text} onLookup={onLookup} /></div>)}
    <Prose value={item.formationLogic} onLookup={onLookup} />
    {present(item.mnemonic) && <div className="readage-memory-note"><h6>记忆提示</h6><Prose value={item.mnemonic} onLookup={onLookup} /></div>}
    <Prose value={item.note} onLookup={onLookup} /><Prose value={item.source} className="readage-caption" onLookup={onLookup} />
    <Remaining item={item} used={['origin', 'prefix', 'root', 'suffix', 'history', 'formationLogic', 'mnemonic', 'note', 'source']} onLookup={onLookup} />
  </div>;
}
function ReadAgeQuiz({ questions, contexts, onLookup }: { questions: Item[]; contexts: Item[]; onLookup?: Lookup }) {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [checked, setChecked] = useState<Record<number, boolean>>({});
  const quizId = useId();
  const quizRef = useRef<HTMLDivElement>(null);
  const previousIndex = useRef(index);
  useEffect(() => {
    if (previousIndex.current === index) return;
    previousIndex.current = index;
    quizRef.current?.scrollIntoView({ block: 'start' });
    quizRef.current?.focus({ preventScroll: true });
  }, [index]);
  if (!questions.length) return <Empty>这个词条还没有练习题。可以先用释义和例句理解它。</Empty>;
  const q = questions[index];
  const options = Array.isArray(q.options) ? q.options.map(String) : [];
  const hasAnswer = Object.hasOwn(answers, index);
  const relatedContexts = contexts.filter(context => context.senseId && context.senseId === q.senseId);
  return <div className="readage-quiz" ref={quizRef} tabIndex={-1}><div className="readage-quiz-progress"><span>第 {index + 1} / {questions.length} 题</span><span>已核对 {Object.values(checked).filter(Boolean).length} 题</span></div>
    <h4>即时检测</h4><p className="readage-caption">选一个答案，再点“核对答案”。</p>
    {relatedContexts.length > 0 && <Note title="题目语境">{relatedContexts.map((context, i) => <Context key={i} item={context} onLookup={onLookup} />)}</Note>}
    <fieldset className="readage-question"><legend>{text(q.prompt) || text(q.question)}</legend>
      {options.map((option, i) => <label key={i} className={`readage-option${answers[index] === option ? ' readage-option--selected' : ''}${checked[index] && option === text(q.answer) ? ' readage-option--correct' : checked[index] && answers[index] === option ? ' readage-option--incorrect' : ''}`}>
        <input type="radio" name={`${quizId}-${index}`} value={option} checked={answers[index] === option} disabled={Boolean(checked[index])}
          onChange={() => setAnswers(current => ({ ...current, [index]: option }))} /><span>{option}</span></label>)}
    </fieldset>
    {checked[index] && <div role="status" className={`readage-feedback${answers[index] === text(q.answer) ? ' readage-feedback--correct' : ''}`}>
      <strong>{answers[index] === text(q.answer) ? '回答正确' : `正确答案：${text(q.answer)}`}</strong><Prose value={q.explain ?? q.explanation} onLookup={onLookup} /></div>}
    <div className="readage-quiz-actions">{index > 0 && <button type="button" className="readage-secondary-button" onClick={() => setIndex(index - 1)}>上一题</button>}
      {!checked[index] ? <button type="button" className="readage-primary-button" disabled={!hasAnswer} onClick={() => setChecked(current => ({ ...current, [index]: true }))}>核对答案</button>
        : index < questions.length - 1 ? <button type="button" className="readage-primary-button" onClick={() => setIndex(index + 1)}>下一题</button>
          : <button type="button" className="readage-primary-button" onClick={() => { setIndex(0); setAnswers({}); setChecked({}); }}>重新练习</button>}</div>
  </div>;
}
const tabs = [{ id: 'meanings', label: '释义' }, { id: 'usage', label: '用法' }, { id: 'explore', label: '拓展' }, { id: 'practice', label: '练习' }] as const;
type Tab = typeof tabs[number]['id'];
/** Give the full authored entry clear reading and practice paths, without flattening its fields. */
export function ReadAgeEntrySections({ word, onLookupRelated: onLookup }: { word: ReadAgeWord; onLookupRelated?: (word: string) => void }) {
  const [activeTab, setActiveTab] = useState<Tab>('meanings');
  const entryRef = useRef<HTMLDivElement>(null);
  const previousTab = useRef(activeTab);
  useLayoutEffect(() => {
    if (previousTab.current === activeTab) return;
    previousTab.current = activeTab;
    const entry = entryRef.current;
    // Reset an obscured entry in its own scroller without moving the page behind a card.
    for (let scroller = entry?.parentElement; entry && scroller; scroller = scroller.parentElement) {
      const style = getComputedStyle(scroller);
      if (!/^(auto|scroll|overlay)$/.test(style.overflowY)) continue;
      const top = scroller.getBoundingClientRect().top + scroller.clientTop + parseFloat(style.paddingTop);
      const offset = entry.getBoundingClientRect().top - top;
      if (offset < 0) scroller.scrollTop += offset;
      break;
    }
  }, [activeTab]);
  const entryId = useId();
  const contexts = items(word.contexts);
  const relations = [...items(word.relations), ...items(word.confused)];
  const collocationCount = word.senses.reduce((sum, sense) => sum + sense.collocations.length, 0);
  const comparisons = word.senses.filter(sense => items(sense.synonyms).length || items(sense.antonyms).length);
  return <div ref={entryRef} className="readage-entry" aria-label="ReadAge 完整词条">
    <div className="readage-tabs" role="tablist" aria-label="词条内容">{tabs.map((tab, i) => <button type="button" key={tab.id} id={`${entryId}-tab-${tab.id}`}
      role="tab" aria-selected={activeTab === tab.id} aria-controls={`${entryId}-${tab.id}`} tabIndex={activeTab === tab.id ? 0 : -1}
      onClick={() => setActiveTab(tab.id)} onKeyDown={event => {
        let next: number | undefined;
        if (event.key === 'ArrowRight') next = (i + 1) % tabs.length;
        if (event.key === 'ArrowLeft') next = (i + tabs.length - 1) % tabs.length;
        if (event.key === 'Home') next = 0;
        if (event.key === 'End') next = tabs.length - 1;
        if (next !== undefined) { event.preventDefault(); setActiveTab(tabs[next].id); const buttons = event.currentTarget.parentElement?.querySelectorAll('[role="tab"]'); (buttons?.[next] as HTMLButtonElement | undefined)?.focus({ preventScroll: true }); }
      }}>{tab.label}</button>)}</div>
    <section className="readage-panel" role="tabpanel" tabIndex={0} id={`${entryId}-meanings`} aria-labelledby={`${entryId}-tab-meanings`} hidden={activeTab !== 'meanings'}>
      <div className="readage-core"><Prose value={word.coreMeaning.zh} onLookup={onLookup} className="readage-core-meaning" />
        {(present(word.coreMeaning.en) || present(word.coreMeaning.note)) && <Note title="核心概念"><Prose value={word.coreMeaning.en} onLookup={onLookup} /><Prose value={word.coreMeaning.note} onLookup={onLookup} /></Note>}</div>
      <div className="readage-panel-heading"><h4>释义与例句</h4><span>{word.senses.length} 个义项</span></div>
      {word.senses.map((sense, i) => <Sense key={sense.id} sense={sense} index={i} onLookup={onLookup} />)}
      {!word.senses.length && <Empty />}
    </section>
    <section className="readage-panel" role="tabpanel" tabIndex={0} id={`${entryId}-usage`} aria-labelledby={`${entryId}-tab-usage`} hidden={activeTab !== 'usage'}>
      {collocationCount > 0 && <Module title="搭配与句型" description={`${collocationCount} 个搭配`}><div className="readage-flow readage-collocation-groups">{word.senses.filter(sense => sense.collocations.length).map(sense => <section key={sense.id}
        className={`readage-collocation-group${sense.collocations.some(item => needsReadingRow(item, collocationFields)) ? ' readage-flow-wide' : ''}`}>
        <h5 className="readage-group-title">{sense.titleZh}</h5><div className="readage-flow readage-collocation-list">{sense.collocations.map((collocation, i) => <article className={`readage-item readage-collocation${needsReadingRow(collocation, collocationFields) ? ' readage-flow-wide' : ''}`} key={i}>
          <Prose value={collocation.phrase} className="readage-phrase" onLookup={onLookup} /><Prose value={collocation.meaningZh} className="readage-translation" onLookup={onLookup} />
          <BilingualExample item={collocation} onLookup={onLookup} /><Prose value={collocation.grammarNote} onLookup={onLookup} />
          <Remaining item={collocation} used={['phrase', 'meaningZh', 'exampleEn', 'exampleZh', 'grammarNote']} onLookup={onLookup} /></article>)}</div></section>)}</div></Module>}
      {(present(word.mistakes) || present(word.mistakeNote)) && <Module title="常见错误" description={`${items(word.mistakes).length} 处用法提醒`}>{items(word.mistakes).map((mistake, i) => <article className="readage-item" key={i}>
        <div className="readage-correction readage-correction--wrong"><span>误用</span><Prose value={mistake.wrong} onLookup={onLookup} /></div>
        <div className="readage-correction"><span>改为</span><Prose value={mistake.right} onLookup={onLookup} /></div>
        <Prose value={mistake.reason} onLookup={onLookup} /><ExtraContent value={{ rule: mistake.rule, special: mistake.special }} onLookup={onLookup} />
        <Remaining item={mistake} used={['wrong', 'right', 'reason', 'rule', 'special', 'errorType']} onLookup={onLookup} /></article>)}
        <Prose value={word.mistakeNote} className="readage-caption" onLookup={onLookup} /></Module>}
      {(contexts.length > 0 || present(word.contextNote)) && <Module title="语境与长难句" description={`${contexts.length} 个语境 · 句子结构与解析`}>{contexts.map((context, i) => <Context key={i} item={context} onLookup={onLookup} />)}
        <Prose value={word.contextNote} className="readage-caption" onLookup={onLookup} /></Module>}
      {present(word.usage) && <Module title="词汇使用范围" description="语域、考试与英美用法"><ExtraContent value={word.usage} onLookup={onLookup} /></Module>}
      <Prose value={word.note} onLookup={onLookup} /><Prose value={word.pitfall} onLookup={onLookup} />
      {!collocationCount && !present(word.mistakes) && !present(word.contexts) && !present(word.usage) && !present(word.note) && !present(word.pitfall) && !present(word.mistakeNote) && !present(word.contextNote) && <Empty />}
    </section>
    <section className="readage-panel" role="tabpanel" tabIndex={0} id={`${entryId}-explore`} aria-labelledby={`${entryId}-tab-explore`} hidden={activeTab !== 'explore'}>
      {(word.forms.length > 0 || present(word.formNote)) && <Module title="词形变化" description={`${word.forms.length} 个词形`}><dl className="readage-facts readage-forms readage-flow">{word.forms.map((form, i) => <div key={i}
        className={needsReadingRow(form, formFields) ? 'readage-flow-wide' : undefined}>
        <dt>{form.label || values[form.formType] || '词形'}</dt><dd><RelatedWord word={form.form} onLookup={onLookup} />{form.irregular === true && <small>不规则变化</small>}
          <Remaining item={form} used={['form', 'formType', 'label', 'irregular']} onLookup={onLookup} /></dd></div>)}</dl>
        <Prose value={word.formNote} onLookup={onLookup} /></Module>}
      {(word.family.length > 0 || present(word.familyNote)) && <Module title="词汇家族" description={`${word.family.length} 个关联词`}><div className="readage-flow readage-family-list">{word.family.map((member, i) => <article className={`readage-item${needsReadingRow(member, familyFields) ? ' readage-flow-wide' : ''}`} key={i}>
        <div className="readage-item-heading"><RelatedWord word={member.word} onLookup={onLookup} /><span className="readage-caption">{values[text(member.pos)] ?? text(member.pos)}</span></div>
        <Prose value={member.zh} className="readage-translation" onLookup={onLookup} /><BilingualExample item={member} onLookup={onLookup} />
        <Remaining item={member} used={['word', 'pos', 'zh', 'exampleEn', 'exampleZh']} onLookup={onLookup} /></article>)}</div>
        <Prose value={word.familyNote} onLookup={onLookup} /></Module>}
      {present(word.etymology) && <Module title="词源与构词" description="理解词根，建立记忆联系"><Etymology value={word.etymology} onLookup={onLookup} /></Module>}
      {(relations.length > 0 || present(word.relationNote)) && <Module title="形近与易混词" description={`${relations.length} 个相关词`}><div className="readage-flow">{relations.map((relation, i) => <Comparison key={i} item={relation} onLookup={onLookup} />)}</div>
        <Prose value={word.relationNote} onLookup={onLookup} /></Module>}
      {comparisons.length > 0 && <Module title="近义词与反义词辨析" description="含义 · 搭配 · 替换">{comparisons.map(sense => <section className="readage-comparison-group" key={sense.id}>
        <h5 className="readage-group-title">{sense.titleZh}</h5><div className="readage-flow">{items(sense.synonyms).map((item, i) => <Comparison key={`syn-${i}`} item={item} onLookup={onLookup} />)}</div>
        {items(sense.antonyms).length > 0 && <h6>反义与语义对照</h6>}<div className="readage-flow">{items(sense.antonyms).map((item, i) => <Comparison key={`ant-${i}`} item={item} onLookup={onLookup} />)}</div></section>)}
        </Module>}
      {(present(word.sources) || present(word.sourceNote)) && <Module title="参考来源" description={`${items(word.sources).length} 个来源`}>{items(word.sources).map((source, i) => <article className="readage-item" key={i}>
        <strong>{text(source.name)}</strong><Prose value={source.dataType} className="readage-translation" onLookup={onLookup} />
        {text(source.updatedAt) && <p className="readage-caption">更新于 {text(source.updatedAt)}</p>}
        {/^https?:\/\//i.test(text(source.url)) && <a className="readage-source-link" href={text(source.url)} target="_blank" rel="noreferrer">打开来源 ↗</a>}
        {text(source.license) && <Note title="授权说明"><Prose value={source.license} onLookup={onLookup} /></Note>}
        <Remaining item={source} used={['name', 'dataType', 'updatedAt', 'url', 'license']} onLookup={onLookup} /></article>)}
        <Prose value={word.sourceNote} className="readage-caption" onLookup={onLookup} /></Module>}
      {present(word.appendix) && <Module title="补充内容"><ExtraContent value={word.appendix} onLookup={onLookup} /></Module>}
    </section>
    <section className="readage-panel" role="tabpanel" tabIndex={0} id={`${entryId}-practice`} aria-labelledby={`${entryId}-tab-practice`} hidden={activeTab !== 'practice'}>
      <ReadAgeQuiz questions={items(word.quiz)} contexts={contexts} onLookup={onLookup} />
    </section>
  </div>;
}
