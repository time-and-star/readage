import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import { getTtsConfiguration, validateTtsRequest } from '../server/tts/config';
import { createTtsRouter } from '../server/tts/routes';
import { TtsService } from '../server/tts/service';
import { TtsError, type TtsProvider } from '../server/tts/types';

const AUDIO = Buffer.from('ID3-test-audio');
function pcmWav(): Buffer {
  const bytes = Buffer.alloc(52);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); // PCM
  bytes.writeUInt16LE(1, 22); // mono
  bytes.writeUInt32LE(24_000, 24);
  bytes.writeUInt32LE(48_000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(8, 40);
  bytes.writeInt16LE(1_000, 44);
  bytes.writeInt16LE(-1_000, 46);
  return bytes;
}
const WAV_AUDIO = pcmWav();
const allow: express.RequestHandler = (_req, _res, next) => next();

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: http.Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function audio(response: http.ServerResponse, bytes = AUDIO): void {
  response.setHeader('Content-Type', 'audio/mpeg');
  response.end(bytes);
}

async function readBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  let body = '';
  for await (const chunk of request) body += chunk;
  return JSON.parse(body);
}

async function harness(
  handler: http.RequestListener,
  run: (context: { url: string; env: NodeJS.ProcessEnv; upstreamUrl: string }) => Promise<void>,
  options: { service?: TtsService; access?: express.RequestHandler } = {},
): Promise<void> {
  const upstream = http.createServer(handler);
  const upstreamUrl = await listen(upstream);
  const env = { TTS_PROVIDER: 'openai-compatible', TTS_BASE_URL: `${upstreamUrl}/v1` };
  const app = express();
  app.use(express.json());
  app.use('/api/tts', createTtsRouter(options.access || allow, { environment: () => env, service: options.service }));
  const server = http.createServer(app);
  try {
    const url = await listen(server);
    await run({ url, env, upstreamUrl });
  } finally {
    await close(server);
    await close(upstream);
  }
}

function synthesize(url: string, body: unknown = { text: 'Hello world.' }, signal?: AbortSignal): Promise<Response> {
  return fetch(`${url}/api/tts/synthesize`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
  });
}

test('timing headers expose only numeric speech metrics and cache hits do not replay inference timings', async () => {
  await harness((_request, response) => {
    response.setHeader('Server-Timing', 'tts-infer;dur=2100.5, tts-pre;dur=70, tts-queue;dur=0, private-description;dur=123, tts-encode;dur=NaN');
    audio(response);
  }, async ({ url }) => {
    const first = await synthesize(url);
    assert.match(first.headers.get('Server-Timing') || '', /tts-infer;dur=2100.5/);
    assert.doesNotMatch(first.headers.get('Server-Timing') || '', /private-description|NaN/);
    await first.arrayBuffer();
    const cached = await synthesize(url);
    assert.match(cached.headers.get('Server-Timing') || '', /tts-cache;dur=0/);
    assert.doesNotMatch(cached.headers.get('Server-Timing') || '', /tts-infer|tts-pre/);
    await cached.arrayBuffer();
  });
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve: resolve! };
}

test('only an explicitly enabled loopback native engine permits audio preparation', async () => {
  await harness((_req, res) => audio(res), async ({ url, env }) => {
    const status = async () => (await (await fetch(`${url}/api/tts/status`)).json()).preload;
    assert.equal(await status(), undefined);
    env.TTS_LOCAL_ENGINE = 'kokoro-js';
    assert.equal(await status(), true);
    env.TTS_BASE_URL = 'https://speech.example.test/v1';
    assert.equal(await status(), undefined);
    env.TTS_BASE_URL = 'http://127.0.0.1:8880/v1';
    env.TTS_PROVIDER = 'browser';
    assert.equal(await status(), undefined);
  });
});

