import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createKokoroHttpServer, encodePcmWave } from '../scripts/kokoro-service.mjs';

interface SpeechRequest { input: string; voice: string; speed: number }
interface FakeRuntime {
  ready: boolean;
  voices: Record<string, { name: string }>;
  synthesize(request: SpeechRequest, signal: AbortSignal): Promise<Buffer>;
}

const WAV = encodePcmWave(new Float32Array([0, 0.25, -0.25, 0]));
const VALID_REQUEST = { input: 'Hello.', response_format: 'wav' };

function fakeRuntime(synthesize?: FakeRuntime['synthesize']): FakeRuntime {
  return {
    ready: true,
    voices: { af_heart: { name: 'Heart' }, bf_emma: { name: 'Emma' } },
    synthesize: synthesize || (async () => WAV),
  };
}

async function withServer(
  runtime: FakeRuntime,
  run: (url: string, server: http.Server) => Promise<void>,
): Promise<void> {
  const server = createKokoroHttpServer(runtime);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    await run(`http://127.0.0.1:${address.port}`, server);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function speech(url: string, body: unknown = VALID_REQUEST, signal?: AbortSignal): Promise<Response> {
  return fetch(`${url}/v1/audio/speech`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
  });
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve: resolve! };
}

async function waitFor<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), 2_000);
  });
  try { return await Promise.race([promise, deadline]); } finally { clearTimeout(timeout!); }
}

test('PCM WAV encoding writes a playable mono header and clips signed 16-bit samples', () => {
  const samples = new Float32Array([-2, -1, -0.5, -0, 0, 0.5, 1, 2, Number.NaN]);
  const wav = encodePcmWave(samples);
  assert.equal(wav.length, 44 + samples.length * 2);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(4), wav.length - 8);
  assert.equal(wav.toString('ascii', 8, 16), 'WAVEfmt ');
  assert.equal(wav.readUInt32LE(16), 16);
  assert.equal(wav.readUInt16LE(20), 1, 'uncompressed PCM');
  assert.equal(wav.readUInt16LE(22), 1, 'one channel');
  assert.equal(wav.readUInt32LE(24), 24_000);
  assert.equal(wav.readUInt32LE(28), 48_000);
  assert.equal(wav.readUInt16LE(32), 2);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.toString('ascii', 36, 40), 'data');
  assert.equal(wav.readUInt32LE(40), samples.length * 2);
  assert.deepEqual(Array.from({ length: samples.length }, (_, index) => wav.readInt16LE(44 + index * 2)),
    [-32768, -32768, -16384, 0, 0, 16384, 32767, 32767, 0]);
  const customRate = encodePcmWave(new Float32Array([0]), 22_050);
  assert.equal(customRate.readUInt32LE(24), 22_050);
  assert.equal(customRate.readUInt32LE(28), 44_100);
});

test('local service exposes loading then ready health and bundled voices', async () => {
  let calls = 0;
  const runtime = fakeRuntime(async () => { calls += 1; return WAV; });
  runtime.ready = false;
  await withServer(runtime, async (url) => {
    const loading = await fetch(`${url}/health`);
    assert.equal(loading.status, 503);
    assert.deepEqual(await loading.json(), { ok: false, engine: 'kokoro-js', ready: false });
    const rejected = await speech(url);
    assert.equal(rejected.status, 503);
    assert.deepEqual(await rejected.json(), { error: 'The local model is loading.' });
    assert.equal(calls, 0);
    runtime.ready = true;
    const ready = await fetch(`${url}/health`);
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { ok: true, engine: 'kokoro-js', ready: true });
    assert.deepEqual(await (await fetch(`${url}/v1/audio/voices`)).json(), {
      voices: [{ id: 'af_heart', name: 'Heart' }, { id: 'bf_emma', name: 'Emma' }],
    });
    assert.equal((await speech(url)).status, 200);
    assert.equal(calls, 1);
  });
});

