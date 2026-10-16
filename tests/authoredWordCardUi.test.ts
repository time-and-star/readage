import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Parser } from 'htmlparser2';
import { createDictionaryRuntime } from '../server/dictionary/runtime';
import { toEnglishDictionaryEntry } from '../server/dictionary/compatibility';
import { getCompactWordCard } from '../src/lib/compactWordCard';
import { toDictionarySourceWordCard } from '../src/lib/dictionaryClient';
import { toDictionaryWordCard } from '../src/lib/dictionaryClient';
import type { GrammarExplanation } from '../src/types';

const temporaryDirectory = fs.mkdtempSync(path.resolve('tmp/authored-word-card-ui-'));
await build({ entryPoints: ['src/components/ReadingLookupCard.tsx', 'src/components/WordCardPanel.tsx', 'src/components/DictionarySourceSections.tsx'],
  absWorkingDir: process.cwd(), outdir: temporaryDirectory, platform: 'node', format: 'esm', bundle: true,
  packages: 'external', loader: { '.css': 'empty' }, target: 'es2022', plugins: [{
    name: 'inline-portals-for-static-render',
    setup(build) {
      build.onResolve({ filter: /^react-dom$/ }, () => ({ path: 'portal', namespace: 'inline-portal' }));
      build.onLoad({ filter: /.*/, namespace: 'inline-portal' }, () => ({ contents: 'export const createPortal = children => children;' }));
    },
  }] });
const { ReadingLookupCard } = await import(pathToFileURL(path.join(temporaryDirectory, 'ReadingLookupCard.js')).href);
const { WordCardPanel } = await import(pathToFileURL(path.join(temporaryDirectory, 'WordCardPanel.js')).href);
const { DictionarySourceSections } = await import(pathToFileURL(path.join(temporaryDirectory, 'DictionarySourceSections.js')).href);
const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
Object.defineProperty(globalThis, 'document', { configurable: true, value: { body: {} } });
test.after(() => {
  if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor);
  else Reflect.deleteProperty(globalThis, 'document');
  for (const name of ['ReadingLookupCard.js', 'WordCardPanel.js', 'DictionarySourceSections.js']) fs.unlinkSync(path.join(temporaryDirectory, name));
  fs.rmdirSync(temporaryDirectory);
});

const runtime = createDictionaryRuntime();
async function lookup(text: string) {
  return toDictionaryWordCard(toEnglishDictionaryEntry(await runtime.service.lookup({ text, language: 'en' }))!);
}
function render(component: typeof ReadingLookupCard, result: GrammarExplanation | null, extra = {}) {
  const html = renderToStaticMarkup(React.createElement(component, { open: true, loading: false, result,
    selectedText: 'adapt', anchor: { left: 100, top: 100, bottom: 120 }, error: null,
    onClose() {}, onSpeak() {}, onLookupRelated() {}, onRetry() {}, ...extra }));
  const elements: Array<{ tag: string; attributes: Record<string, string> }> = [];
  let readableText = '';
  const parser = new Parser({ onopentag(tag, attributes) { elements.push({ tag, attributes }); }, ontext(value) { readableText += value; } });
  parser.end(html);
  return { html, elements, readableText };
}

test('reading lookup keeps the small card and immediately shows the authored Chinese summary', async () => {
  const result = await lookup('adapt');
  const { html, elements, readableText } = render(ReadingLookupCard, result, { recordStatus: '学习记录已保存' });
  assert.match(html, /class="reading-lookup-card"/);
  assert.doesNotMatch(html, /class="word-card-backdrop"|aria-modal="true"/);
  assert.equal(elements.filter(item => item.attributes.role === 'tab').length, 0);
  const coreMeaning = result.dictionarySources![0].readageContent!.coreMeaning;
  assert.ok(readableText.includes(coreMeaning.zh));
  assert.ok(readableText.includes(coreMeaning.en));
  assert.match(html, /ReadAge 自编词典/);
  assert.match(html, /展开完整词典释义/);
  assert.match(html, /已保存/);
  assert.match(html, /class="lookup-flashcard-control"/);
  assert.match(html, /不收录此词/);
});

