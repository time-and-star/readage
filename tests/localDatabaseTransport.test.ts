import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import {
  configureLocalDatabaseTransport, createHttpLocalDatabaseTransport, requestLocalDatabase,
  resolveLocalDatabaseTransport, usesNativeLocalDatabase, type LocalDatabaseTransport,
} from '../src/lib/platform/localDatabaseTransport';
import { LOCAL_DATA_HEADER, LOCAL_PROFILE_KEY, type LocalTable } from '../src/lib/localDatabaseProtocol';
import { initializeWordMemory, submitFsrsReview } from '../src/lib/memoryV2/fsrsIntegration';

test('Android build cannot select a PC HTTP database when the native adapter is absent', async t => {
  const artifact = await build({ entryPoints: [fileURLToPath(new URL('../src/lib/platform/localDatabaseTransport.ts', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'browser',
    define: { 'import.meta.env': JSON.stringify({ VITE_APP_PLATFORM: 'android' }) } });
  const mobile = await import(`data:text/javascript;base64,${Buffer.from(artifact.outputFiles![0].text).toString('base64')}`);
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let networkCalls = 0;
  globalThis.fetch = async () => { networkCalls++; throw new Error('network disabled'); };
  const http = createHttpLocalDatabaseTransport();
  await assert.rejects(mobile.requestLocalDatabase('status'), /手机本地数据库尚未接入/);
  assert.throws(() => mobile.configureLocalDatabaseTransport(http), /Android 必须使用手机本机数据库/);
  assert.equal(networkCalls, 0);
  mobile.configureLocalDatabaseTransport({ kind: 'native', async request() { return { status: 200, body: { enabled: true } }; } });
  assert.deepEqual(await mobile.requestLocalDatabase('status'), { status: 200, body: { enabled: true } });
  assert.equal(networkCalls, 0);
});

test('desktop transport keeps local request credentials, cancellation and revision conflicts', async () => {
  const requests: { input: string; init?: RequestInit }[] = [];
  const controller = new AbortController();
  const http = createHttpLocalDatabaseTransport(async (input, init) => {
    requests.push({ input: String(input), init });
    return Response.json({ error: 'revision conflict' }, { status: 409 });
  });
  const body = { profileId: 'profile', revision: 1, operationId: 'same-commit', changes: [] };
  const result = await http.request('commit', body, controller.signal);
  assert.deepEqual(result, { status: 409, body: { error: 'revision conflict' } });
  assert.equal(requests[0].input, '/api/local-data/commit');
  assert.equal(requests[0].init!.method, 'POST');
  assert.equal(new Headers(requests[0].init!.headers).get(LOCAL_DATA_HEADER), '1');
  assert.deepEqual(JSON.parse(String(requests[0].init!.body)), body);
  assert.equal(requests[0].init!.signal, controller.signal);
  await http.request('status');
  assert.equal(requests[1].init!.method, 'GET');
  await assert.rejects(http.request('../other-api' as any), /不支持的数据库操作/);
  assert.equal(requests.length, 2);
});

class BrowserStorage implements Storage {
  values = new Map<string, string>();
  get length() { return this.values.size; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  clear() { this.values.clear(); }
}

test('native transport runs existing settings and FSRS transactions against SQLite without HTTP', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'readge-native-transport-'));
  const filename = path.join(directory, 'learning.sqlite');
  const saved = new Map(['window', 'document', 'fetch'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const browser = new BrowserStorage();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    localStorage: browser, addEventListener() {}, dispatchEvent() {}, setInterval() { return 1; }, location: { reload() {} },
  } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { visibilityState: 'visible' } });
  let httpCalls = 0;
  globalThis.fetch = async () => { httpCalls++; throw new Error('this device has no PC or network'); };
  // This is a host-side protocol test; it does not stand in for an Android plugin/device test.
  const { LocalLearningDatabase, LocalDatabaseConflict } = await import('../server/localDatabase/store');
  const database = new LocalLearningDatabase(filename);
  t.after(async () => {
    database.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('readge-native-transport-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const state = submitFsrsReview(initializeWordMemory('u', 'serendipity'), 'Good', new Date('2026-09-01T12:00:00Z'));
  const initial = database.bootstrap({ format: 'english-ai-local-backup', version: 1,
    exportedAt: '2026-10-09T00:00:00Z', memoryStorage: 'localStorage',
    localStorage: { 'english-ai:v2:articles': '[{"id":"article","content":"完整原文"}]' } });
  browser.setItem(LOCAL_PROFILE_KEY, initial.profile.id);
  let available: 'missing' | 'disabled' | 'ready' = 'missing';
  let loseCommitReply = true;
  let malformed = false;
  const commands: string[] = [];
  const native: LocalDatabaseTransport = { kind: 'native', async request(command, payload, signal) {
    signal?.throwIfAborted();
    commands.push(command);
    if (malformed) return { status: 200, body: [] as any };
    const body = payload as Record<string, any>;
    try {
      switch (command) {
        case 'status': return available === 'missing'
          ? { status: 404, body: { error: 'missing native database' } }
          : { status: 200, body: { enabled: available === 'ready' } };
        case 'bootstrap': return { status: 200, body: database.bootstrap(body.source, body.preferredId) };
        case 'query': return { status: 200, body: body.keys
          ? database.queryKeys(body.profileId, body.table as LocalTable, body.keys)
          : database.query(body.profileId, body.table as LocalTable, body.key, body.prefix) };
        case 'commit': {
          const revision = database.commit(body.profileId, body.revision, body.changes, body.operationId);
          if (loseCommitReply) { loseCommitReply = false; throw new TypeError('native acknowledgement lost'); }
          return { status: 200, body: { revision } };
        }
        case 'snapshot': return { status: 200, body: database.snapshot(body.profileId) as any };
        default: throw new Error(`unexpected command: ${command}`);
      }
    } catch (error) {
      if (error instanceof LocalDatabaseConflict) return { status: 409, body: { error: error.message } };
      throw error;
    }
  } };
  configureLocalDatabaseTransport(native);
  assert.equal(usesNativeLocalDatabase(), true);
  assert.equal(resolveLocalDatabaseTransport(native, true), native);
  const client = await import('../src/lib/localDatabase');
  await assert.rejects(client.initializeLocalDatabase(), /重启本地应用/);
  assert.equal(client.isLocalDatabaseActive(), false);
  available = 'disabled';
  await assert.rejects(client.initializeLocalDatabase(), /本机运行入口/);
  assert.equal(client.isLocalDatabaseActive(), false);
  available = 'ready';
  await client.initializeLocalDatabase();
  assert.equal(client.isLocalDatabaseActive(), true);
  assert.equal(client.getApplicationStorage()!.getItem('english-ai:v2:articles'), initial.settings['english-ai:v2:articles']);
  const { SqliteMemoryStorage } = await import('../src/lib/memoryV2/sqliteImpl');
  const memory = new SqliteMemoryStorage();
  let computations = 0;
  await client.withLocalDatabaseTransaction(async () => { computations++; await memory.saveMemoryState(state); });
  assert.equal(computations, 1, 'lost acknowledgements must not repeat the learning action');
  assert.deepEqual(await memory.getMemoryState('u', 'serendipity'), state);
  client.getApplicationStorage()!.setItem('english-ai:v2:readingBookmark', '{"articleId":"article","paragraphIndex":3}');
  await client.flushLocalDatabaseWrites();
  assert.equal(database.settings(initial.profile.id)['english-ai:v2:readingBookmark'], '{"articleId":"article","paragraphIndex":3}');
  const reopened = new LocalLearningDatabase(filename);
  try {
    assert.deepEqual(reopened.query(initial.profile.id, 'memoryState', 'u|serendipity').rows[0].value, { state });
  } finally { reopened.close(); }
  assert.ok(commands.includes('bootstrap') && commands.includes('commit'));
  assert.equal(httpCalls, 0);
  const backups = await import('../src/lib/localDataBackup');
  await assert.rejects(backups.downloadFullLocalBackup(), /文件接口尚未接入/);
  await assert.rejects(backups.importFullLocalBackup(new File([], 'archive.zip')), /文件接口尚未接入/);
  assert.equal(httpCalls, 0, 'native archives must not fall back to PC endpoints');
  assert.throws(() => configureLocalDatabaseTransport(createHttpLocalDatabaseTransport()), /不能切换数据库/);
  const beforeAbort = commands.length;
  await assert.rejects(requestLocalDatabase('query', {}, AbortSignal.abort()), { name: 'AbortError' });
  assert.equal(commands.length, beforeAbort);
  malformed = true;
  await assert.rejects(requestLocalDatabase('status'), /无效结果/);
});
