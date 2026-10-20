import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { downloadLibraryFile, requestNativeLibrary, type LibraryDownloadProgress } from '../src/lib/contentLibrary';
import type { LibraryItem } from '../src/lib/contentLibraryProtocol';
import type { NativeFilesPlugin } from '../src/lib/platform/nativeFiles';
import { createLibraryRouter } from '../server/libraryRoutes';
import { createOfflineApiBoundary, isOfflineApiAllowed } from '../server/offline';

const bytes = new TextEncoder().encode('a complete isolated book');
const item: LibraryItem = { id: 'book:test', kind: 'book', title: 'Test', language: 'en', filename: 'test.epub',
  sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, updatedAt: '2026-10-19T00:00:00Z', downloadPath: '' };

test('browser download reports actual response bytes and still succeeds when proxy progress is unavailable', async t => {
  const progress: LibraryDownloadProgress[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url.endsWith('/progress')) return Response.json({}, { status: 404 });
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes.slice(0, 5)); controller.enqueue(bytes.slice(5)); controller.close(); } }));
  });
  const result = await downloadLibraryFile('https://library.example', item, new AbortController().signal, value => progress.push(value));
  assert.equal(await result.file.text(), new TextDecoder().decode(bytes));
  assert.deepEqual(progress.map(value => [value.phase, value.receivedBytes]), [['connecting', 0], ['downloading', 5], ['downloading', bytes.length], ['downloaded', bytes.length]]);
  assert.ok(progress.every(value => value.totalBytes === item.bytes));
});

test('cancelling a streamed browser download cancels the reader and never reports completion', async t => {
  const controller = new AbortController(), reason = new Error('Cancel this task'); let cancelled = false;
  const progress: LibraryDownloadProgress[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => url.endsWith('/progress') ? Response.json({}, { status: 404 })
    : new Response(new ReadableStream({ start(stream) { stream.enqueue(bytes.slice(0, 5)); }, cancel() { cancelled = true; } })));
  await assert.rejects(downloadLibraryFile('https://library.example', item, controller.signal, value => {
    progress.push(value); if (value.phase === 'downloading') controller.abort(reason);
  }), error => error === reason);
  assert.ok(cancelled); assert.ok(!progress.some(value => value.phase === 'downloaded'));
});

type NativePlugin = Pick<NativeFilesPlugin, 'remoteLibrary' | 'cancelDocument' | 'addListener'>;
test('native progress belongs to the exact request and valid byte bounds; listener is removed on completion', async () => {
  let notify!: Parameters<NativePlugin['addListener']>[1], removed = 0;
  const progress: LibraryDownloadProgress[] = [];
  const plugin: NativePlugin = {
    async addListener(_name, listener) { notify = listener; return { async remove() { removed++; } }; },
    async cancelDocument() { return { cancelled: true }; },
    async remoteLibrary(request) {
      notify({ requestId: 'another-task', phase: 'downloading', receivedBytes: 3, totalBytes: item.bytes });
      notify({ requestId: request.requestId, phase: 'downloading', receivedBytes: item.bytes + 1, totalBytes: item.bytes });
      notify({ requestId: request.requestId, phase: 'downloading', receivedBytes: 7, totalBytes: item.bytes });
      notify({ requestId: request.requestId, phase: 'verifying', receivedBytes: item.bytes, totalBytes: item.bytes });
      return { handle: item.sha256 };
    },
  };
  await requestNativeLibrary('file', 'https://library.example', item, new AbortController().signal, value => progress.push(value), plugin);
  assert.deepEqual(progress.map(value => [value.phase, value.receivedBytes]), [['downloading', 7], ['verifying', item.bytes]]);
  assert.equal(removed, 1);
});

test('native cancellation rejects promptly while registration is pending and removes a late listener', async () => {
  const controller = new AbortController(), reason = new Error('Cancel while listening'); let removed = 0, started = 0, cancelled = 0;
  let register!: (value: { remove(): Promise<void> }) => void;
  const plugin: NativePlugin = {
    addListener() { return new Promise(resolve => { register = resolve; }); },
    async cancelDocument() { cancelled++; return { cancelled: true }; },
    async remoteLibrary() { started++; return {}; },
  };
  const pending = requestNativeLibrary('file', 'https://library.example', item, controller.signal, () => {}, plugin);
  controller.abort(reason); await assert.rejects(pending, error => error === reason);
  register({ async remove() { removed++; } }); await Promise.resolve();
  assert.equal(removed, 1); assert.equal(started, 0); assert.equal(cancelled, 1);
});

for (const failure of ['reject', 'throw']) test(`native download continues when optional progress registration fails with ${failure}`, async () => {
  let started = 0;
  const result = { handle: item.sha256, sha256: item.sha256, bytes: item.bytes, name: item.filename };
  const plugin: NativePlugin = {
    addListener() { if (failure === 'throw') throw new Error('Progress unavailable'); return Promise.reject(new Error('Progress unavailable')); },
    async cancelDocument() { return { cancelled: true }; },
    async remoteLibrary() { started++; return result; },
  };
  assert.deepEqual(await requestNativeLibrary('file', 'https://library.example', item, new AbortController().signal, () => {}, plugin), result);
  assert.equal(started, 1);
});

test('a failed optional progress registration never swallows cancellation or starts the native download afterwards', async () => {
  const controller = new AbortController(), reason = new Error('Cancel this download'); let started = 0;
  const plugin: NativePlugin = {
    addListener() { controller.abort(reason); throw new Error('Progress unavailable'); },
    async cancelDocument() { return { cancelled: true }; },
    async remoteLibrary() { started++; return {}; },
  };
  await assert.rejects(requestNativeLibrary('file', 'https://library.example', item, controller.signal, () => {}, plugin), error => error === reason);
  assert.equal(started, 0);
});

async function serve(t, handler) {
  const server = http.createServer(handler); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
  return `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
}

test('proxy progress exposes actual upstream bytes by private task ID while preserving digest verification and expiry', async t => {
  let stream!: ReadableStreamDefaultController<Uint8Array>, started!: () => void;
  const upstreamStarted = new Promise<void>(resolve => { started = resolve; });
  let now = 1_000_000; t.mock.method(Date, 'now', () => now);
  assert.equal(isOfflineApiAllowed('/api/library/progress', 'POST'), true);
  for (const method of ['GET', 'DELETE']) assert.equal(isOfflineApiAllowed('/api/library/progress', method), false);
  const app = express(); app.use(express.json()); app.use(createOfflineApiBoundary()); app.use('/api/library', createLibraryRouter((async () => {
    started(); return new Response(new ReadableStream({ start(value) { stream = value; } }));
  }) as typeof fetch));
  const origin = await serve(t, app), requestId = randomUUID();
  const post = (operation: string, body: object) => fetch(origin + '/api/library/' + operation, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const pending = post('file', { serverUrl: 'https://library.example', sha256: item.sha256, bytes: item.bytes, requestId });
  await upstreamStarted; stream.enqueue(bytes.slice(0, 7));
  assert.deepEqual(await (await post('progress', { requestId })).json(), { phase: 'downloading', receivedBytes: 7, totalBytes: item.bytes });
  assert.equal((await post('progress', { requestId: randomUUID() })).status, 404);
  stream.enqueue(bytes.slice(7)); stream.close(); const response = await pending;
  assert.equal(response.status, 200); assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  assert.equal((await (await post('progress', { requestId })).json()).phase, 'downloaded');
  now += 10_001; assert.equal((await post('progress', { requestId })).status, 404);
});