test('simultaneous preparation and playback share one upstream synthesis at capacity', async () => {
  let requests = 0;
  const started = deferred();
  const release = deferred();
  await harness(async (req, res) => {
    requests += 1;
    await readBody(req);
    started.resolve();
    await release.promise;
    audio(res);
  }, async ({ url }) => {
    const prepared = synthesize(url);
    await started.promise;
    const played = synthesize(url);
    const rejected = await synthesize(url, { text: 'Different audio.' });
    assert.equal(rejected.status, 503);
    assert.equal((await rejected.json()).error.code, 'TTS_BUSY');
    release.resolve();
    for (const response of await Promise.all([prepared, played])) {
      assert.equal(response.status, 200);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), AUDIO);
    }
    assert.equal(requests, 1);
  }, { service: new TtsService({ maxConcurrent: 1 }) });
});

test('cancelling one subscriber preserves shared audio; cancelling all releases the model', async () => {
  const configuration = getTtsConfiguration({ TTS_PROVIDER: 'openai-compatible', TTS_BASE_URL: 'http://127.0.0.1:8880' });
  const request = validateTtsRequest({ text: 'Shared word.' });
  const signals: AbortSignal[] = [];
  let release = deferred();
  const provider: TtsProvider = {
    id: 'openai-compatible',
    async synthesize(_configuration, _request, signal) {
      signals.push(signal);
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(new TtsError('TTS_CANCELLED'));
        signal.addEventListener('abort', abort, { once: true });
        release.promise.then(() => { signal.removeEventListener('abort', abort); resolve(); });
      });
      return { bytes: AUDIO, contentType: 'audio/mpeg' };
    },
  };
  const service = new TtsService({ providers: [provider], maxConcurrent: 1, maxCacheEntries: 0 });
  const first = new AbortController();
  const second = new AbortController();
  const prepared = service.synthesize(configuration, request, first.signal);
  const cancelled = assert.rejects(prepared, (error: unknown) => error instanceof TtsError && error.code === 'TTS_CANCELLED');
  const played = service.synthesize(configuration, request, second.signal);
  assert.equal(signals.length, 1);
  first.abort();
  await cancelled;
  assert.equal(signals[0].aborted, false);
  release.resolve();
  assert.deepEqual((await played).bytes, AUDIO);

  release = deferred();
  const third = new AbortController();
  const fourth = new AbortController();
  const pending = [service.synthesize(configuration, request, third.signal), service.synthesize(configuration, request, fourth.signal)];
  const cancellations = pending.map(promise => assert.rejects(promise,
    (error: unknown) => error instanceof TtsError && error.code === 'TTS_CANCELLED'));
  third.abort();
  assert.equal(signals[1].aborted, false);
  fourth.abort();
  await Promise.all(cancellations);
  assert.equal(signals[1].aborted, true);
  release.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual((await service.synthesize(configuration, request)).bytes, AUDIO);
  assert.equal(signals.length, 3);
});