test('local speech normalizes defaults and forwards explicit voice and speed with WAV headers', async () => {
  const calls: SpeechRequest[] = [];
  await withServer(fakeRuntime(async (request, signal) => {
    assert.equal(signal.aborted, false);
    calls.push(request);
    return WAV;
  }), async (url) => {
    for (const body of [VALID_REQUEST, { input: '  British English.  ', voice: 'bf_emma', speed: 0.8, model: 'kokoro', response_format: 'wav' }]) {
      const response = await speech(url, body);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'audio/wav');
      assert.equal(response.headers.get('content-length'), String(WAV.length));
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), WAV);
    }
    assert.deepEqual(calls, [
      { input: 'Hello.', voice: 'af_heart', speed: 1 },
      { input: 'British English.', voice: 'bf_emma', speed: 0.8 },
    ]);
  });
});

test('local HTTP service rejects malformed text, voice, speed, model, format and request bodies before inference', async () => {
  let calls = 0;
  await withServer(fakeRuntime(async () => { calls += 1; return WAV; }), async (url) => {
    const invalid = [null, [], {}, { ...VALID_REQUEST, input: 1 }, { ...VALID_REQUEST, input: ' ' },
      { ...VALID_REQUEST, input: 'a'.repeat(2001) }, { ...VALID_REQUEST, response_format: 'mp3' },
      { ...VALID_REQUEST, model: 'another-model' }, { ...VALID_REQUEST, speed: 0.49 },
      { ...VALID_REQUEST, speed: 2.01 }, { ...VALID_REQUEST, speed: '1' },
      { ...VALID_REQUEST, voice: 'unknown' }, { ...VALID_REQUEST, voice: '__proto__' },
      { ...VALID_REQUEST, voice: ['af_heart'] }, { ...VALID_REQUEST, voice: 0 },
      { ...VALID_REQUEST, voice: null }, { ...VALID_REQUEST, voice: '' }];
    for (const body of invalid) {
      const response = await speech(url, body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.deepEqual(await response.json(), { error: 'Use a supported voice, WAV format, and 1–2000 characters.' });
    }
    for (const [contentType, body] of [['text/plain', 'Hello'], ['application/json', '{invalid JSON']]) {
      const response = await fetch(`${url}/v1/audio/speech`, { method: 'POST', headers: { 'Content-Type': contentType }, body });
      assert.equal(response.status, 400);
    }
    for (const [method, route] of [['GET', '/v1/audio/speech'], ['POST', '/wrong-route']]) {
      assert.equal((await fetch(`${url}${route}`, { method })).status, 404);
    }
    assert.equal(calls, 0);
    assert.equal((await speech(url, { input: 'a'.repeat(2000), voice: 'af_heart', response_format: 'wav', speed: 2 })).status, 200);
    assert.equal((await speech(url, { ...VALID_REQUEST, speed: 0.5 })).status, 200);
    assert.equal(calls, 2);
  });
});

test('local service rejects oversized HTTP bodies without inference', async () => {
  let calls = 0;
  await withServer(fakeRuntime(async () => { calls += 1; return WAV; }), async (url) => {
    const result = await speech(url, { ...VALID_REQUEST, padding: 'x'.repeat(17 * 1024) }).catch((error: Error) => error);
    // Node may close a request stream when its bounded body reader stops early.
    if (result instanceof Response) assert.equal(result.status, 400);
    else assert.ok(result instanceof Error);
    assert.equal(calls, 0);
  });
});

test('local service serializes inference, allows one queued request, and refuses a third', async () => {
  const firstStarted = deferred();
  const queuedArrived = deferred();
  const finishFirst = deferred();
  const events: string[] = [];
  let active = 0;
  let maxActive = 0;
  const runtime = fakeRuntime(async (request) => {
    active += 1;
    maxActive = Math.max(active, maxActive);
    events.push(`start:${request.input}`);
    if (request.input === 'First') { firstStarted.resolve(); await finishFirst.promise; }
    events.push(`end:${request.input}`);
    active -= 1;
    return WAV;
  });
  await withServer(runtime, async (url, server) => {
    let incoming = 0;
    server.on('request', (request) => {
      incoming += 1;
      if (incoming === 2) request.once('end', () => setImmediate(queuedArrived.resolve));
    });
    const first = speech(url, { ...VALID_REQUEST, input: 'First' });
    let second: Promise<Response> | undefined;
    try {
      await waitFor(firstStarted.promise, 'first inference');
      second = speech(url, { ...VALID_REQUEST, input: 'Second' });
      await waitFor(queuedArrived.promise, 'queued body');
      const third = await speech(url, { ...VALID_REQUEST, input: 'Third' });
      assert.equal(third.status, 503);
      assert.deepEqual(await third.json(), { error: 'Local speech generation is busy.' });
      assert.deepEqual(events, ['start:First']);
      finishFirst.resolve();
      assert.equal((await waitFor(first, 'first audio')).status, 200);
      assert.equal((await waitFor(second, 'second audio')).status, 200);
      assert.equal(maxActive, 1);
      assert.deepEqual(events, ['start:First', 'end:First', 'start:Second', 'end:Second']);
    } finally {
      finishFirst.resolve();
      await Promise.allSettled([first, ...(second ? [second] : [])]);
    }
  });
});

test('disconnecting a queued request skips its inference and releases queue capacity', async () => {
  const firstStarted = deferred();
  const queuedArrived = deferred();
  const queuedDisconnected = deferred();
  const finishFirst = deferred();
  const calls: string[] = [];
  await withServer(fakeRuntime(async (request) => {
    calls.push(request.input);
    if (request.input === 'First') { firstStarted.resolve(); await finishFirst.promise; }
    return WAV;
  }), async (url, server) => {
    let incoming = 0;
    server.on('request', (request, response) => {
      incoming += 1;
      if (incoming === 2) {
        request.once('end', () => setImmediate(queuedArrived.resolve));
        response.once('close', queuedDisconnected.resolve);
      }
    });
    const first = speech(url, { ...VALID_REQUEST, input: 'First' });
    const controller = new AbortController();
    let queued: Promise<Response> | undefined;
    try {
      await waitFor(firstStarted.promise, 'first inference');
      queued = speech(url, { ...VALID_REQUEST, input: 'Cancelled queued request' }, controller.signal);
      const rejection = assert.rejects(queued, (error: Error) => error.name === 'AbortError');
      await waitFor(queuedArrived.promise, 'queued body');
      controller.abort();
      await waitFor(rejection, 'client cancellation');
      await waitFor(queuedDisconnected.promise, 'queued socket close');
      finishFirst.resolve();
      assert.equal((await waitFor(first, 'first audio')).status, 200);
      // The queued continuation runs as the first request releases its tail.
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(calls, ['First']);
      assert.equal((await speech(url, { ...VALID_REQUEST, input: 'After cancellation' })).status, 200);
      assert.deepEqual(calls, ['First', 'After cancellation']);
    } finally {
      controller.abort();
      finishFirst.resolve();
      await Promise.allSettled([first, ...(queued ? [queued] : [])]);
    }
  });
});

test('disconnecting active speech aborts its runtime signal and allows the next request', async () => {
  const started = deferred();
  const cancelled = deferred();
  const calls: string[] = [];
  await withServer(fakeRuntime(async (request, signal) => {
    calls.push(request.input);
    if (request.input !== 'Cancelled active request') return WAV;
    started.resolve();
    await new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => { cancelled.resolve(); reject(new Error('Cancelled')); }, { once: true });
    });
    return WAV;
  }), async (url) => {
    const controller = new AbortController();
    const pending = speech(url, { ...VALID_REQUEST, input: 'Cancelled active request' }, controller.signal);
    const rejection = assert.rejects(pending, (error: Error) => error.name === 'AbortError');
    try {
      await waitFor(started.promise, 'active inference');
      controller.abort();
      await waitFor(rejection, 'client cancellation');
      await waitFor(cancelled.promise, 'runtime cancellation');
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal((await speech(url, { ...VALID_REQUEST, input: 'Next request' })).status, 200);
      assert.deepEqual(calls, ['Cancelled active request', 'Next request']);
    } finally {
      controller.abort();
      await Promise.allSettled([pending, rejection]);
    }
  });
});

test('local synthesis failure, empty or oversized audio remain private and release the queue', async () => {
  for (const badAudio of [undefined, Buffer.alloc(0), Buffer.alloc(8 * 1024 * 1024 + 1)]) {
    let calls = 0;
    await withServer(fakeRuntime(async () => {
      calls += 1;
      if (calls > 1) return WAV;
      if (badAudio === undefined) throw new Error('private-model-path private-server-secret');
      return badAudio;
    }), async (url) => {
      const response = await speech(url);
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { error: 'Local speech generation failed.' });
      assert.equal((await speech(url)).status, 200);
    });
  }
});
