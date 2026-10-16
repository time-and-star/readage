import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import React from 'react';

// Exercise the real search handler without a browser, retaining hook state between renders.
const values: unknown[] = [];
let hook = 0;
let finishExposure!: () => void;
const exposure = new Promise<void>(resolve => { finishExposure = resolve; });
const calls: string[] = [];
const card = { wordOrPhrase: 'run', definition: 'move quickly', source: 'dictionary',
  learningTermRef: { language: 'en', kind: 'word', stableId: 'run' } };
const panel = () => null;
const harness = {
  React,
  useState(initial: unknown) {
    const index = hook++;
    if (!(index in values)) values[index] = initial;
    return [values[index], (value: unknown) => { values[index] = value; }];
  },
  useRef(initial: unknown) {
    const index = hook++;
    if (!(index in values)) values[index] = { current: initial };
    return values[index];
  },
  panel,
  fetchWordCard: async (_request: unknown, _options?: { signal: AbortSignal }) => card,
  resolveDictionaryLearningWordId: async () => 'run',
  lookupNeutral: async (request: unknown) => ({ request, status: 'not_found', sources: [] }),
  recordExposure: async () => { calls.push('exposure'); await exposure; },
  recordClick: async () => { calls.push('click'); },
};
const globalHarness = '__wordSearchPerformanceHarness';
Reflect.set(globalThis, globalHarness, harness);
const directory = fs.mkdtempSync(path.resolve('tmp/word-search-performance-'));
const output = path.join(directory, 'WordSearchModule.mjs');
await build({ entryPoints: ['src/components/WordSearchModule.tsx'], outfile: output,
  absWorkingDir: process.cwd(), platform: 'node', format: 'esm', bundle: true, packages: 'external',
  plugins: [{ name: 'search-handler-dependencies', setup(builder) {
    builder.onResolve({ filter: /^(react|\.\.\/lib\/(dictionaryClient|wordCard|memoryV2\/hooks|speech\/useSpeech)|\.\/WordCardPanel|\.\/SpeechControls)$/ },
      args => ({ path: args.path, namespace: 'word-search-harness' }));
    builder.onLoad({ filter: /.*/, namespace: 'word-search-harness' }, args => {
      const prefix = `const h = globalThis.${globalHarness};`;
      const source: Record<string, string> = {
        react: 'export default h.React; export const useState = h.useState, useRef = h.useRef, useEffect = () => {}, lazy = h.React.lazy, Suspense = h.React.Suspense;',
        '../lib/dictionaryClient': 'export const resolveDictionaryLearningWordId = h.resolveDictionaryLearningWordId; export const createDictionaryClient = () => ({ lookup: (...args) => h.lookupNeutral(...args) });',
        '../lib/wordCard': 'export const createWordCardRequest = text => ({ selectedText: text, contextSentence: "" }), fetchWordCard = (...args) => h.fetchWordCard(...args);',
        '../lib/memoryV2/hooks': 'export const useMemorySystem = () => h;',
        '../lib/speech/useSpeech': 'export const useSpeech = () => ({ preferences: {}, state: {}, stop() {}, speak() {}, prepare() {} });',
        './WordCardPanel': 'export const WordCardPanel = h.panel;',
        './SpeechControls': 'export const SpeechFeedback = () => null;',
      };
      return { contents: prefix + source[args.path] };
    });
  } }] });
const { WordSearchModule } = await import(pathToFileURL(output).href);
test.after(() => {
  finishExposure();
  Reflect.deleteProperty(globalThis, globalHarness);
  fs.unlinkSync(output);
  fs.rmdirSync(directory);
});
function render(): React.ReactElement<{ children: React.ReactElement[] }> {
  hook = 0;
  return WordSearchModule();
}

test('search displays a completed dictionary card before a slow learning-record write finishes', async () => {
  (render().props.children[0].props as { onClick(): void }).onClick();
  const dialog = render().props.children[1];
  const form = (dialog.props as { children: React.ReactElement }).children;
  const bar = (form.props as { children: React.ReactElement[] }).children[1];
  const input = (bar.props as { children: React.ReactElement[] }).children[2];
  (input.props as { onChange(event: unknown): void }).onChange({ target: { value: 'running' } });
  const updatedForm = (render().props.children[1].props as { children: React.ReactElement }).children;
  let completed = false;
  const searching = (updatedForm.props as { onSubmit(event: unknown): Promise<void> })
    .onSubmit({ preventDefault() {} }).then(() => { completed = true; });
  await new Promise(resolve => setImmediate(resolve));

  const suspense = render().props.children.find(element => element?.type === React.Suspense)!;
  const result = (suspense.props as { children: React.ReactElement }).children;
  assert.equal((result.props as { open: boolean }).open, true);
  assert.equal((result.props as { loading: boolean }).loading, false);
  assert.equal((result.props as { result: unknown }).result, card);
  assert.equal(completed, false, 'learning persistence is still pending');
  assert.deepEqual(calls, ['exposure']);

  finishExposure();
  await searching;
  assert.deepEqual(calls, ['exposure', 'click'], 'both learning events are still saved');
});