test('TTS is opt-in, validates server URLs, and exposes only safe status', async () => {
  assert.equal(getTtsConfiguration({}).provider, 'browser');
  assert.equal(getTtsConfiguration({}).maxTextLength, 2_000);
  assert.equal(getTtsConfiguration({ TTS_MAX_TEXT_LENGTH: '400' }).maxTextLength, 400);
  assert.equal(getTtsConfiguration({ TTS_MAX_TEXT_LENGTH: '100' }).maxTextLength, 100);
  assert.equal(getTtsConfiguration({ TTS_MAX_TEXT_LENGTH: '2000' }).maxTextLength, 2_000);
  for (const maxTextLength of ['', 'invalid', '99', '2001', '400.5', '-400', 'Infinity']) {
    assert.equal(getTtsConfiguration({ TTS_MAX_TEXT_LENGTH: maxTextLength }).maxTextLength, 2_000);
  }
  assert.equal(getTtsConfiguration({}).audioFormat, 'mp3');
  assert.equal(getTtsConfiguration({ TTS_AUDIO_FORMAT: ' WAV ' }).audioFormat, 'wav');
  assert.equal(getTtsConfiguration({ TTS_AUDIO_FORMAT: 'unsupported' }).audioFormat, 'mp3');
  assert.equal(getTtsConfiguration({ TTS_PROVIDER: 'off' }).configured, false);
  assert.equal(getTtsConfiguration({ TTS_PROVIDER: 'unsupported' }).provider, 'browser');
  for (const url of ['file:///audio', 'ftp://example.test', 'https://user:secret@example.test', 'https://example.test?key=secret', 'not a url']) {
    assert.equal(getTtsConfiguration({ TTS_PROVIDER: 'openai-compatible', TTS_BASE_URL: url }).configured, false);
  }
  assert.equal(getTtsConfiguration({ TTS_BASE_URL: 'http://localhost:8880/' }).endpoint, 'http://localhost:8880/v1/audio/speech');
  assert.equal(getTtsConfiguration({ TTS_BASE_URL: 'https://example.test/api/v1/' }).endpoint, 'https://example.test/api/v1/audio/speech');
  assert.equal(getTtsConfiguration({ TTS_BASE_URL: 'https://example.test/api/openai/' }).endpoint, 'https://example.test/api/openai/audio/speech');
  assert.equal(getTtsConfiguration({ TTS_TIMEOUT_MS: 'invalid' }).timeoutMs, 20_000);
  assert.equal(getTtsConfiguration({ TTS_PROVIDER: 'openai-compatible', TTS_BASE_URL: 'http://localhost:8880', TTS_API_KEY: 'bad\nkey' }).configured, false);
  await harness((_req, res) => audio(res), async ({ url, env }) => {
    env.TTS_API_KEY = 'private-server-secret';
    const response = await fetch(`${url}/api/tts/status`);
    assert.deepEqual(await response.json(), { ok: true, provider: 'openai-compatible', configured: true, maxTextLength: 2_000 });
    env.TTS_PROVIDER = 'browser';
    const unavailable = await synthesize(url);
    assert.equal(unavailable.status, 503);
    assert.equal((await unavailable.json()).error.code, 'TTS_NOT_CONFIGURED');
    assert.deepEqual(await (await fetch(`${url}/api/tts/status`)).json(), { ok: true, provider: 'browser', configured: false, maxTextLength: 2_000 });
  });
});

test('server advertises and enforces a configured short synthesis limit', async () => {
  let requests = 0;
  await harness((_req, res) => { requests += 1; audio(res); }, async ({ url, env }) => {
    env.TTS_MAX_TEXT_LENGTH = '400';
    assert.deepEqual(await (await fetch(`${url}/api/tts/status`)).json(), {
      ok: true, provider: 'openai-compatible', configured: true, maxTextLength: 400,
    });
    const accepted = await synthesize(url, { text: 'a'.repeat(400) });
    assert.equal(accepted.status, 200);
    await accepted.arrayBuffer();
    const rejected = await synthesize(url, { text: 'a'.repeat(401) });
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json()).error.code, 'TTS_INVALID_REQUEST');
    assert.equal(requests, 1, 'over-limit input must not reach the model');
    env.TTS_MAX_TEXT_LENGTH = 'invalid';
    assert.equal((await (await fetch(`${url}/api/tts/status`)).json()).maxTextLength, 2_000);
    assert.equal((await synthesize(url, { text: 'a'.repeat(2_000) })).status, 200);
    assert.equal(requests, 2);
  });
  assert.throws(() => validateTtsRequest({ text: 'a'.repeat(2_001) }, 5_000), (error: unknown) =>
    error instanceof TtsError && error.code === 'TTS_INVALID_REQUEST', 'the absolute 2000-character cap remains');
});

