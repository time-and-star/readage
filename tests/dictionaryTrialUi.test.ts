import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DictionaryEntry, SourceCatalog } from '../packages/dictionary/contracts';
import type { DictionarySettingsSnapshot } from '../src/lib/dictionarySettingsClient';

const temporaryDirectory = fs.mkdtempSync(path.resolve('tmp/dictionary-trial-ui-'));
const files: string[] = [];
async function loadScreen(name: string) {
  const bundle = buildSync({ entryPoints: [`src/components/${name}.tsx`], absWorkingDir: process.cwd(),
    platform: 'node', format: 'esm', bundle: true, write: false, packages: 'external', loader: { '.css': 'empty' },
    target: 'es2022', external: ['react', 'react-dom'] });
  const bundleFile = path.join(temporaryDirectory, `${name}.mjs`);
  files.push(bundleFile);
  fs.writeFileSync(bundleFile, bundle.outputFiles[0].text);
  return import(pathToFileURL(bundleFile).href);
}
const { DictionaryTrialScreen, TrialEntry } = await loadScreen('DictionaryTrialScreen');
const { DictionarySettingsScreen } = await loadScreen('DictionarySettingsScreen');
test.after(() => { for (const file of files) fs.unlinkSync(file); fs.rmdirSync(temporaryDirectory); });

test('Japanese trial exposes independently clickable words without requiring spaces, and French remains the default', () => {
  const japanese = renderToStaticMarkup(React.createElement(DictionaryTrialScreen, { language: 'ja', onBack() {}, onSettings() {} }));
  assert.match(japanese, /<h1>日语试读<\/h1>/);
  assert.match(japanese, /class="dictionary-trial__text" lang="ja"/);
  for (const word of ['学校', '図書館', '本']) assert.ok(japanese.includes(`data-trial-word="${word}"`));
  assert.match(japanese, /aria-label="查询日语单词"/);
  assert.doesNotMatch(japanese, /lang="fr"|法语/);
  const french = renderToStaticMarkup(React.createElement(DictionaryTrialScreen, { onBack() {}, onSettings() {} }));
  assert.match(french, /<h1>法语试读<\/h1>/);
  assert.match(french, /data-trial-word="chevaux"/);
  assert.match(french, /class="dictionary-trial__text" lang="fr"/);
});

test('Japanese results retain the reading and Chinese definition and mark inflected terms with the entry language', () => {
  const entry: DictionaryEntry = {
    dictionaryId: 'japanese-chinese', entryId: '食べる', language: 'ja', headword: '食べる', contentVersion: 'test:1',
    schemaVersion: 'dictionary-entry.v1', provenance: [{ kind: 'morphology', label: '过去礼貌形' }],
    readings: [{ text: 'たべる', language: 'ja', notation: 'hiragana' }],
    content: { kind: 'structured', senses: [{ id: 'eat', partOfSpeech: 'verb', definitions: [{ language: 'zh', text: '吃；食用' }],
      translations: [], examples: [] }] },
  };
  const html = renderToStaticMarkup(React.createElement(TrialEntry, { entry, query: '食べました', inflection: true }));
  assert.match(html, /<h4 lang="ja">食べる<\/h4>/);
  assert.match(html, /<span lang="ja">食べました<\/span> → <span lang="ja">食べる<\/span>/);
  assert.match(html, /たべる/);
  assert.match(html, /<p lang="zh">吃；食用/);
  assert.doesNotMatch(html, /lang="fr"/);
});

test('dictionary settings offers the matching Japanese and French trial links for installed sources', () => {
  const catalog: SourceCatalog = { protocolVersion: 'dictionary-api.v1', catalogVersion: 'test:1', defaultSource: 'ja-zh',
    sources: ['ja', 'fr', 'en'].map((language, priority) => ({ id: `${language}-zh`, name: `${language} dictionary`, languages: [language],
      definitionLanguages: ['zh'], contentVersion: 'test:1', schemaVersion: 'dictionary-entry.v1', adapterVersion: 'test:1',
      capabilities: { lookup: true, details: true, resources: 'unsupported', originalContent: 'unsupported' },
      provenance: [], enabled: true, available: true, priority })) };
  const sourceIds = catalog.sources.map(source => source.id);
  const snapshot: DictionarySettingsSnapshot = { catalog,
    settings: { version: 'dictionary-settings.v1', revision: 'test:1', enabledSources: sourceIds, sourceOrder: sourceIds, defaultSource: 'ja-zh' } };
  const html = renderToStaticMarkup(React.createElement(DictionarySettingsScreen, { initialSnapshot: snapshot, onBack() {}, onTryFrench() {}, onTryJapanese() {} }));
  const cards = html.match(/<li[^>]*data-dictionary-id="[^"]+"[\s\S]*?<\/li>/g) ?? [];
  assert.equal(cards.length, 3);
  assert.match(cards[0], /日语试读 ↗/);
  assert.doesNotMatch(cards[0], /法语试读/);
  assert.match(cards[1], /法语试读 ↗/);
  assert.doesNotMatch(cards[1], /日语试读/);
  assert.doesNotMatch(cards[2], /试读 ↗/);
});
