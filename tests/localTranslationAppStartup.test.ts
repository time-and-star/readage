import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import { createLocalTranslationStartup } from '../server/translation/startup';
import { createLocalTranslationRouter } from '../server/translation/routes';
import { ensureLocalHyMt2, HYMT2_MODEL_ALIAS } from '../scripts/hymt2-service.mjs';
import { stopChild } from '../scripts/local-process.mjs';

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

async function unusedUrl(): Promise<string> {
  const server = http.createServer();
  const url = await listen(server);
  await close(server);
  return url;
}

function environment(baseUrl: string): NodeJS.ProcessEnv {
  return { TRANSLATION_LOCAL_ENGINE: 'hymt2', TRANSLATION_BASE_URL: `${baseUrl}/v1` };
}

// Real readiness probes and child processes, with shorter polling for tests.
const ensure: typeof ensureLocalHyMt2 = options => ensureLocalHyMt2({ ...options, pollMs: 20, timeoutMs: 5000 });

function modelLauncher(baseUrl: string) {
  let child: ChildProcess | undefined;
  let launches = 0;
  let markListening!: () => void;
  const listening = new Promise<void>(resolve => { markListening = resolve; });
  return {
    get child() { return child; },
    get launches() { return launches; },
    listening,
    launch() {
      launches++;
      child = spawn(process.execPath, ['--input-type=module', '--eval', `
        import http from 'node:http';
        let ready = false;
        process.on('message', message => { if (message === 'ready') ready = true; });
        http.createServer((request, response) => {
          response.setHeader('Content-Type', 'application/json');
          if (request.url === '/props') {
            response.end(JSON.stringify({ model_alias: ${JSON.stringify(HYMT2_MODEL_ALIAS)} }));
          } else {
            response.statusCode = ready ? 200 : 503;
            response.end(JSON.stringify(ready ? { status: 'ok' } : { error: { type: 'unavailable_error' } }));
          }
        }).listen(${Number(new URL(baseUrl).port)}, '127.0.0.1', () => process.send('listening'));
      `], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
      child.on('message', message => { if (message === 'listening') markListening(); });
      return child;
    },
  };
}

async function statusRouter(startup: ReturnType<typeof createLocalTranslationStartup>, env: NodeJS.ProcessEnv) {
  const app = express();
  app.use('/api/translation', createLocalTranslationRouter((_req, _res, next) => next(), {
    environment: () => env, startupStatus: startup.status,
  }));
  const server = http.createServer(app);
  const url = await listen(server);
  return { close: () => close(server), read: async () => {
    const response = await fetch(`${url}/api/translation/status`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    return response.json();
  } };
}

test('ordinary app startup launches one model for simultaneous callers and exposes loading then readiness', { timeout: 10_000 }, async () => {
  const baseUrl = await unusedUrl();
  const model = modelLauncher(baseUrl);
  const env = environment(baseUrl);
  const startup = createLocalTranslationStartup({ environment: env, ensure, launch: model.launch, log: () => {} });
  const status = await statusRouter(startup, env);
  const first = startup.start();
  const second = startup.start();
  try {
    assert.equal(first, second);
    await model.listening;
    assert.equal(model.launches, 1);
    const loading = await status.read();
    assert.equal(loading.configured, true);
    assert.equal(loading.startup.state, 'starting');
    model.child!.send('ready');
    await Promise.all([first, second]);
    assert.equal((await status.read()).startup.state, 'ready');
    assert.equal((await (await fetch(`${baseUrl}/health`)).json()).status, 'ok');
    const stopping = startup.stop();
    assert.equal(startup.stop(), stopping);
    await stopping;
    assert.ok(model.child!.exitCode !== null || model.child!.signalCode !== null);
    assert.equal(startup.status().state, 'stopped');
  } finally {
    await startup.stop();
    await stopChild(model.child);
    await status.close();
  }
});

test('closing the app leaves a reused translation service available to its original owner', async () => {
  const model = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url === '/props' ? { model_alias: HYMT2_MODEL_ALIAS } : { status: 'ok' }));
  });
  const baseUrl = await listen(model);
  const startup = createLocalTranslationStartup({ environment: environment(baseUrl), ensure,
    launch: () => { throw new Error('a reused model must not be launched'); }, log: () => {} });
  try {
    await startup.start();
    assert.equal(startup.status().state, 'ready');
    await startup.stop();
    assert.equal(startup.status().state, 'stopped');
    assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
  } finally {
    await startup.stop();
    await close(model);
  }
});

