import assert from 'node:assert/strict';
import fs from 'node:fs';
import { gunzipSync } from 'node:zlib';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Parser } from 'htmlparser2';
import type { ReadAgePackIndex, ReadAgeWord } from '../packages/dictionary/readage';
import { ReadAgeEntrySections } from '../src/components/ReadAgeEntrySections';

const index = JSON.parse(fs.readFileSync('data/dictionary/readage/index.json', 'utf8')) as ReadAgePackIndex;
function authoredWord(lemma: string): ReadAgeWord {
  const entry = index.entries.find(item => item.headword === lemma)!;
  const file = fs.openSync('data/dictionary/readage/entries.pack', 'r');
  try {
    const bytes = Buffer.alloc(entry.length);
    fs.readSync(file, bytes, 0, bytes.length, entry.offset);
    return JSON.parse(gunzipSync(bytes).toString('utf8'));
  } finally { fs.closeSync(file); }
}
function render(word: ReadAgeWord) {
  const html = renderToStaticMarkup(React.createElement(ReadAgeEntrySections, { word, onLookupRelated() {} }));
  const elements: Array<{ tag: string; attributes: Record<string, string> }> = [];
  const parser = new Parser({ onopentag(tag, attributes) { elements.push({ tag, attributes }); } });
  parser.end(html);
  return { html, elements };
}
function hasClass(element: { attributes: Record<string, string> }, name: string) {
  return element.attributes.class?.split(' ').includes(name);
}

test('ReadAge short collocations retain sense groups while examples keep their own reading row', () => {
  const horse = authoredWord('horse');
  const shortEntry = render(horse);
  const shortCollocations = shortEntry.elements.filter(item => hasClass(item, 'readage-collocation'));
  assert.equal(shortCollocations.length, 6);
  assert.ok(shortCollocations.every(item => !hasClass(item, 'readage-flow-wide')));
  assert.equal(shortEntry.elements.filter(item => hasClass(item, 'readage-collocation-group')).length, 4);
  const familyItems = shortEntry.elements.filter(item => hasClass(item, 'readage-item') && hasClass(item, 'readage-flow-wide'));
  assert.ok(familyItems.length >= horse.family.length);
  for (const member of horse.family) assert.ok(shortEntry.html.includes(member.exampleEn as string));

  const adapt = authoredWord('adapt');
  const detailedEntry = render(adapt);
  const detailedCollocations = detailedEntry.elements.filter(item => hasClass(item, 'readage-collocation'));
  assert.equal(detailedCollocations.length, 9);
  assert.ok(detailedCollocations.every(item => hasClass(item, 'readage-flow-wide')));
  for (const sense of adapt.senses) for (const collocation of sense.collocations) {
    assert.ok(detailedEntry.html.includes(collocation.phrase));
    assert.ok(detailedEntry.html.includes(collocation.exampleEn as string));
    assert.ok(detailedEntry.html.includes(collocation.exampleZh as string));
  }
});

test('long ReadAge entries show every sense, example and note without disclosure controls', () => {
  const word = authoredWord('adapt');
  assert.equal(word.senses.length, 4);
  word.senses[0].examples.push({ id: 'direct-example', english: 'This additional example is visible immediately.', chinese: '补充例句直接显示。' });
  const { html, elements } = render(word);
  const tabs = elements.filter(item => item.attributes.role === 'tab');
  const panels = elements.filter(item => item.attributes.role === 'tabpanel');
  assert.equal(tabs.length, 4);
  assert.equal(panels.length, 4);
  assert.equal(tabs.filter(item => item.attributes['aria-selected'] === 'true').length, 1);
  assert.equal(panels.filter(item => !Object.hasOwn(item.attributes, 'hidden')).length, 1);
  for (const tab of tabs) {
    const panel = panels.find(item => item.attributes.id === tab.attributes['aria-controls'])!;
    assert.equal(panel.attributes['aria-labelledby'], tab.attributes.id);
    assert.equal(Object.hasOwn(panel.attributes, 'hidden'), tab.attributes['aria-selected'] !== 'true');
  }
  assert.equal(elements.filter(item => item.attributes.class === 'readage-sense-heading').length, word.senses.length);
  assert.equal(elements.filter(item => item.tag === 'details' || item.tag === 'summary').length, 0);
  assert.doesNotMatch(html, /查看其余|收起其他义项|收起更多例句|再看 \d+ 个例句/);
  assert.ok(html.includes(word.senses[0].definitionEn));
  assert.ok(html.includes(word.senses[0].definitionZhTranslation));
  assert.ok(html.includes(word.senses[3].definitionEn));
  assert.ok(html.includes('This additional example is visible immediately.'));
  assert.ok(html.includes('补充例句直接显示。'));
  assert.match(html, /句子分析/);
  assert.doesNotMatch(html, /&lt;b&gt;/);
});

test('ReadAge practice presents one unanswered question with explicit checking and visible context', () => {
  const word = authoredWord('poem');
  const questions = word.quiz as Array<{ prompt: string; options: string[] }>;
  const { html, elements } = render(word);
  assert.ok(html.includes(questions[0].prompt));
  for (const question of questions.slice(1)) assert.ok(!html.includes(question.prompt));
  const radios = elements.filter(item => item.tag === 'input' && item.attributes.type === 'radio');
  assert.equal(radios.length, questions[0].options.length);
  assert.ok(radios.every(item => !Object.hasOwn(item.attributes, 'checked')));
  assert.match(html, /disabled="">核对答案/);
  assert.match(html, /题目语境/);
  assert.equal(elements.filter(item => item.tag === 'details' || item.tag === 'summary').length, 0);
  assert.doesNotMatch(html, /正确答案：|回答正确/);
});

test('empty authored modules do not add dead-end controls, and practice explains the empty state', () => {
  const word: ReadAgeWord = { ...authoredWord('poem'), forms: [], family: [], etymology: null, relations: [], confused: [], sources: [],
    sourceNote: '', quiz: [], usage: null, contexts: [], mistakes: [], note: '',
    senses: authoredWord('poem').senses.map(sense => ({ ...sense, collocations: [], synonyms: [], antonyms: [] })) };
  const { html } = render(word);
  for (const title of ['词形变化', '词汇家族', '词源与构词', '形近与易混词', '近义词与反义词辨析', '搭配与句型', '常见错误', '语境与长难句', '参考来源']) {
    assert.ok(!html.includes(`<strong>${title}</strong>`), title);
  }
  assert.match(html, /这个词条还没有练习题/);
  assert.doesNotMatch(html, /核对答案|0 个相关词|0 个搭配/);
});
