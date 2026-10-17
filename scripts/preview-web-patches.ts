/** Isolated source-component preview. No product build, real profile, production key or public deployment. */
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { generateKeyPairSync } from 'node:crypto';
import { createServer as createVite } from 'vite';
import { PatchStore } from '../server/patchStore.mjs';
import { createPatchRouter, patchWatchdog, patchIndex } from '../server/patchRoutes';
import { createPatchRelease } from './prepare-patch-release.mjs';

const root=path.resolve('tmp/patch-ui-preview');await fs.mkdir(root,{recursive:true});const fixture=await fs.mkdtemp(path.join(root,'run-'));
const keys=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});
const shell={platform:'web',runtime:'a'.repeat(64),publicKey:keys.publicKey,version:'1.0.0'};
const base=path.join(fixture,'base'),next=path.join(fixture,'next'),published=path.join(fixture,'published');
for(const dir of [base,next]){await fs.mkdir(path.join(dir,'assets'),{recursive:true});await fs.writeFile(path.join(dir,'readage-shell.json'),JSON.stringify(shell));await fs.writeFile(path.join(dir,'assets/unchanged.js'),'same dependency');}
await fs.writeFile(path.join(next,'index.html'),'<html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>小更新已生效 · 隔离验收</title></head><body><h1>小更新已生效</h1><p id="status">正在确认启动</p><a href="/preview">返回更新检测页</a><script src="/assets/ready.js"></script></body></html>');
await fs.writeFile(path.join(next,'assets/ready.js'),"(async()=>{const r=await fetch('/api/app-updates/status',{method:'POST'});const s=await r.json();await fetch('/api/app-updates/ready',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:s.id})});document.getElementById('status').textContent='当前小更新 '+s.revision+'；学习标记：'+localStorage.getItem('patch-test-learning');})();");
let revision=1,mode='normal';
let bundle=await createPatchRelease({directory:next,output:published,platform:'web',revision,version:'1.0.1',privateKey:keys.privateKey});
const store=await new PatchStore({directory:path.join(fixture,'updates'),baseDirectory:base,shell,origin:'https://readage.xyz',fetcher:async(url,init)=>{
  if(mode==='offline')throw new Error('隔离断网');
  if(mode==='slow'){await new Promise<void>((resolve,reject)=>{const timer=setTimeout(resolve,7000);init.signal.addEventListener('abort',()=>{clearTimeout(timer);reject(new Error('已取消'));},{once:true});});}
  const suffix=new URL(url).pathname.split('/patches/')[1];return new Response(await fs.readFile(path.join(published,suffix.startsWith('files/')?suffix:'manifests/'+suffix+'.json')));
},trialMs:5000}).initialize();
const app=express();app.use(express.json());app.use(patchWatchdog(store));app.use('/api/app-updates',createPatchRouter(store));
app.post('/__scenario',async(req,res)=>{mode=['normal','offline','slow','incompatible','long'].includes(req.body.mode)?req.body.mode:'normal';if(req.body.next){revision++;bundle=await createPatchRelease({directory:next,output:published,platform:'web',revision,version:'1.0.'+revision,privateKey:keys.privateKey});}res.json({ok:true});});
app.post('/api/app-updates/check',(_req,res)=>res.json({schemaVersion:1,releases:Object.fromEntries(['web','windows','android'].map(p=>[p,{version:mode==='incompatible'?'2.0.0':'1.0.0',build:mode==='incompatible'?7:6,publishedAt:'2026-10-17T00:00:00Z',notes:mode==='long'?Array.from({length:20},(_,i)=>`第 ${i+1} 项：`+'阅读与学习功能完整保留。'.repeat(5)):['只下载变化文件，原有学习记录保留。','正式模型及词典继续从原位置读取。'],bundle:{...bundle,...(mode==='incompatible'?{runtime:'b'.repeat(64)}:{})}}]))}));
const vite=await createVite({server:{middlewareMode:true,hmr:false,watch:null},appType:'custom'});
const source=path.join(fixture,'main.tsx');
await fs.writeFile(source,`import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{AppUpdateCard,AppUpdateNotice}from'../../../src/components/AppUpdateCard';import{useAppUpdates}from'../../../src/lib/useAppUpdates';import'../../../src/components/appUpdates.css';function Demo(){const u=useAppUpdates();const[mode,setMode]=useState('normal');const scenario=async(m,next=false)=>{await fetch('/__scenario',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:m,next})});setMode(m);u.check();};return <><main style={{fontFamily:'system-ui',padding:24}}><h1>小更新 · 隔离源码验收</h1><p>当前版本 {u.current.version} / revision {u.current.revision||0}</p><p>仅使用临时文件和合成学习标记。</p><button onClick={()=>{localStorage.setItem('patch-test-learning','阅读进度保留');void scenario('normal');}}>检查小更新</button> <button onClick={()=>void scenario('slow')}>慢下载与取消</button> <button onClick={()=>void scenario('offline')}>下载断网</button> <button onClick={()=>void scenario('incompatible')}>外壳不兼容</button> <button onClick={()=>void scenario('long')}>长说明</button> <button onClick={()=>void scenario('normal',true)}>下一小版本</button><p>模式：{mode}</p></main>{u.available&&<AppUpdateCard key={u.available.release.bundle?.revision+mode} available={u.available} onDecline={u.decline}/>} {u.notice&&<AppUpdateNotice message={u.notice}onClose={u.clearNotice}/>}</>};createRoot(document.getElementById('root')).render(<Demo/>);`);
const preview=async(_req,res)=>res.type('html').send(await vite.transformIndexHtml('/',`<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>ReadAge 小更新 · 隔离源码验收</title></head><body style="margin:0;background:#f8f6f0"><div id="root"></div><script type="module" src="/${path.relative(process.cwd(),source).replaceAll('\\','/')}"></script></body></html>`));
app.get('/preview',preview);app.get('/',(req,res,next)=>store.state.active?patchIndex(store,base)(req,res,next):preview(req,res));
app.use((req,res,next)=>express.static(store.activeDirectory,{index:false})(req,res,next));app.use(vite.middlewares);
const server=http.createServer(app);server.listen(3194,'127.0.0.1',()=>console.log('Patch source preview http://127.0.0.1:3194/; isolated fixture '+fixture));
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{store.close();server.closeAllConnections();await vite.close();server.close(()=>process.exit(0));});
