import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import vm from 'node:vm';

/** Exercise the actual client coordinator while storage/network are isolated failure boundaries. */
async function coordinator(failure: string) {
  const events: string[] = [];
  const result = await build({ entryPoints: ['src/lib/webPatches.ts'], bundle: true, platform: 'node', format: 'cjs', write: false,
    define: { 'import.meta.env': '{"VITE_APP_PLATFORM":"web"}' },
    plugins: [{ name: 'isolated-persistence', setup(builder) {
      builder.onResolve({ filter: /^\.\/storage$/ }, () => ({ path: 'storage', namespace: 'isolated' }));
      builder.onResolve({ filter: /^\.\/localDatabase$/ }, () => ({ path: 'database', namespace: 'isolated' }));
      builder.onLoad({ filter: /.*/, namespace: 'isolated' }, args => ({ contents: args.path === 'storage'
        ? "export async function flushPendingPersistentWrites(){globalThis.record('flush-storage');if(globalThis.failure==='storage')throw new Error('pending storage');}"
        : "export async function flushLocalDatabaseWrites(){globalThis.record('flush-database');if(globalThis.failure==='database')throw new Error('pending database');}" }));
    } }] });
  const module = { exports: {} as any };
  const context: any = { module, exports: module.exports, AbortController, AbortSignal, Promise, console,
    record: (event: string) => events.push(event), failure,
    window: { location: { reload: () => events.push('reload') } },
    fetch: async (url: string, init: RequestInit) => { events.push('activate'); assert.equal(url, '/api/app-updates/activate'); assert.deepEqual(JSON.parse(init.body as string), { id: 'signed-generation' }); return { ok: failure !== 'server', json: async () => failure === 'server' ? { error: { message: 'disk write failed' } } : {} }; } };
  vm.runInNewContext(result.outputFiles[0].text, context);
  return { activate: () => module.exports.activatePatch('signed-generation'), events };
}
test('client activation flushes storage and SQLite before changing generation, then reloads', async () => {
  const c=await coordinator('');await c.activate();assert.deepEqual(c.events,['flush-storage','flush-database','activate','reload']);
});
for(const failure of ['storage','database','server']) test(`client ${failure} failure never reloads or loses the current page`,async()=>{
  const c=await coordinator(failure);await assert.rejects(c.activate());assert.equal(c.events.includes('reload'),false);
  if(failure!=='server')assert.equal(c.events.includes('activate'),false,'unsaved learning data blocks activation request');
});
