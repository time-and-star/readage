import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import vm from 'node:vm';

async function installer(platform: string, failure = '') {
  const events: string[] = [];
  const result = await build({ entryPoints: ['src/lib/installerUpdates.ts'], bundle: true, platform: 'node', format: 'cjs', write: false,
    define: { 'import.meta.env': JSON.stringify({ VITE_APP_PLATFORM: platform }) },
    plugins: [{ name: 'isolated-installer-boundaries', setup(builder) {
      builder.onResolve({ filter: /^\.\/(storage|localDatabase|platform\/nativeAppUpdates)$/ }, args => ({ path: args.path, namespace: 'isolated' }));
      builder.onLoad({ filter: /.*/, namespace: 'isolated' }, args => ({ contents: args.path.endsWith('nativeAppUpdates')
        ? 'export const nativeAppUpdates={installInstaller:async ({version})=>globalThis.install(version)};'
        : args.path.endsWith('storage')
          ? "export async function flushPendingPersistentWrites(){globalThis.record('storage');if(globalThis.failure==='storage')throw Error('unsaved learning writes');}"
          : "export async function flushLocalDatabaseWrites(){globalThis.record('database');if(globalThis.failure==='database')throw Error('unsaved database');}" }));
    } }] });
  const module = { exports: {} as any };
  const install = async (version: string) => { assert.equal(version, '2.0.0'); events.push('system-installer'); };
  vm.runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, failure,
    record: (event: string) => events.push(event), install, window: { readageInstaller: { install } } });
  return { install: () => module.exports.installInstaller('2.0.0'), events };
}

for (const platform of ['desktop', 'android']) {
  test(`${platform}: save learning writes and SQLite before requesting the complete-package system installer`, async () => {
    const c = await installer(platform); await c.install();
    assert.deepEqual(c.events, ['storage', 'database', 'system-installer']);
  });
  for (const failure of ['storage', 'database']) test(`${platform}: ${failure} save failure blocks system installation`, async () => {
    const c = await installer(platform, failure); await assert.rejects(c.install());
    assert.equal(c.events.includes('system-installer'), false);
  });
}