test('TTS request validation preserves punctuation and prevents configuration overrides', async () => {
  assert.deepEqual(validateTtsRequest({ text: '  First sentence.\n\nSecond sentence!  ' }), {
    text: 'First sentence.\n\nSecond sentence!', lang: 'en-US', rate: 1,
  });
  assert.equal(validateTtsRequest({ text: 'a'.repeat(2_000), rate: 0.5, lang: 'en-GB' }).text.length, 2_000);
  const invalid = [null, [], {}, { text: 12 }, { text: ' ' }, { text: 'a'.repeat(2_001) }, { text: 'Hi', rate: 0.49 },
    { text: 'Hi', rate: 2.01 }, { text: 'Hi', rate: '1' }, { text: 'Hi', rate: Infinity }, { text: 'Hi', lang: 'zh-CN' },
    { text: 'Hi', base_url: 'http://attacker.test' }, { text: 'Hi', voice: 'override' }, { text: 'Hi', apiKey: 'override' }];
  for (const body of invalid) assert.throws(() => validateTtsRequest(body), (error: unknown) => error instanceof TtsError && error.code === 'TTS_INVALID_REQUEST');
  let requests = 0;
  await harness((_req, res) => { requests += 1; audio(res); }, async ({ url }) => {
    for (const body of [{ text: '' }, { text: 'a'.repeat(2_001) }, { text: 'Hello', endpoint: 'http://attacker.test' }]) {
      const response = await synthesize(url, body);
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, 'TTS_INVALID_REQUEST');
    }
    assert.equal(requests, 0);
  });
});

test('TTS authorization runs before synthesis and status remains public', async () => {
  let requests = 0;
  const access: express.RequestHandler = (req, res, next) => {
    if (req.headers.authorization !== 'Bearer app-secret') return void res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED' } });
    next();
  };
  await harness((_req, res) => { requests += 1; audio(res); }, async ({ url }) => {
    assert.equal((await fetch(`${url}/api/tts/status`)).status, 200);
    assert.equal((await synthesize(url)).status, 401);
    assert.equal(requests, 0);
    const authorized = await fetch(`${url}/api/tts/synthesize`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer app-secret' },
      body: JSON.stringify({ text: 'Hello.' }),
    });
    assert.equal(authorized.status, 200);
    assert.equal(requests, 1);
  }, { access });
});

test('compatible adapter forwards only server configuration and returns MP3', async () => {
  let received: { body: Record<string, unknown>; authorization: string | undefined; path: string | undefined };
  await harness(async (req, res) => {
    received = { body: await readBody(req), authorization: req.headers.authorization, path: req.url };
    audio(res);
  }, async ({ url, env, upstreamUrl }) => {
    env.TTS_BASE_URL = upstreamUrl;
    env.TTS_MODEL = 'kokoro';
    env.TTS_VOICE = 'af_heart';
    env.TTS_VOICE_EN_GB = 'bf_emma';
    env.TTS_API_KEY = 'private-server-secret';
    const response = await synthesize(url, { text: 'Good morning!\nHow are you?', lang: 'en-GB', rate: 0.85 });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'audio/mpeg');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), AUDIO);
    assert.deepEqual(received!.body, { model: 'kokoro', voice: 'bf_emma', input: 'Good morning!\nHow are you?', response_format: 'mp3', speed: 0.85 });
    assert.equal(received!.authorization, 'Bearer private-server-secret');
    assert.equal(received!.path, '/v1/audio/speech');
    assert.equal(response.headers.get('authorization'), null);
  });
});

test('WAV mode requests WAV, returns the actual MIME, and validates RIFF/WAVE headers', async () => {
  for (const upstreamMime of ['audio/wav', 'audio/wave', 'audio/x-wav', 'application/octet-stream']) {
    let receivedFormat: unknown;
    let receivedAccept: string | undefined;
    await harness(async (req, res) => {
      receivedFormat = (await readBody(req)).response_format;
      receivedAccept = req.headers.accept;
      res.setHeader('Content-Type', upstreamMime);
      res.end(WAV_AUDIO);
    }, async ({ url, env }) => {
      env.TTS_AUDIO_FORMAT = 'wav';
      const response = await synthesize(url);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'audio/wav');
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), WAV_AUDIO);
      assert.equal(receivedFormat, 'wav');
      assert.equal(receivedAccept, 'audio/wav');
    });
  }
  for (const bytes of [AUDIO, Buffer.alloc(52), WAV_AUDIO.subarray(0, 12), Buffer.from(`RIFF${'x'.repeat(48)}`)]) {
    await harness((_req, res) => {
      res.setHeader('Content-Type', 'audio/wav');
      res.end(bytes);
    }, async ({ url, env }) => {
      env.TTS_AUDIO_FORMAT = 'wav';
      const response = await synthesize(url);
      assert.equal(response.status, 502);
      assert.equal((await response.json()).error.code, 'TTS_INVALID_AUDIO');
    });
  }
});

