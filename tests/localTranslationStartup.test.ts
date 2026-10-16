import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import test from 'node:test';
import { ensureLocalHyMt2, getHyMt2LaunchConfiguration, HYMT2_MODEL_ALIAS } from '../scripts/hymt2-service.mjs';
import { stopChild } from '../scripts/local-process.mjs';

async function listen(server: http.Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: http.Server) {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
}
async function unusedUrl() { const server = http.createServer(); const url = await listen(server); await close(server); return url; }

test('startup reuses only the expected model, without taking ownership of an existing service', async () => {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url === '/props' ? { model_alias: HYMT2_MODEL_ALIAS } : { status: 'ok' }));
  });
  try {
    const baseUrl = await listen(server);
    const result = await ensureLocalHyMt2({ baseUrl, log: () => {}, launch: () => { throw new Error('must not launch'); } });
    assert.equal(result.reused, true); assert.equal(result.child, null);
    await stopChild(result.child); assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
  } finally { await close(server); }
});

test('an occupied port with a different model fails without launching or stopping that model', async () => {
  const server = http.createServer((req, res) => res.end(JSON.stringify(req.url === '/props' ? { model_alias: 'other-model' } : { status: 'ok' })));
  try {
    await assert.rejects(ensureLocalHyMt2({ baseUrl: await listen(server), log: () => {}, launch: () => { throw new Error('must not launch'); } }), /占用/);
    assert.equal(server.listening, true);
  } finally { await close(server); }
});

test('cancelled startup stops its own model process', async () => {
  const controller = new AbortController(); let child: ChildProcess;
  const pending = ensureLocalHyMt2({ baseUrl: await unusedUrl(), signal: controller.signal, pollMs: 20, log: () => {},
    launch: () => { child = spawn(process.execPath, ['--eval', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true }); setTimeout(() => controller.abort(new Error('cancel model startup')), 60); return child; } });
  await assert.rejects(pending, /cancel model startup|aborted/);
  assert.ok(child!.exitCode !== null || child!.signalCode !== null);
});

test('local launch configuration does not allow a remote inference address', () => {
  assert.throws(() => getHyMt2LaunchConfiguration({ TRANSLATION_BASE_URL: 'https://example.test/v1' }), /本机/);
  assert.equal(getHyMt2LaunchConfiguration({ TRANSLATION_THREADS: '4' }).threads, 4);
});
