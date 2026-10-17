import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LookupResult } from '../packages/dictionary/contracts';
import { createImportedArticle } from '../src/lib/articleLanguage';

const temporaryDirectory = fs.mkdtempSync(path.resolve('tmp/shared-reading-ui-'));
buildSync({ entryPoints: ['src/components/ReadingScreen.tsx', 'src/components/NeutralDictionarySections.tsx'],
  absWorkingDir: process.cwd(), outdir: temporaryDirectory, platform: 'node', format: 'esm', bundle: true,
  packages: 'external', loader: { '.css': 'empty' }, target: 'es2022' });
const { ReadingScreen } = await import(pathToFileURL(path.join(temporaryDirectory, 'ReadingScreen.js')).href);
const { NeutralDictionarySections } = await import(pathToFileURL(path.join(temporaryDirectory, 'NeutralDictionarySections.js')).href);
test.after(() => {
  for (const name of ['ReadingScreen.js', 'NeutralDictionarySections.js']) fs.unlinkSync(path.join(temporaryDirectory, name));
  fs.rmdirSync(temporaryDirectory);
});

test('English, French and Japanese articles use the original reading layout and native lookup tokens', () => {
  for (const [language, text, word] of [['en', 'The horses eat apples.', 'horses'],
    ['fr', 'Les chevaux mangent près de l’école.', 'chevaux'], ['ja', '図書館で本を読みます。', '図書館']] as const) {
    const article = createImportedArticle(text, 'Shared reader', language);
    const html = renderToStaticMarkup(React.createElement(ReadingScreen, { article, onBack() {} }));
    assert.match(html, /class="reading-page /);
    assert.match(html, /class="app-page-header /);
    assert.match(html, /class="reading-article-header /);
    assert.ok(html.includes(`lang="${language}"`));
    assert.ok(html.includes(`>${word}</span>`), 'the selected surface word stays independently clickable');
    assert.match(html, /title="点击查词"/);
    assert.doesNotMatch(html, /dictionary-trial__layout|language-reading__paragraph|language-reading-query/);
    assert.doesNotMatch(html, /data-reading-language-controls="ja"|翻译本段|朗读本段/);
    assert.match(html, /aria-label="Options"/);
  }
});

const result: LookupResult = {
  protocolVersion: 'dictionary-api.v1', catalogVersion: 'test:1', request: { text: 'chevaux', language: 'fr' }, status: 'found',
  languageCapabilities: { normalization: 'supported', segmentation: 'supported', candidates: 'supported', morphology: 'unsupported' },
  sources: ['zh', 'en'].map(language => ({ dictionaryId: `fr-${language}`, dictionaryName: `French ${language}`, status: 'found',
    matches: [{ matchKind: 'inflection', entry: { dictionaryId: `fr-${language}`, entryId: `cheval-${language}`, language: 'fr',
      headword: 'cheval', contentVersion: 'test:1', schemaVersion: 'dictionary-entry.v1', provenance: [], readings: [],
      content: { kind: 'structured', senses: [{ id: 'horse', partOfSpeech: 'noun', definitions: [{ language, text: language === 'zh' ? '马' : 'horse' }],
        translations: [], examples: [] }] } } }] })),
};

test('the shared word-card sections preserve dictionary order and definition languages', () => {
  const html = renderToStaticMarkup(React.createElement(NeutralDictionarySections, { result, onLookupRelated() {} }));
  assert.ok(html.indexOf('French zh') < html.indexOf('French en'));
  assert.equal((html.match(/class="word-card-dictionary-source"/g) ?? []).length, 2);
  assert.match(html, /lang="fr"/);
  assert.match(html, /<p lang="zh">马<\/p>/);
  assert.match(html, /<p lang="en">horse<\/p>/);
  assert.match(html, /由 chevaux 还原/);
  assert.doesNotMatch(html, /word-memory|学习记录已保存/);
});

test('Japanese and French examples put only their number in the narrow grid column', () => {
  for (const language of ['ja', 'fr']) {
    const text = language === 'ja' ? '図書館で本を読みます。' : 'Je lis un livre.';
    const entry = { ...result.sources[0].matches[0].entry, language,
      content: { kind: 'structured' as const, senses: [{ id: 'read', definitions: [], translations: [], examples: [
        { id: 'one', text: { language, text }, translations: [{ language: 'zh', text: '我在读书。' }, { language: 'en', text: 'I read.' }] },
        { id: 'two', text: { language, text }, translations: [] },
      ] }] } };
    const html = renderToStaticMarkup(React.createElement(NeutralDictionarySections, {
      result: { ...result, request: { text: entry.headword, language }, sources: [{ ...result.sources[0], matches: [{ entry, matchKind: 'exact' }] }] }, onLookupRelated() {},
    }));
    assert.match(html, /<li><span class="word-card-example__index">1<\/span><div class="word-card-example__body">/);
    assert.match(html, /<li><span class="word-card-example__index">2<\/span><div class="word-card-example__body">/);
    assert.ok(html.includes(`<p lang="${language}">${text}</p><p lang="zh" class="word-card-sense__translation">我在读书。</p><p lang="en" class="word-card-sense__translation">I read.</p></div></li>`));
  }
});

test('a missing entry and a failed source remain distinct inside the original word-card layout', () => {
  const failure: LookupResult = { ...result, sources: [result.sources[0],
    { dictionaryId: 'offline', dictionaryName: 'Offline dictionary', status: 'unavailable', matches: [] },
    { dictionaryId: 'missing', dictionaryName: 'Missing dictionary', status: 'not_found', matches: [] }] };
  const html = renderToStaticMarkup(React.createElement(NeutralDictionarySections, { result: failure, onLookupRelated() {}, onRetry() {} }));
  assert.match(html, /马/);
  assert.match(html, /role="alert"/);
  assert.match(html, /此词典暂时无法读取/);
  assert.match(html, /重试词典/);
  assert.match(html, /未收录/);
});

test('original content from a non-English dictionary uses the existing inert HTML renderer', () => {
  const entry = { ...result.sources[0].matches[0].entry, content: { kind: 'original' as const, mediaType: 'text/html',
    content: '<p>école — 学校</p><script>alert(1)</script><img src="https://example.com/track">' } };
  const original = { ...result, sources: [{ ...result.sources[0], matches: [{ entry, matchKind: 'exact' as const }] }] };
  const html = renderToStaticMarkup(React.createElement(NeutralDictionarySections, { result: original, onLookupRelated() {} }));
  assert.match(html, /dictionary-original-content/);
  assert.match(html, /école/);
  assert.match(html, /学校/);
  assert.doesNotMatch(html, /<script|alert\(1\)|<img|example.com/);
});
