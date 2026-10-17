import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { updateRuntime } from '../scripts/update-shell.mjs';

test('native compatibility stays stable for UI/version changes and changes for native APIs, server code, dictionaries and dependencies', async t => {
  await fs.mkdir('tmp/patch-runtime-tests',{recursive:true});const root=await fs.mkdtemp(path.resolve('tmp/patch-runtime-tests/run-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const write=async(file,value)=>{await fs.mkdir(path.dirname(path.join(root,file)),{recursive:true});await fs.writeFile(path.join(root,file),value);};
  await write('package.json',JSON.stringify({name:'test',version:'1.0.0',dependencies:{react:'19.0.1'}}));
  await write('package-lock.json',JSON.stringify({name:'test',version:'1.0.0',packages:{'':{version:'1.0.0'},'node_modules/react':{version:'19.0.1'}}}));
  await write('src/App.tsx','ui1');await write('server.ts','server1');await write('android/app/src/main/java/Test.java','native1');
  await write('android/app/build.gradle','versionCode 1\nversionName "1.0.0"');
  const ids=async()=>Object.fromEntries(await Promise.all(['web','windows','android'].map(async p=>[p,await updateRuntime(root,p)])));
  const baseline=await ids();await write('src/App.tsx','ui2');assert.deepEqual(await ids(),baseline);
  await write('package.json',JSON.stringify({name:'test',version:'2.0.0',dependencies:{react:'19.0.1'}}));
  await write('package-lock.json',JSON.stringify({name:'test',version:'2.0.0',packages:{'':{version:'2.0.0'},'node_modules/react':{version:'19.0.1'}}}));
  await write('android/app/build.gradle','versionCode 2\nversionName "2.0.0"');assert.deepEqual(await ids(),baseline,'shell version increments alone do not break compatibility');
  await write('server.ts','server2');const server=await ids();assert.notEqual(server.web,baseline.web);assert.notEqual(server.windows,baseline.windows);assert.equal(server.android,baseline.android);
  await write('android/app/src/main/java/Test.java','native2');const native=await ids();assert.notEqual(native.android,server.android);assert.equal(native.web,server.web);
  await write('data/dictionary/readage/manifest.json','dictionary-v2');const dictionary=await ids();for(const p of Object.keys(dictionary))assert.notEqual(dictionary[p],native[p],p);
  await write('package-lock.json',JSON.stringify({packages:{'node_modules/react':{version:'19.1.0'}}}));const deps=await ids();for(const p of Object.keys(deps))assert.notEqual(deps[p],dictionary[p],p);
  await write('src/types.ts','learning record schema v2');const schema=await ids();for(const p of Object.keys(schema))assert.notEqual(schema[p],deps[p],p+' learning format changes require a compatible shell');
});
