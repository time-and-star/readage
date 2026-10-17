import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createWebsiteServer } from '../website/server.mjs';
import { createAppUpdateRouter } from '../server/appUpdateRoutes';
import { isOfflineApiAllowed } from '../server/offline';
import { AppUpdateController, UPDATE_PREFERENCES_KEY } from '../src/lib/appUpdateController';
import { startAppUpdateChecks } from '../src/lib/appUpdateSchedule';
import { validateUpdateManifest, isNewerRelease, updateIdentity, UPDATE_INTERVAL_MS, type InstalledVersion } from '../website/update-protocol.mjs';

const current: InstalledVersion = { platform: 'web', version: '0.1.2', build: 0 };
const manifest = (version = '0.2.0', build = 6) => validateUpdateManifest({ schemaVersion: 1, releases: Object.fromEntries(['web', 'windows', 'android'].map(platform => [platform, { version, build, publishedAt: '2026-10-17T00:00:00Z', notes: ['更舒适的阅读体验。', '<b>纯文字更新说明</b>'] }])) });
function setup() {
  const values = new Map<string, string>(); let now = 1_000_000, calls = 0, data = manifest(), fail = false;
  const dependencies = { current, installed: async () => current, now: () => now,
    storage: { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) },
    load: async () => { calls++; if (fail) throw new Error('offline'); return data; } };
  return { dependencies, controller: new AppUpdateController(dependencies), values, get calls() { return calls; }, advance: (ms = UPDATE_INTERVAL_MS) => { now += ms; }, setData: value => { data = value; }, setFail: (value = true) => { fail = value; } };
}

test('failed checks retry after one minute; reconnection bypasses recent success and restores a newer release', async () => {
  for (const platform of ['web', 'windows', 'android'] as const) {
    const s = setup(); const installed = { ...current, platform, build: platform === 'android' ? 5 : 0 };
    const c = new AppUpdateController({ ...s.dependencies, current: installed, installed: async () => installed });
    s.setFail(); await c.check(); assert.equal(s.calls, 1);
    await c.check(); assert.equal(s.calls, 1);
    s.advance(60_000); s.setFail(false); await c.check(); assert.ok(c.state.available, platform);
    c.decline(); s.setData(manifest('0.3.0', 7));
    await c.check(); assert.equal(c.state.available, null);
    await c.check(false, true); assert.equal(c.state.available.release.version, '0.3.0');
    c.decline(); await c.check(false, true); assert.equal(c.state.available, null);
    await c.check(true); assert.ok(c.state.available);
  }
});

test('online event during a failing request triggers one fresh check rather than losing reconnection', async () => {
  const s = setup(); let reject: (error: Error) => void; let calls = 0;
  const c = new AppUpdateController({ ...s.dependencies, load: async () => {
    calls++; return calls === 1 ? new Promise((_, r) => { reject = r; }) : manifest();
  } });
  const first = c.check(); await new Promise(r => setImmediate(r));
  await c.check(false, true); reject(new Error('old connection failed')); await first;
  await new Promise(r => setImmediate(r));
  assert.equal(calls, 2); assert.ok(c.state.available); assert.equal(c.state.checking, false);
});

test('cancel completes even when the version bridge ignores cancellation', async () => {
  const s = setup(); const c = new AppUpdateController({ ...s.dependencies, installed: () => new Promise(() => {}) });
  const pending = c.check(); c.cancel(); await pending;
  assert.equal(c.state.checking, false); assert.equal(c.state.available, null); assert.equal(s.calls, 0);
});

test('shared lifecycle checks startup, online, hidden resume and manual-independent cooldown; cleanup removes timers and events', () => {
  const browser = new EventTarget(), page = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const network = { onLine: true }; const callbacks = new Map<number, () => void>(); let id = 0;
  Object.assign(browser, { setTimeout: fn => { callbacks.set(++id, fn); return id; }, setInterval: fn => { callbacks.set(++id, fn); return id; },
    clearTimeout: n => callbacks.delete(n), clearInterval: n => callbacks.delete(n) });
  const calls: boolean[] = [];
  const stop = startAppUpdateChecks({ check: (_manual, force) => { calls.push(force); } } as any, browser as any, page as any, network as any);
  callbacks.get(1)(); assert.deepEqual(calls, [true]);
  callbacks.get(2)(); assert.deepEqual(calls, [true, false]);
  page.visibilityState = 'hidden'; browser.dispatchEvent(new Event('online')); assert.equal(calls.length, 2);
  page.visibilityState = 'visible'; page.dispatchEvent(new Event('visibilitychange')); assert.equal(calls.at(-1), true);
  network.onLine = false; browser.dispatchEvent(new Event('online')); assert.equal(calls.length, 3);
  network.onLine = true; browser.dispatchEvent(new Event('online')); assert.equal(calls.at(-1), true);
  stop(); assert.equal(callbacks.size, 0); browser.dispatchEvent(new Event('online')); assert.equal(calls.length, 4);
});
test('numeric version ordering avoids lexical errors and never downgrades; Android uses installer build code', () => {
  assert.equal(isNewerRelease(manifest('0.10.0').releases.web, { ...current, version: '0.9.9' }), true);
  assert.equal(isNewerRelease(manifest('0.1.2').releases.web, current), false);
  assert.equal(isNewerRelease(manifest('0.1.1').releases.web, current), false);
  assert.equal(isNewerRelease(manifest('1.0.4', 6).releases.android, { platform: 'android', version: '1.0.4', build: 5 }), true);
  assert.equal(isNewerRelease(manifest('2.0.0', 4).releases.android, { platform: 'android', version: '1.0.4', build: 5 }), false);
});