test('the first search click opens the focused input and closing a loading card cancels its lookup', async () => {
  values.length = 0;
  let finishLookup!: (value: typeof card) => void;
  let signal: AbortSignal | undefined;
  harness.fetchWordCard = async (_request, options) => {
    signal = options?.signal;
    return new Promise(resolve => { finishLookup = resolve; });
  };
  const closed = render();
  assert.equal(closed.props.children.some(element => element?.type === React.Suspense), false,
    'the unopened search does not render its heavy card module');
  (closed.props.children[0].props as { onClick(): void }).onClick();
  const form = (render().props.children[1].props as { children: React.ReactElement }).children;
  const bar = (form.props as { children: React.ReactElement[] }).children[1];
  const input = (bar.props as { children: React.ReactElement[] }).children[2];
  assert.equal((input.props as { autoFocus: boolean }).autoFocus, true);
  (input.props as { onChange(event: unknown): void }).onChange({ target: { value: 'running' } });
  const readyForm = (render().props.children[1].props as { children: React.ReactElement }).children;
  const searching = (readyForm.props as { onSubmit(event: unknown): Promise<void> }).onSubmit({ preventDefault() {} });
  const suspense = render().props.children.find(element => element?.type === React.Suspense)!;
  const fallback = (suspense.props as { fallback: React.ReactElement }).fallback;
  (fallback.props as { onClose(): void }).onClose();
  assert.equal(signal?.aborted, true);
  finishLookup(card);
  await searching;
  assert.equal(render().props.children.some(element => element?.type === React.Suspense), false);
});

test('a failed learning save leaves the definition visible and retries the same occurrence once', async () => {
  values.length = 0; harness.fetchWordCard = async () => card;
  const occurrenceIds: string[] = []; let clicks = 0;
  harness.recordExposure = async (_word?: string, _article?: string, occurrenceId?: string) => { occurrenceIds.push(occurrenceId!); };
  harness.recordClick = async () => { if (++clicks === 1) throw new Error('Isolated write failure'); };
  (render().props.children[0].props as { onClick(): void }).onClick();
  let form = (render().props.children[1].props as { children: React.ReactElement }).children;
  const bar = (form.props as { children: React.ReactElement[] }).children[1];
  ((bar.props as { children: React.ReactElement[] }).children[2].props as { onChange(event: unknown): void }).onChange({ target: { value: 'running' } });
  form = (render().props.children[1].props as { children: React.ReactElement }).children;
  await (form.props as { onSubmit(event: unknown): Promise<void> }).onSubmit({ preventDefault() {} });
  const panelProps = () => (render().props.children.find(element => element?.type === React.Suspense)!.props as { children: React.ReactElement }).children.props as { result: unknown; recordStatus: string; onRetryRecord?: () => void };
  assert.equal(panelProps().result, card); assert.match(panelProps().recordStatus, /待保存/);
  panelProps().onRetryRecord!(); await new Promise(resolve => setImmediate(resolve));
  assert.match(panelProps().recordStatus, /已保存/); assert.equal(panelProps().onRetryRecord, undefined);
  assert.equal(clicks, 2); assert.equal(occurrenceIds.length, 2); assert.equal(occurrenceIds[0], occurrenceIds[1]);
});

test('French and Japanese searches use the selected language and never write English learning evidence', async () => {
  for (const language of ['fr', 'ja']) {
    values.length = 0; const requests: unknown[] = [];
    harness.lookupNeutral = async request => { requests.push(request); return { request, status: 'not_found', sources: [] }; };
    harness.recordExposure = async () => { throw new Error('Foreign lookup entered English memory'); };
    harness.fetchWordCard = async () => { throw new Error('Foreign lookup entered English dictionary'); };
    (render().props.children[0].props as { onClick(): void }).onClick();
    let form = (render().props.children[1].props as { children: React.ReactElement }).children;
    const label = (form.props as { children: React.ReactElement[] }).children[0];
    ((label.props as { children: React.ReactElement[] }).children[1].props as { onChange(event: unknown): void }).onChange({ target: { value: language } });
    form = (render().props.children[1].props as { children: React.ReactElement }).children;
    const bar = (form.props as { children: React.ReactElement[] }).children[1];
    ((bar.props as { children: React.ReactElement[] }).children[2].props as { onChange(event: unknown): void }).onChange({ target: { value: language === 'fr' ? 'chevaux' : '学校' } });
    form = (render().props.children[1].props as { children: React.ReactElement }).children;
    await (form.props as { onSubmit(event: unknown): Promise<void> }).onSubmit({ preventDefault() {} });
    assert.equal((requests[0] as { language: string }).language, language);
    const props = (render().props.children.find(element => element?.type === React.Suspense)!.props as { children: React.ReactElement }).children.props as { neutralResult: unknown; result: unknown; recordStatus: unknown; error: unknown };
    assert.ok(props.neutralResult); assert.equal(props.result, null); assert.equal(props.recordStatus, undefined); assert.equal(props.error, null);
  }
});
