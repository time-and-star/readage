import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { runLocalApp, stopLocalApp } from '../scripts/start-local.mjs';

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: string | null = null;
  stopCount = 0;
  exit(code: number) { this.exitCode = code; this.emit('exit', code, null); }
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const stop = async (child?: FakeChild) => { if (child && child.exitCode === null) { child.stopCount++; child.exit(0); } };

test('app starts before a pending optional model and cancels its startup on shutdown', async () => {
  const app = new FakeChild();
  const events: string[] = [];
  let engineSignal: AbortSignal | undefined;
  const running = runLocalApp({ launchApp: () => { events.push('app'); return app; }, stopProcess: stop, log: () => {}, errorLog: () => {},
    engines: [{ name: 'Test engine', start: ({ signal }: { signal: AbortSignal }) => {
      events.push('engine'); engineSignal = signal;
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } }],
  });
  await tick();
  assert.deepEqual(events, ['app', 'engine']);
  app.exit(0);
  assert.equal(await running, 0);
  assert.equal(engineSignal?.aborted, true);
});

test('optional model startup failure and later engine exit both leave the app running', async () => {
  const app = new FakeChild();
  const model = new FakeChild();
  const messages: string[] = [];
  let settled = false;
  const running = runLocalApp({ launchApp: () => app, stopProcess: stop, log: () => {}, errorLog: (message: string) => messages.push(message), engines: [
    { name: 'Download', start: async () => { throw new Error('no network'); } },
    { name: 'Speech', start: async () => ({ child: model }) },
  ] }).then(code => { settled = true; return code; });
  await tick();
  assert.equal(settled, false);
  assert.equal(app.stopCount, 0);
  model.exit(5);
  await tick();
  assert.equal(settled, false);
  assert.equal(app.stopCount, 0);
  assert.ok(messages.some(message => /no network.*阅读和词卡仍可使用/.test(message)));
  assert.ok(messages.some(message => /Speech服务已退出.*阅读和词卡仍可使用/.test(message)));
  app.exit(0);
  assert.equal(await running, 0);
});

test('launcher abort cleans owned children, keeps reused engines alone and removes monitoring listeners', async () => {
  const app = new FakeChild();
  const model = new FakeChild();
  const controller = new AbortController();
  const stopped: unknown[] = [];
  const running = runLocalApp({ signal: controller.signal, launchApp: () => app, stopProcess: async (child: FakeChild) => { stopped.push(child); await stop(child); }, log: () => {}, errorLog: () => {}, engines: [
    { name: 'Owned', start: async () => ({ child: model }) },
    { name: 'Reused', start: async () => ({ child: null, reused: true }) },
  ] });
  await tick();
  controller.abort();
  assert.equal(await running, 0);
  assert.deepEqual(stopped, [app, model]);
  assert.equal(app.stopCount, 1);
  assert.equal(model.stopCount, 1);
  assert.equal(model.listenerCount('exit'), 0);
  assert.equal(model.listenerCount('error'), 0);
});

test('application failure still returns failure and cleans the optional owned model', async () => {
  const app = new FakeChild();
  const model = new FakeChild();
  const running = runLocalApp({ launchApp: () => app, stopProcess: stop, log: () => {}, errorLog: () => {}, engines: [{ name: 'Owned', start: async () => ({ child: model }) }] });
  await tick();
  app.exit(7);
  assert.equal(await running, 7);
  assert.equal(model.stopCount, 1);
});

test('graceful IPC app shutdown waits for cleanup before exit instead of force-killing on Windows', async () => {
  const app = Object.assign(new FakeChild(), { connected: true, send: (message: unknown, callback: (error?: Error) => void) => {
    assert.deepEqual(message, { type: 'readage:shutdown' });
    callback();
    setImmediate(() => app.exit(0));
  } });
  await stopLocalApp(app, { timeoutMs: 100, forceStop: async () => assert.fail('Graceful shutdown must allow owned model cleanup.') });
  assert.equal(app.exitCode, 0);
  assert.equal(app.listenerCount('exit'), 0);
  assert.equal(app.listenerCount('error'), 0);
  assert.equal(app.listenerCount('disconnect'), 0);
});

test('IPC shutdown is bounded and falls back to existing owned process cleanup if the app cannot respond', async () => {
  const app = Object.assign(new FakeChild(), { connected: true, send: (_message: unknown, callback: (error?: Error) => void) => callback() });
  await stopLocalApp(app, { timeoutMs: 20, forceStop: stop });
  assert.equal(app.stopCount, 1);
  const disconnected = Object.assign(new FakeChild(), { connected: false });
  await stopLocalApp(disconnected, { forceStop: stop });
  assert.equal(disconnected.stopCount, 1);
});