test('an already applied or rejected patch does not hide a newer full installer', () => {
  for (const platform of ['web', 'windows', 'android'] as const) {
    const installed = { platform, version: '0.1.3', shellVersion: '0.1.2', build: 5, runtime: 'a'.repeat(64), revision: 2, rejectedRevision: 3 };
    const release = { ...manifest('0.1.4', 6).releases[platform], bundle: { runtime: installed.runtime, revision: 3, version: '0.1.5', bytes: 100 } };
    assert.equal(isNewerRelease(release, installed), true, platform);
    assert.equal(isNewerRelease({ ...release, version: '0.1.2', build: 5 }, installed), false, platform);
  }
});
test('only full installer versions trigger an offer even with newer legacy patch metadata', async () => {
  for (const platform of ['web', 'windows', 'android'] as const) {
    const installed = { platform, version: '0.1.2', build: 5, runtime: 'a'.repeat(64), revision: 0 };
    const same = manifest('0.1.2',5);
    (same.releases[platform] as any).bundle = {runtime:installed.runtime,revision:999,version:'9.9.9',bytes:100};
    const clean=validateUpdateManifest(same);
    assert.equal('bundle' in clean.releases[platform],false);
    assert.equal(isNewerRelease(same.releases[platform],installed),false);
    assert.equal(updateIdentity(platform,same.releases[platform]),platform+':0.1.2:5');
    const s=setup();const controller=new AppUpdateController({...s.dependencies,current:installed,installed:async()=>installed,load:async()=>clean});
    await controller.check(true);assert.equal(controller.state.available,null);assert.match(controller.state.notice,/最新版本 v0.1.2/);
    assert.equal(isNewerRelease(manifest('0.1.5',8).releases[platform],installed),true);
  }
});