test('adapter rejects mismatched MIME for the configured audio format', async () => {
  for (const format of ['mp3', 'wav']) {
    await harness((_req, res) => {
      res.setHeader('Content-Type', format === 'mp3' ? 'audio/wav' : 'audio/mpeg');
      res.end(format === 'mp3' ? WAV_AUDIO : AUDIO);
    }, async ({ url, env }) => {
      env.TTS_AUDIO_FORMAT = format;
      const response = await synthesize(url);
      assert.equal(response.status, 502);
      assert.equal((await response.json()).error.code, 'TTS_INVALID_AUDIO');
    });
  }
});

test('changing audio format isolates cached audio and preserves matching response MIME', async () => {
  let requests = 0;
  await harness(async (req, res) => {
    requests += 1;
    const body = await readBody(req);
    res.setHeader('Content-Type', body.response_format === 'wav' ? 'audio/wav' : 'audio/mpeg');
    res.end(body.response_format === 'wav' ? WAV_AUDIO : AUDIO);
  }, async ({ url, env }) => {
    const play = async (mime: string, expectedAudio: Buffer) => {
      const response = await synthesize(url, { text: 'Identical text.' });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), mime);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), expectedAudio);
    };
    await play('audio/mpeg', AUDIO);
    await play('audio/mpeg', AUDIO);
    assert.equal(requests, 1);
    env.TTS_AUDIO_FORMAT = 'wav';
    await play('audio/wav', WAV_AUDIO);
    await play('audio/wav', WAV_AUDIO);
    assert.equal(requests, 2);
    env.TTS_AUDIO_FORMAT = 'mp3';
    await play('audio/mpeg', AUDIO);
    assert.equal(requests, 2, 'the earlier MP3 cache entry remains separate');
  });
});

test('audio cache isolates voices, rates, languages, credentials, model and endpoint', async () => {
  let requests = 0;
  await harness((_req, res) => { requests += 1; audio(res); }, async ({ url, env, upstreamUrl }) => {
    const play = async (body = { text: 'Hello.', lang: 'en-US', rate: 1 }) => { const response = await synthesize(url, body); assert.equal(response.status, 200); await response.arrayBuffer(); };
    await play();
    await play();
    assert.equal(requests, 1);
    await play({ text: 'Hello.', lang: 'en-GB', rate: 1 });
    await play({ text: 'Hello.', lang: 'en-US', rate: 0.8 });
    env.TTS_VOICE = 'am_michael'; await play();
    env.TTS_API_KEY = 'another-secret'; await play();
    env.TTS_MODEL = 'another-model'; await play();
    env.TTS_BASE_URL = `${upstreamUrl}/alternate/v1`; await play();
    assert.equal(requests, 7);
  });
});