test('closing the app while its model loads cancels startup and cleans up the process', { timeout: 10_000 }, async () => {
  const baseUrl = await unusedUrl();
  const loadingModel = modelLauncher(baseUrl);
  const startup = createLocalTranslationStartup({ environment: environment(baseUrl), ensure,
    launch: loadingModel.launch, log: () => {} });
  const pending = startup.start();
  const rejected = assert.rejects(pending, /应用已关闭|aborted/);
  try {
    await loadingModel.listening;
    await startup.stop();
    await rejected;
    assert.ok(loadingModel.child!.exitCode !== null || loadingModel.child!.signalCode !== null);
    assert.equal(startup.status().state, 'stopped');
    await startup.start();
    assert.equal(loadingModel.launches, 1);
  } finally {
    await startup.stop();
    await stopChild(loadingModel.child);
  }
});

test('disabled and invalid translation configuration do not start a model and status explains the failure', async () => {
  const launch = () => { throw new Error('configuration must prevent a model launch'); };
  const disabled = createLocalTranslationStartup({ environment: {}, ensure, launch, log: () => {} });
  await disabled.start();
  assert.equal(disabled.status().state, 'disabled');
  await disabled.stop();

  const env = { TRANSLATION_LOCAL_ENGINE: 'hymt2', TRANSLATION_BASE_URL: 'https://example.test/v1' };
  const invalid = createLocalTranslationStartup({ environment: env, ensure, launch, log: () => {} });
  const status = await statusRouter(invalid, env);
  try {
    await assert.rejects(invalid.start(), /本机/);
    const data = await status.read();
    assert.equal(data.configured, false);
    assert.equal(data.startup.state, 'error');
    assert.match(data.startup.message, /本机/);
  } finally {
    await invalid.stop();
    await status.close();
  }
});

test('an occupied translation port is reported through app status without taking over the other service', async () => {
  const other = http.createServer((_req, res) => res.end(JSON.stringify({ status: 'another-service' })));
  const baseUrl = await listen(other);
  const env = environment(baseUrl);
  const startup = createLocalTranslationStartup({ environment: env, ensure,
    launch: () => { throw new Error('must not launch on an occupied port'); }, log: () => {} });
  const status = await statusRouter(startup, env);
  try {
    await assert.rejects(startup.start(), /占用/);
    const data = await status.read();
    assert.equal(data.configured, true);
    assert.equal(data.startup.state, 'error');
    assert.match(data.startup.message, /占用/);
    await startup.stop();
    assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
  } finally {
    await startup.stop();
    await status.close();
    await close(other);
  }
});

test('a model process exiting after readiness changes app status to an actionable error', { timeout: 10_000 }, async () => {
  const baseUrl = await unusedUrl();
  const model = modelLauncher(baseUrl);
  const startup = createLocalTranslationStartup({ environment: environment(baseUrl), ensure,
    launch: model.launch, log: () => {} });
  const pending = startup.start();
  try {
    await model.listening;
    model.child!.send('ready');
    await pending;
    const exited = once(model.child!, 'exit');
    model.child!.kill();
    await exited;
    assert.equal(startup.status().state, 'error');
    assert.match(startup.status().message!, /退出.*重新启动/);
  } finally {
    await startup.stop();
    await stopChild(model.child);
  }
});
