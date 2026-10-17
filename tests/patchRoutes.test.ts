import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { generateKeyPairSync } from 'node:crypto';
import { PatchStore } from '../server/patchStore.mjs';
import { openPatchStore, createPatchRouter, patchWatchdog, patchIndex } from '../server/patchRoutes';
import { createPatchRelease } from '../scripts/prepare-patch-release.mjs';
import { createWebsiteServer } from '../website/server.mjs';
import { isOfflineApiAllowed } from '../server/offline';

test('retired public and local patch endpoints cannot download, activate or override installed assets', async t => {
  await fs.mkdir('tmp/patch-http-tests', { recursive: true }); const root = await fs.mkdtemp(path.resolve('tmp/patch-http-tests/run-'));
  const servers: http.Server[] = [];
  t.after(async () => { for (const server of servers) { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); } await fs.rm(root, { recursive: true, force: true }); });
  const listen = async (server: http.Server) => { servers.push(server); await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); return 'http://127.0.0.1:' + (server.address() as any).port; };
  const key = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const shell = { platform: 'windows', runtime: 'a'.repeat(64), publicKey: key.publicKey, version: '1.0.0' };
  const base = path.join(root,'base'), data = path.join(root,'website');
  await fs.mkdir(base,{recursive:true}); await fs.writeFile(path.join(base,'readage-shell.json'),JSON.stringify(shell));
  await fs.writeFile(path.join(base,'index.html'),'<html><head></head><body>installed reader</body></html>');
  await createPatchRelease({directory:base,output:path.join(data,'patches'),platform:'windows',revision:1,version:'1.0.1',privateKey:key.privateKey});
  const remote=await listen(await createWebsiteServer({dataDirectory:data}));
  const cached = path.join(root, 'historical-cache.json'), learning = path.join(root, 'learning.json');
  await fs.writeFile(cached, '{"active":"old-patch","trial":true}'); await fs.writeFile(learning, '{"progress":42}');
  const before = await Promise.all([fs.readFile(cached),fs.readFile(learning)]);
  const production = process.env.NODE_ENV; process.env.NODE_ENV='production';
  let store: PatchStore | null;
  try { store=await openPatchStore((async()=>{throw Error('must not fetch a patch');}) as typeof fetch); }
  finally { if(production===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=production; }
  assert.equal(store,null,'production startup must use installed assets');
  const unexpected=()=>{throw Error('retired cache method must not run');};
  const legacy={status:unexpected,prepare:unexpected,activate:unexpected,ready:unexpected} as unknown as PatchStore;
  const app=express();app.use(express.json());app.use(patchWatchdog(null));
  app.use('/api/app-updates',(req,res,next)=>req.headers['x-api-token']==='isolated-token'?next():res.sendStatus(401),createPatchRouter(legacy));
  app.get(['/', '/index.html'],patchIndex(store,base));
  const local=await listen(http.createServer(app));
  const post=async(action:string,value={})=>fetch(local+'/api/app-updates/'+action,{method:'POST',headers:{'Content-Type':'application/json','x-api-token':'isolated-token'},body:JSON.stringify(value)});
  assert.equal((await fetch(local+'/api/app-updates/prepare',{method:'POST'})).status,401);
  const entry = await (await fetch(local)).text();
  assert.match(entry,/installed reader/); assert.doesNotMatch(entry,/__readage-update-watch/);
  assert.deepEqual(await(await post('status')).json(),{enabled:false});
  for(const action of ['prepare','activate']){const response=await post(action,{revision:1,id:'old-patch'});assert.equal(response.status,410);assert.match((await response.json()).error.message,/完整安装包/);}
  for(const action of ['ready','cancel'])assert.equal((await post(action)).status,200);
  const manifest=JSON.parse(await fs.readFile(path.join(data,'patches/manifests/windows.json'),'utf8'));
  const payload=JSON.parse(Buffer.from(manifest.payload,'base64').toString());
  for(const suffix of ['web','windows','android','files/'+payload.files[0].sha256]){
    const response=await fetch(remote+'/api/updates/patches/'+suffix);assert.equal(response.status,410);assert.equal(response.headers.get('cache-control'),'no-store');
    const head=await fetch(remote+'/api/updates/patches/'+suffix,{method:'HEAD'});assert.equal(head.status,410);assert.equal(await head.text(),'');
  }
  assert.equal((await fetch(remote+'/api/updates/patches/windows',{method:'POST'})).status,405);
  assert.equal((await fetch(remote+'/api/updates/patches/files/nope')).status,404);
  assert.deepEqual(await Promise.all([fs.readFile(cached),fs.readFile(learning)]),before,'historical cache and learning records remain untouched');
});

test('only explicit patch operations pass installed-app offline boundary',()=>{
  for(const action of ['status','prepare','cancel','activate','ready'])assert.equal(isOfflineApiAllowed('/api/app-updates/'+action,'POST'),true);
  for(const action of ['fetch','download-any-url','files','prepare/other'])assert.equal(isOfflineApiAllowed('/api/app-updates/'+action,'POST'),false);
  assert.equal(isOfflineApiAllowed('/api/app-updates/prepare','GET'),false);
});