test('audio cache respects LRU entry, total byte, and expiry limits', async () => {
  for (const [service, sequence, expected] of [
    [new TtsService({ maxCacheEntries: 2 }), ['A', 'B', 'A', 'C', 'B'], 4],
    [new TtsService({ maxCacheBytes: AUDIO.length + 1 }), ['A', 'B', 'A'], 3],
    [new TtsService({ cacheTtlMs: 1 }), ['A', 'A'], 2],
  ] as const) {
    let requests = 0;
    await harness((_req, res) => { requests += 1; audio(res); }, async ({ url }) => {
      for (const text of sequence) {
        const response = await synthesize(url, { text });
        assert.equal(response.status, 200);
        await response.arrayBuffer();
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(requests, expected);
    }, { service });
  }
});

test('upstream failures, redirects, malformed and oversized audio produce safe errors', async () => {
  for (const [handler, code] of [
    [(_req: http.IncomingMessage, res: http.ServerResponse) => { res.statusCode = 500; res.end('private-server-secret http://private-host'); }, 'TTS_UPSTREAM_UNAVAILABLE'],
    [(_req: http.IncomingMessage, res: http.ServerResponse) => { res.statusCode = 401; res.end('private-server-secret http://private-host'); }, 'TTS_UPSTREAM_AUTH_FAILED'],
    [(_req: http.IncomingMessage, res: http.ServerResponse) => { res.statusCode = 403; res.end('private-server-secret http://private-host'); }, 'TTS_UPSTREAM_AUTH_FAILED'],
    [(_req: http.IncomingMessage, res: http.ServerResponse) => { res.statusCode = 302; res.setHeader('Location', '/redirected'); res.end(); }, 'TTS_UPSTREAM_UNAVAILABLE'],
    [(_req: http.IncomingMessage, res: http.ServerResponse) => { res.setHeader('Content-Type', 'application/json'); res.end('{"secret":"private-server-secret"}'); }, 'TTS_INVALID_AUDIO'],
    [(_req: http.IncomingMessage, res: http.ServerResponse) => audio(res, Buffer.alloc(0)), 'TTS_INVALID_AUDIO'],
    [(_req: http.IncomingMessage, res: http.ServerResponse) => audio(res, Buffer.alloc(33)), 'TTS_INVALID_AUDIO'],
    [(_req: http.IncomingMessage, res: http.ServerResponse) => { res.setHeader('Content-Type', 'audio/mpeg'); res.write(Buffer.alloc(20)); res.end(Buffer.alloc(20)); }, 'TTS_INVALID_AUDIO'],
  ] as const) {
    let requests = 0;
    await harness((req, res) => { requests += 1; handler(req, res); }, async ({ url }) => {
      const response = await synthesize(url);
      assert.equal(response.status, 502);
      const body = await response.json();
      assert.equal(body.error.code, code);
      assert.doesNotMatch(JSON.stringify(body), /private-server-secret|private-host/);
      assert.equal(requests, 1, 'redirects must not be followed');
    }, { service: new TtsService({ maxAudioBytes: 32 }) });
  }
});

test('timeouts and client disconnection abort upstream requests and release capacity', async () => {
  let requests = 0;
  const closed = deferred();
  await harness((req, res) => {
    requests += 1;
    if (requests === 1) { req.resume(); res.on('close', closed.resolve); return; }
    audio(res);
  }, async ({ url, env }) => {
    env.TTS_TIMEOUT_MS = '40';
    const timeout = await synthesize(url);
    assert.equal(timeout.status, 504);
    assert.equal((await timeout.json()).error.code, 'TTS_TIMEOUT');
    await closed.promise;
    assert.equal((await synthesize(url, { text: 'Next request.' })).status, 200);
  }, { service: new TtsService({ maxConcurrent: 1 }) });

  let disconnectedRequests = 0;
  const started = deferred();
  const disconnected = deferred();
  await harness((req, res) => {
    disconnectedRequests += 1;
    if (disconnectedRequests === 1) { req.resume(); res.on('close', disconnected.resolve); started.resolve(); return; }
    audio(res);
  }, async ({ url }) => {
    const controller = new AbortController();
    const pending = synthesize(url, { text: 'Cancelled request.' }, controller.signal);
    const rejected = assert.rejects(pending, (error: Error) => error.name === 'AbortError');
    await started.promise;
    controller.abort();
    await rejected;
    await disconnected.promise;
    assert.equal((await synthesize(url, { text: 'After cancellation.' })).status, 200);
  }, { service: new TtsService({ maxConcurrent: 1 }) });
});

test('synthesis concurrency is bounded without queuing unbounded requests', async () => {
  const started = deferred();
  const finish = deferred();
  let requests = 0;
  await harness(async (req, res) => {
    requests += 1;
    req.resume();
    started.resolve();
    await finish.promise;
    audio(res);
  }, async ({ url }) => {
    const pending = synthesize(url, { text: 'First.' });
    await started.promise;
    const busy = await synthesize(url, { text: 'Second.' });
    assert.equal(busy.status, 503);
    assert.equal(busy.headers.get('retry-after'), '1');
    assert.equal((await busy.json()).error.code, 'TTS_BUSY');
    assert.equal(requests, 1);
    finish.resolve();
    assert.equal((await pending).status, 200);
  }, { service: new TtsService({ maxConcurrent: 1 }) });
});