test('manifest bounds, fields and plain text are validated; server-supplied download URLs are discarded', () => {
  const data = manifest(); (data as any).downloadUrl = 'https://untrusted.example';
  assert.equal('downloadUrl' in validateUpdateManifest(data), false);
  for (const mutate of [d => d.schemaVersion = 2, d => d.releases.web.version = 'latest', d => d.releases.android.build = 0,
    d => d.releases.web.notes = [], d => d.releases.web.notes = ['x'.repeat(501)], d => d.releases.web.publishedAt = 'bad']) {
    const invalid = structuredClone(data); mutate(invalid); assert.throws(() => validateUpdateManifest(invalid));
  }
});
test('automatic checks throttle to six hours, survive restarts, decline per release, allow manual restore and show next release', async () => {
  const s = setup(); await s.controller.check(); assert.equal(s.calls, 1); assert.equal(s.controller.state.available.release.version, '0.2.0');
  s.controller.decline(); assert.equal(s.controller.state.available, null);
  const restarted = new AppUpdateController(s.dependencies); await restarted.check(); assert.equal(s.calls, 1);
  s.advance(); await restarted.check(); assert.equal(s.calls, 2); assert.equal(restarted.state.available, null);
  await restarted.check(true); assert.equal(s.calls, 3); assert.ok(restarted.state.available);
  restarted.decline(); s.setData(manifest('0.3.0')); s.advance(); await restarted.check(); assert.equal(restarted.state.available.release.version, '0.3.0');
  assert.deepEqual([...s.values.keys()], [UPDATE_PREFERENCES_KEY]);
});
test('up-to-date and failed background checks stay quiet, manual checks show useful feedback and can retry immediately', async () => {
  const s = setup(); s.setData(manifest('0.1.2')); await s.controller.check(); assert.equal(s.controller.state.notice, null);
  await s.controller.check(true); assert.match(s.controller.state.notice, /最新版本 v0.1.2/);
  s.controller.clearNotice(); assert.equal(s.controller.state.notice, null);
  s.setFail(); s.advance(); await s.controller.check(); assert.equal(s.controller.state.notice, null);
  await s.controller.check(true); assert.match(s.controller.state.notice, /网络.*重试/); assert.equal(s.calls, 4);
});
test('in-flight checks deduplicate and a manual request adopts the result; cancelled stale responses never open a card', async () => {
  const s = setup(); let resolve: (value: ReturnType<typeof manifest>) => void;
  s.dependencies.load = () => new Promise(r => { resolve = r; });
  const controller = new AppUpdateController(s.dependencies); const pending = controller.check(); await new Promise(r => setImmediate(r));
  await controller.check(true); assert.equal(controller.state.checking, true);
  controller.cancel(); resolve(manifest()); await pending; assert.equal(controller.state.available, null); assert.equal(controller.state.checking, false);
  const again = controller.check(true); await new Promise(r => setImmediate(r)); resolve(manifest('0.1.2')); await again; assert.match(controller.state.notice, /最新/);
});
test('corrupt or denied storage and backwards clock changes do not prevent checks', async () => {
  const s = setup(); s.values.set(UPDATE_PREFERENCES_KEY, '{bad'); const c = new AppUpdateController(s.dependencies); await c.check(); assert.ok(c.state.available);
  s.advance(-100); assert.equal(c.due(), true);
  const blocked = new AppUpdateController({ ...s.dependencies, storage: { getItem: () => { throw Error(); }, setItem: () => { throw Error(); } } });
  await blocked.check(); blocked.decline(); assert.equal(blocked.state.available, null);
});
async function serve(t, server) {
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(r)); });
  return `http://127.0.0.1:${server.address().port}`;
}
test('real website → app transport serves fresh notes with fixed endpoint, no credentials forwarded and no extra static files', async t => {
  const base = path.resolve('tmp/app-update-tests'); await mkdir(base, { recursive: true }); const dir = await mkdtemp(path.join(base, 'run-'));
  const releasesFile = path.join(dir, 'releases.json'); await writeFile(releasesFile, JSON.stringify(manifest()));
  const hub = await createWebsiteServer({ dataDirectory: dir, releasesFile }); const origin = await serve(t, hub);
  const requests: any[] = []; const app = express(); app.use(express.json());
  app.use('/api/app-updates', createAppUpdateRouter((async (url, options) => { requests.push({ url, options }); return fetch(url, options); }) as typeof fetch, origin));
  const appOrigin = await serve(t, http.createServer(app));
  t.after(async () => { assert.equal(path.dirname(dir), base); await rm(dir, { recursive: true }); });
  const response = await fetch(appOrigin + '/api/app-updates/check', { method: 'POST', headers: { Cookie: 'private-learning-cookie', Authorization: 'Bearer secret', 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://untrusted.example' }) });
  assert.equal(response.status, 200); assert.equal((await response.json()).releases.web.version, '0.2.0');
  assert.equal(requests[0].url, origin + '/api/updates/latest'); assert.deepEqual(requests[0].options.headers, { Accept: 'application/json' }); assert.equal(requests[0].options.redirect, 'error');
  await writeFile(releasesFile, JSON.stringify(manifest('0.3.0'))); assert.equal((await (await fetch(origin + '/api/updates/latest')).json()).releases.web.version, '0.3.0');
  assert.equal((await fetch(origin + '/api/updates/latest', { method: 'POST' })).status, 405);
  assert.equal((await fetch(origin + '/api/updates/latest', { method: 'HEAD' })).status, 200);
  assert.equal((await fetch(origin + '/releases.json')).status, 404); assert.equal((await fetch(origin + '/update-protocol.mjs')).status, 404);
  await writeFile(releasesFile, '{}'); assert.equal((await fetch(origin + '/api/updates/latest')).status, 503);
});
test('invalid or oversized upstream data and network failures produce retry errors without any fallback request', async t => {
  for (const result of [() => Response.json({}), () => new Response('x'.repeat(128 * 1024 + 1)), () => { throw new Error('offline'); }]) {
    let calls = 0; const app = express(); app.use('/api/app-updates', createAppUpdateRouter((async () => { calls++; return result(); }) as typeof fetch));
    const origin = await serve(t, http.createServer(app)); const response = await fetch(origin + '/api/app-updates/check', { method: 'POST' });
    assert.equal(response.status, 503); assert.match((await response.json()).error.message, /重试/); assert.equal(calls, 1);
  }
});
test('offline boundary permits only explicit metadata POST; arbitrary fetch routes stay blocked', async () => {
  assert.equal(isOfflineApiAllowed('/api/app-updates/check', 'POST'), true);
  assert.equal(isOfflineApiAllowed('/api/app-updates/check', 'GET'), false);
  assert.equal(isOfflineApiAllowed('/api/app-updates/fetch', 'POST'), false);
});
