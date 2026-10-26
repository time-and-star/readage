import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { buildSync } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Parser } from 'htmlparser2';
import type { GrammarExplanation, DictionarySourceView } from '../src/types';
import type { ReadAgeWord } from '../packages/dictionary/readage';

const temporaryDirectory = fs.mkdtempSync(path.resolve('tmp/flashcard-study-content-ui-'));
const bundleFile = path.join(temporaryDirectory, 'content.mjs');
const bundle = buildSync({ entryPoints: ['src/components/FlashcardStudyContent.tsx'], absWorkingDir: process.cwd(),
  platform: 'node', format: 'esm', bundle: true, write: false, packages: 'external', loader: { '.css': 'empty' }, target: 'es2022' });
fs.writeFileSync(bundleFile, bundle.outputFiles[0].text);
const { FlashcardStudyContent } = await import(pathToFileURL(bundleFile).href);
test.after(() => { fs.unlinkSync(bundleFile); fs.rmdirSync(temporaryDirectory); });

function parse(html: string) {
  const stack: Array<{ tag: string; more: boolean }> = [];
  const elements: Array<{ tag: string; attributes: Record<string, string>; insideMore: boolean }> = [];
  let allText = '';
  const parser = new Parser({
    onopentag(tag, attributes) {
      elements.push({ tag, attributes, insideMore: stack.some(item => item.more) });
      stack.push({ tag, more: attributes.class?.split(' ').includes('flashcard-study-more') ?? false });
    },
    onclosetag() { stack.pop(); },
    ontext(value) { allText += value; },
  });
  parser.end(html);
  return { elements, allText };
}

function richCard(): GrammarExplanation {
  const authored: ReadAgeWord = { id: 'adapt', lemma: 'adapt', language: 'en', tier: 'core',
    coreMeaning: { en: 'change to suit new conditions', zh: '适应；调整；改编' }, pronunciations: [], forms: [], family: [],
    senses: Array.from({ length: 4 }, (_, index) => ({ id: `sense:${index}`, partOfSpeech: 'verb', titleZh: `真实义项${index + 1}`,
      definitionEn: `Real definition ${index + 1}`, definitionZhTranslation: `真实释义${index + 1}`, explanationZh: '',
      examples: [{ id: `example:${index}`, english: `We adapt in example ${index + 1}.`, chinese: `真实例句译文${index + 1}` }],
      collocations: [{ phrase: `adapt phrase ${index + 1}`, meaningZh: `真实搭配译文${index + 1}` }],
      synonyms: index === 0 ? Array.from({ length: 4 }, (_, i) => ({ word: `synonym${i + 1}`, zh: `真实近义词${i + 1}` })) : [],
      antonyms: index === 0 ? Array.from({ length: 4 }, (_, i) => ({ word: `antonym${i + 1}`, zh: `真实反义词${i + 1}`,
        note: `语境限制${i + 1}` })) : [],
    })) };
  const source: DictionarySourceView = { dictionaryRef: { protocolVersion: 'dictionary-api.v1', catalogVersion: 'test',
    dictionaryId: 'test', entryId: 'adapt', contentVersion: 'test', fieldSources: {} }, readageContent: authored,
    record: { schemaVersion: 'dictionary.v2', query: 'adapt', lemma: 'adapt', phonetic: '', phonetics: [], wordForms: [],
      wordFamily: [], cefrLevel: null, tags: [], phrases: [], supplementaryChinese: [], partOfSpeechGroups: [],
      edit: { source: [], revisionVersion: 'test', reviewStatus: 'reviewed' } } };
  return { wordOrPhrase: 'adapt', type: 'verb', definition: '', grammarRules: [], exampleSentences: [],
    dictionarySources: [source] };
}

test('study card previews stay short while native disclosures retain all paired content and context', () => {
  const html = renderToStaticMarkup(React.createElement(FlashcardStudyContent, { card: richCard(), word: 'adapt',
    contextTexts: ['Article context one with adapt.', 'Article context two with adapt.'] }));
  const { elements, allText } = parse(html);
  const byClass = (name: string) => elements.filter(item => item.attributes.class?.split(' ').includes(name));
  assert.equal(byClass('flashcard-study-meaning').filter(item => !item.insideMore).length, 1);
  assert.equal(byClass('flashcard-study-example').filter(item => !item.insideMore).length, 1);
  assert.equal(elements.filter(item => item.tag === 'dt' && !item.insideMore).length, 3);
  assert.equal(byClass('reading-context-excerpt').filter(item => !item.insideMore).length, 1);
  assert.equal(byClass('flashcard-study-relation__line').filter(item => !item.insideMore).length, 6);
  const disclosures = byClass('flashcard-study-more');
  assert.equal(disclosures.length, 6);
  assert.ok(disclosures.every(item => item.tag === 'details' && !Object.hasOwn(item.attributes, 'open')));
  for (const label of ['更多释义', '更多例句', '更多搭配', '更多原句', '更多同义词', '更多反义词']) assert.ok(allText.includes(label));
  for (let index = 1; index <= 4; index++) {
    for (const value of [`Real definition ${index}`, `真实释义${index}`, `We adapt in example ${index}.`, `真实例句译文${index}`,
      `adapt phrase ${index}`, `真实搭配译文${index}`, `synonym${index}`, `真实近义词${index}`,
      `antonym${index}`, `真实反义词${index}`, `语境限制${index}`]) assert.ok(allText.includes(value), value);
  }
  assert.ok(allText.includes('Article context two with adapt.'));
  assert.ok(elements.some(item => item.tag === 'mark'));
});

test('short or missing data does not create empty sections or disclosure controls', () => {
  const empty = renderToStaticMarkup(React.createElement(FlashcardStudyContent, { card: null, word: 'adapt' }));
  assert.equal(empty, '');
  const html = renderToStaticMarkup(React.createElement(FlashcardStudyContent, { word: 'adapt',
    card: { wordOrPhrase: 'adapt', type: 'verb', definition: 'change to suit', definitionChinese: '调整以适应',
      grammarRules: [], exampleSentences: [] } }));
  const { elements, allText } = parse(html);
  assert.deepEqual(elements.filter(item => item.tag === 'section').map(item => item.attributes['aria-label']), ['释义']);
  assert.ok(!elements.some(item => item.tag === 'details'));
  assert.ok(allText.includes('调整以适应'));
});