test('the small card respects the first matched source instead of overriding it with authored content', async () => {
  const value = await lookup('poem');
  const authoredSource = value.dictionarySources!.find(source => source.readageContent)!;
  const authored = { ...authoredSource, dictionaryRef: { ...authoredSource.dictionaryRef, dictionaryName: 'ReadAge 自编词典' } };
  const fallback = value.dictionarySources!.find(source => !source.readageContent)!;
  const result = { ...value, dictionarySources: [fallback, authored] };
  const { html } = render(ReadingLookupCard, result, { selectedText: 'poem' });
  assert.match(html, /class="reading-lookup-card"/);
  assert.ok(html.includes(getCompactWordCard(toDictionarySourceWordCard(fallback), 'poem').meaningZh!));
  assert.match(html, /reading-lookup-card__source-name">ECDICT 内置词典/);
  assert.equal(authored.dictionaryRef.dictionaryName, 'ReadAge 自编词典', 'the stored source name remains intact');
});

test('search cards preserve the selected first source and show authored content as an additional dictionary', async () => {
  const value = await lookup('adapt');
  const authored = value.dictionarySources!.find(source => source.readageContent)!;
  const fallback = value.dictionarySources!.find(source => !source.readageContent)!;
  const result = { ...value, wordOrPhrase: 'fallback-headword', dictionaryRef: fallback.dictionaryRef,
    dictionarySources: [fallback, authored] };
  const { html } = render(WordCardPanel, result);
  assert.match(html, /aria-label="各词典释义"/);
  assert.match(html, /class="word-card-hero__word">fallback-headword<\/h3>/);
  assert.ok(html.indexOf('aria-label="ECDICT 内置词典"') < html.indexOf('aria-label="ReadAge 自编词典"'));
  assert.equal(result.learningTermRef?.stableId, value.learningTermRef?.stableId);
  assert.match(html, /不收录此词/);
});

test('flashcard details put the authored dictionary first and expand only that source', async () => {
  const value = await lookup('horse');
  const authored = value.dictionarySources!.find(source => source.readageContent)!;
  const fallback = value.dictionarySources!.find(source => !source.readageContent)!;
  for (const sources of [[fallback, authored], [fallback]]) {
    const html = renderToStaticMarkup(React.createElement(DictionarySourceSections, {
      sources, initiallyExpanded: false, preferAuthored: true,
    }));
    const dictionaries: Array<Record<string, string>> = [];
    const parser = new Parser({ onopentag(tag, attributes) {
      if (tag === 'details' && attributes.class === 'word-card-dictionary-source') dictionaries.push(attributes);
    } });
    parser.end(html);
    assert.equal(dictionaries.length, sources.length);
    if (sources.includes(authored)) {
      assert.equal(dictionaries[0]['aria-label'], 'ReadAge 自编词典');
      assert.ok('open' in dictionaries[0]);
      assert.ok(!('open' in dictionaries[1]));
    } else {
      assert.ok(!('open' in dictionaries[0]));
    }
    assert.equal(sources[0], fallback, 'presentation leaves the original source order intact');
  }
});

test('authored child cards retain return navigation and failed learning-record retry', async () => {
  const { html } = render(ReadingLookupCard, await lookup('adapt'), { returnTo: 'poem',
    ancestorCardIds: ['parent-card'], recordStatus: '释义已显示，学习记录待保存', onRetryRecord() {} });
  assert.match(html, /返回 poem/);
  assert.match(html, /data-word-card-scopes="parent-card /);
  assert.match(html, /释义已显示，学习记录待保存/);
  assert.match(html, /重试保存/);
});

test('missing authored content, loading and failures retain the compact reading card', async () => {
  const value = await lookup('adapt');
  const result = { ...value, dictionarySources: value.dictionarySources!.filter(source => !source.readageContent) };
  for (const [card, extra] of [[result, {}], [null, { loading: true }], [null, { error: '查询失败' }]] as const) {
    const { html } = render(ReadingLookupCard, card, extra);
    assert.match(html, /class="reading-lookup-card"/);
    assert.doesNotMatch(html, /aria-label="ReadAge 完整词条"/);
  }
});
