import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { generateKeyPairSync } from 'node:crypto';
import { PatchStore } from '../server/patchStore.mjs';
import { createPatchRouter, patchWatchdog, patchIndex } from '../server/patchRoutes';
import { createPatchRelease } from '../scripts/prepare-patch-release.mjs';
import { createWebsiteServer } from '../website/server.mjs';
import { isOfflineApiAllowed } from '../server/offline';

test('real publisher → website files → authorized Node patch API → trial entry and confirmation', async t => {
  await fs.mkdir('tmp/patch-http-tests', { recursive: true }); const root = await fs.mkdtemp(path.resolve('tmp/patch-http-tests/run-'));
  const servers: http.Server[] = [];
  t.after(async () => { for (const server of servers) { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); } await fs.rm(root, { recursive: true, force: true }); });
  const listen = async (server: http.Server) => { servers.push(server); await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); return 'http://127.0.0.1:' + (server.address() as any).port; };
  const key = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const shell = { platform: 'windows', runtime: 'a'.repeat(64), publicKey: key.publicKey, version: '1.0.0' };
  const base = path.join(root,'base'), next = path.join(root,'next'), data = path.join(root,'website');
  for(const dir of [base,next]) { await fs.mkdir(dir,{recursive:true}); await fs.writeFile(path.join(dir,'readage-shell.json'),JSON.stringify(shell)); }
  await fs.writeFile(path.join(base,'index.html'),'<html><head></head><body>old</body></html>');
  await fs.writeFile(path.join(next,'index.html'),'<html><head></head><body>new reader</body></html>');
  await createPatchRelease({directory:next,output:path.join(data,'patches'),platform:'windows',revision:1,version:'1.0.1',privateKey:key.privateKey});
  const website = await createWebsiteServer({dataDirectory:data}); const remote=await listen(website); const forwarded:any[]=[];
  const store=await new PatchStore({directory:path.join(root,'updates'),baseDirectory:base,shell,origin:'https://readage.xyz',fetcher:async(url,init)=>{
    forwarded.push({url,init}); return fetch(remote+new URL(url).pathname,init);
  },trialMs:60_000}).initialize(); t.after(()=>store.close());
  const app=express();app.use(express.json());app.use(patchWatchdog(store));
  app.use('/api/app-updates',(req,res,next)=>req.headers['x-api-token']==='isolated-token'?next():res.sendStatus(401),createPatchRouter(store));
  app.get(['/', '/index.html'],patchIndex(store,base));app.use((req,res,next)=>express.static(store.activeDirectory,{index:false})(req,res,next));
  const local=await listen(http.createServer(app));
  const post=async(action:string,value={})=>fetch(local+'/api/app-updates/'+action,{method:'POST',headers:{'Content-Type':'application/json','x-api-token':'isolated-token',Cookie:'learning=private'},body:JSON.stringify(value)});
  assert.equal((await fetch(local+'/api/app-updates/prepare',{method:'POST'})).status,401);
  assert.match(await (await fetch(local)).text(),/old/);
  const prepared=await (await post('prepare',{revision:1})).json();assert.ok(prepared.pending);assert.equal(prepared.downloadedBytes,Buffer.byteLength('<html><head></head><body>new reader</body></html>'));
  assert.match(await(await fetch(local)).text(),/old/);
  assert.equal((await post('activate',{id:'invalid'})).status,400);
  assert.equal((await post('activate',{id:prepared.pending})).status,200);
  const html=await(await fetch(local)).text();assert.match(html,/new reader/);assert.match(html,/__readage-update-watch\.js\?id=[a-f0-9]{64}/);
  const health=await(await fetch(local+'/__readage-update-health')).json();assert.equal(health.trial,true);
  await post('ready',{id:'stale'});assert.equal((await store.status()).trial,true);
  await post('ready',{id:prepared.pending});assert.equal((await store.status()).trial,false);
  assert.equal((await post('status')).status,200);
  for(const request of forwarded){assert.equal(new URL(request.url).origin,'https://readage.xyz');assert.deepEqual(request.init.headers,{Accept:'application/octet-stream'});assert.equal(request.init.redirect,'error');}
  for(const suffix of ['../update-signing-private.pem','files/nope','windows.json','state.json'])assert.equal((await fetch(remote+'/api/updates/patches/'+suffix)).status,404);
  assert.equal((await fetch(remote+'/api/updates/patches/windows',{method:'POST'})).status,405);
});
test('only explicit patch operations pass installed-app offline boundary',()=>{
  for(const action of ['status','prepare','cancel','activate','ready'])assert.equal(isOfflineApiAllowed('/api/app-updates/'+action,'POST'),true);
  for(const action of ['fetch','download-any-url','files','prepare/other'])assert.equal(isOfflineApiAllowed('/api/app-updates/'+action,'POST'),false);
  assert.equal(isOfflineApiAllowed('/api/app-updates/prepare','GET'),false);
});
