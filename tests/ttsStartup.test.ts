import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import test from 'node:test';
import { ensureLocalKokoro, stopChild } from '../scripts/start-local.mjs';

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: http.Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

function healthServer(health: () => object): http.Server {
  return http.createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(health()));
  });
}

async function unusedUrl(): Promise<string> {
  const server = http.createServer();
  const url = await listen(server);
  await close(server);
  return url;
}

function launchCode(code: string): ChildProcess {
  return spawn(process.execPath, ['--input-type=module', '--eval', code], { stdio: 'ignore', windowsHide: true });
}

test('default readiness checks honor the configured Kokoro port without changing the process environment', async () => {
  const originalPort = process.env.TTS_KOKORO_PORT;
  const server = healthServer(() => ({ ok: true, engine: 'kokoro-js', ready: true }));
  const baseUrl = await listen(server);
  try {
    const result = await ensureLocalKokoro({
      environment: { TTS_KOKORO_PORT: new URL(baseUrl).port },
      log: () => {}, launch: () => { throw new Error('must not launch a duplicate engine'); },
    });
    assert.equal(result.reused, true);
    assert.equal(result.child, null);
    assert.equal(process.env.TTS_KOKORO_PORT, originalPort);
  } finally {
    await close(server);
  }
});

test('default Kokoro readiness keeps port 8880 for an unset or blank environment value', async t => {
  const urls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string) => {
    urls.push(input);
    return new Response(JSON.stringify({ ok: true, engine: 'kokoro-js', ready: true }));
  });
  for (const environment of [{}, { TTS_KOKORO_PORT: '' }, { TTS_KOKORO_PORT: '  ' }]) {
    assert.equal((await ensureLocalKokoro({ environment, log: () => {},
      launch: () => { throw new Error('must not launch'); } })).reused, true);
  }
  assert.deepEqual(urls, Array(3).fill('http://127.0.0.1:8880/health'));
});

test('invalid configured ports fail before startup and explicit readiness overrides still work', async () => {
  for (const TTS_KOKORO_PORT of ['0', '-1', '65536', '8881.5', '1e3', 'Infinity', '8881/v1', 'http://remote.test']) {
    await assert.rejects(ensureLocalKokoro({ environment: { TTS_KOKORO_PORT }, log: () => {},
      launch: () => { throw new Error('invalid ports must not launch'); } }), /TTS_KOKORO_PORT.*整数/);
  }
  const server = healthServer(() => ({ ok: true, engine: 'kokoro-js', ready: true }));
  const baseUrl = await listen(server);
  try {
    const result = await ensureLocalKokoro({ baseUrl, environment: { TTS_KOKORO_PORT: 'invalid' },
      log: () => {}, launch: () => { throw new Error('must not launch'); } });
    assert.equal(result.reused, true);
  } finally {
    await close(server);
  }
});

test('a healthy Kokoro service is reused and remains running after launcher cleanup', async () => {
  const server = healthServer(() => ({ ok: true, engine: 'kokoro-js', ready: true }));
  const baseUrl = await listen(server);
  try {
    const result = await ensureLocalKokoro({ baseUrl, log: () => {}, launch: () => { throw new Error('must not launch'); } });
    assert.equal(result.reused, true);
    assert.equal(result.child, null);
    await stopChild(result.child);
    assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
  } finally {
    await close(server);
  }
});

test('an already loading Kokoro service waits for readiness without spawning another engine', async () => {
  let probes = 0;
  const server = healthServer(() => ({ ok: true, engine: 'kokoro-js', ready: ++probes >= 3 }));
  const baseUrl = await listen(server);
  try {
    const result = await ensureLocalKokoro({ baseUrl, pollMs: 10, timeoutMs: 1000, log: () => {}, launch: () => { throw new Error('must not launch'); } });
    assert.equal(result.reused, true);
    assert.equal(result.child, null);
    assert.ok(probes >= 3);
  } finally {
    await close(server);
  }
});

test('an occupied port belonging to a different service fails clearly without launching or stopping it', async () => {
  const server = healthServer(() => ({ ok: true, engine: 'another-service', ready: true }));
  const baseUrl = await listen(server);
  try {
    await assert.rejects(
      ensureLocalKokoro({ baseUrl, log: () => {}, launch: () => { throw new Error('must not launch'); } }),
      /已被其他服务占用/,
    );
    assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
  } finally {
    await close(server);
  }
});

test('a new engine is returned only after readiness and owned cleanup stops its process', async () => {
  const baseUrl = await unusedUrl();
  const port = Number(new URL(baseUrl).port);
  let launched: ChildProcess | undefined;
  try {
    const result = await ensureLocalKokoro({
      baseUrl, pollMs: 20, timeoutMs: 5000, log: () => {},
      launch: () => launched = launchCode(`
        import http from 'node:http';
        let ready = false;
        http.createServer((request, response) => {
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({ ok: true, engine: 'kokoro-js', ready }));
        }).listen(${port}, '127.0.0.1');
        setTimeout(() => ready = true, 100);
      `),
    });
    assert.equal(result.reused, false);
    assert.equal(result.child, launched);
    assert.equal((await (await fetch(`${baseUrl}/health`)).json()).ready, true);
    await stopChild(result.child);
    assert.ok(launched!.exitCode !== null || launched!.signalCode !== null);
  } finally {
    await stopChild(launched);
  }
});

test('an engine process failure is reported immediately instead of waiting for the readiness timeout', async () => {
  const baseUrl = await unusedUrl();
  const startedAt = Date.now();
  await assert.rejects(
    ensureLocalKokoro({ baseUrl, pollMs: 20, timeoutMs: 10_000, log: () => {}, launch: () => launchCode('process.exit(7);') }),
    /就绪前退出.*退出码 7/,
  );
  assert.ok(Date.now() - startedAt < 5000);
});

test('startup timeout stops an owned engine that never becomes ready', async () => {
  const baseUrl = await unusedUrl();
  let launched: ChildProcess | undefined;
  await assert.rejects(
    ensureLocalKokoro({
      baseUrl, pollMs: 20, timeoutMs: 250, log: () => {},
      launch: () => launched = launchCode('setInterval(() => {}, 1000);'),
    }),
    /启动超时/,
  );
  assert.ok(launched!.exitCode !== null || launched!.signalCode !== null);
});

test('stopping the launcher during model startup cancels waiting and stops its owned engine', async () => {
  const baseUrl = await unusedUrl();
  const controller = new AbortController();
  let launched: ChildProcess | undefined;
  const startup = ensureLocalKokoro({
    baseUrl, pollMs: 20, timeoutMs: 10_000, signal: controller.signal, log: () => {},
    launch: () => {
      launched = launchCode('setInterval(() => {}, 1000);');
      setTimeout(() => controller.abort(new Error('cancel startup')), 100);
      return launched;
    },
  });
  await assert.rejects(startup, /cancel startup|aborted/);
  assert.ok(launched!.exitCode !== null || launched!.signalCode !== null);
});
