import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import test from 'node:test';
import { createDesktopEnvironment, isDesktopRequestAllowed, startDesktopServer, stopDesktopChild } from './runtime.mjs';

test('desktop launch isolates its writable data and disables cloud configuration', () => {
  const env = createDesktopEnvironment({ appRoot: '/installed/readge', dataRoot: '/user/readge/workspace',
    environment: { STEP_API_KEY: 'secret', OPENAI_API_KEY: 'secret', PORT: '3000', NODE_OPTIONS: '--inspect', TTS_BASE_URL: 'https://example.com/v1' }, apiToken: 'random-local-token' });
  assert.equal(env.HOST, '127.0.0.1');
  assert.equal(env.PORT, '0');
  assert.equal(env.READGE_OFFLINE, '1');
  assert.equal(env.READGE_MAGAZINE_MANUAL_SYNC, '1');
  assert.equal(env.MAGAZINE_SYNC_ON_BOOT, 'false');
  assert.equal(env.MAGAZINE_SYNC_ENABLED, 'false');
  assert.equal(env.APP_API_TOKEN, 'random-local-token');
  assert.equal(env.STEP_API_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.TTS_BASE_URL, 'http://127.0.0.1:8880/v1');
  assert.equal(env.LOCAL_DATABASE_PATH, path.join('/user/readge/workspace', 'local-data/library/learning.sqlite'));
});

test('renderer requests only reach the server owned by this desktop process', () => {
  const origin = 'http://127.0.0.1:41531';
  assert.equal(isDesktopRequestAllowed(`${origin}/api/local-data/query`, origin), true);
  assert.equal(isDesktopRequestAllowed('ws://127.0.0.1:41531/socket', origin), true);
  for (const url of ['https://example.com/picture.jpg', 'http://127.0.0.1:3000', 'http://127.0.0.1.evil.example:41531', 'file:///secret', 'http://localhost:41531']) {
    assert.equal(isDesktopRequestAllowed(url, origin), false, url);
  }
});

test('owned inference services use selected loopback ports regardless of host configuration', () => {
  const env = createDesktopEnvironment({ appRoot: '/app', dataRoot: '/user', ttsPort: 41001, translationPort: 41002,
    environment: { TTS_KOKORO_PORT: '8880', TRANSLATION_BASE_URL: 'https://cloud.example/v1' } });
  assert.equal(env.TTS_BASE_URL, 'http://127.0.0.1:41001/v1');
  assert.equal(env.TTS_KOKORO_PORT, '41001');
  assert.equal(env.TRANSLATION_BASE_URL, 'http://127.0.0.1:41002/v1');
});

test('startup receives the actual port over IPC and shutdown waits for the owned child', async () => {
  const child = new EventEmitter();
  Object.assign(child, { exitCode: null, signalCode: null, connected: true, kill: () => assert.fail('graceful shutdown should not kill the child') });
  child.send = message => { assert.deepEqual(message, { type: 'readage:shutdown' }); setImmediate(() => child.emit('exit', 0)); };
  let options;
  const launched = startDesktopServer({ appRoot: '/app', dataRoot: '/user', environment: {}, launch: (_entry, _args, opts) => { options = opts; return child; } });
  child.emit('message', { type: 'readge:ready', port: 41531 });
  assert.equal(await launched.ready, 'http://127.0.0.1:41531');
  assert.equal(options.cwd, '/user');
  assert.deepEqual(options.execArgv, []);
  await stopDesktopChild(child);
});

test('a backend exiting before readiness fails startup', async () => {
  const child = new EventEmitter();
  const launched = startDesktopServer({ appRoot: '/app', dataRoot: '/user', environment: {}, launch: () => child });
  child.emit('exit', 1);
  await assert.rejects(launched.ready, /就绪前退出/);
});
