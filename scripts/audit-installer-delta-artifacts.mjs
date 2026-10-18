/** Read existing historical installers, reconstruct inside a fresh audit directory, never execute/install/publish. */
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { prepareInstallerDeltas } from './prepare-installer-deltas.mjs';
import { androidToolchainEnvironment } from './android-toolchain.mjs';
import { InstallerUpdate } from '../desktop/installer-update.mjs';
import { deltaFilename } from '../website/installer-delta-protocol.mjs';

const root=process.cwd(), parent=path.resolve('output/installer-delta-capability-2026-10-18');
await fs.mkdir(parent,{recursive:true});
const directory=await fs.mkdtemp(path.join(parent,'run-'));
const report={passed:false,scope:'Existing GB-scale historical installers, production delta generator and Windows/Android engines; local file-backed transport, no network speed/device/system installation claims.',directory,cases:[]};
const save=()=>fs.writeFile(path.join(directory,'report.json'),JSON.stringify(report,null,2));
await save();console.log('Audit directory: '+directory);
const latest=JSON.parse(await fs.readFile('output/full-release-0.1.6/releases.json','utf8'));
const previous=JSON.parse(await fs.readFile('output/in-app-updates-2026-10-17/releases.json','utf8'));
const space=await fs.statfs(directory,{bigint:true});
assert.ok(space.bavail*space.bsize>10n*1024n**3n,'Need 10 GiB free for isolated real-package proof');
const env=androidToolchainEnvironment(), javaOutput=path.join(directory,'java'), jsonJar=path.resolve('tmp/android-tools/host-tests/lib/android-json.jar');
await fs.mkdir(javaOutput);
async function runJava(tool,args){
  await new Promise((resolve,reject)=>{
    const child=spawn(path.join(env.JAVA_HOME,'bin',tool+(process.platform==='win32'?'.exe':'')),args,{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',data=>process.stdout.write(data));child.stderr.on('data',data=>process.stderr.write(data));child.on('error',reject);
    child.on('exit',code=>code===0?resolve():reject(new Error(tool+' exited '+code)));
  });
}
async function compareFiles(left,right){
  const a=await fs.open(left,'r'),b=await fs.open(right,'r');
  try{
    const size=(await a.stat()).size;assert.equal((await b.stat()).size,size);
    const first=Buffer.alloc(1024*1024),second=Buffer.alloc(first.length);
    for(let offset=0;offset<size;offset+=first.length){
      const length=Math.min(first.length,size-offset);
      for(const [handle,buffer] of [[a,first],[b,second]]){
        let received=0;while(received<length){const read=await handle.read(buffer,received,length-received,offset+received);assert.ok(read.bytesRead>0);received+=read.bytesRead;}
      }
      assert.ok(first.subarray(0,length).equals(second.subarray(0,length)),'Mismatch at chunk '+offset);
    }
  }finally{await a.close();await b.close();}
}
const scenarios=[
  {platform:'windows',target:path.resolve('build/desktop/ReadAge-0.1.6-windows-x64-setup.exe'),targetMap:path.resolve('build/desktop/ReadAge-0.1.6-windows-x64-setup.exe.blockmap'),bases:[
    {version:'0.1.1',installer:path.resolve('build/desktop/readge-0.1.1-windows-x64-setup.exe')},
    {version:'0.1.5',installer:path.resolve('build/desktop/ReadAge-0.1.5-windows-x64-setup.exe'),sha256:previous.releases.windows.installer.sha256},
  ]},
  {platform:'android',target:path.resolve('output/full-release-0.1.6/ReadAge-1.0.8-android.apk'),targetMap:path.resolve('output/full-release-0.1.6/android.blockmap'),bases:[
    {version:'1.0.6',installer:path.resolve('output/in-app-updates-2026-10-17/base-1.0.6.apk'),blockmap:path.resolve('output/in-app-updates-2026-10-17/base-android.blockmap')},
    {version:'1.0.7',installer:path.resolve('output/full-release-0.1.6/base-1.0.7.apk'),blockmap:path.resolve('output/full-release-0.1.6/base-android.blockmap'),sha256:previous.releases.android.installer.sha256},
  ]},
];
try{
  await runJava('javac',['-encoding','UTF-8','-cp',jsonJar,'-d',javaOutput,'android/app/src/main/java/cn/readage/app/NativeAppUpdateHttp.java','android/app/src/main/java/cn/readage/app/NativeInstallerUpdate.java','tests/android-document-host/NativeInstallerUpdateArtifactAudit.java']);
  for(const scenario of scenarios){
    const release=latest.releases[scenario.platform],payloadDirectory=path.join(directory,scenario.platform+'-payloads');
    let start=performance.now();console.log('Generating '+scenario.platform+' deltas from '+scenario.bases.map(base=>base.version).join(', '));
    const prepared=await prepareInstallerDeltas({target:scenario.target,targetMap:scenario.targetMap,filename:release.installer.filename,targetSha256:release.installer.sha256,bases:scenario.bases,outputDirectory:payloadDirectory});
    assert.equal(prepared.skipped.length,0);assert.equal(prepared.installer.deltas.length,scenario.bases.length);
    const generationSeconds=(performance.now()-start)/1000;
    const manifest=structuredClone(latest);manifest.releases[scenario.platform].installer=prepared.installer;
    const manifestPath=path.join(directory,scenario.platform+'-manifest.json');await fs.writeFile(manifestPath,JSON.stringify(manifest));
    for(let index=0;index<scenario.bases.length;index++){
      const base=scenario.bases[index],delta=prepared.installer.deltas[index];
      const job=path.join(directory,scenario.platform+'-'+base.version);await fs.mkdir(job);
      let result;
      if(scenario.platform==='windows'){
        let received=0;const requests=[];
        const fetcher=async(url,options={})=>{
          assert.equal(new URL(url).origin,'https://readage.xyz');
          if(new URL(url).pathname==='/api/updates/latest')return Response.json(manifest);
          const name=path.basename(new URL(url).pathname);assert.notEqual(name,release.installer.filename,'Full installer request is forbidden in this delta audit');
          assert.ok(name===deltaFilename(prepared.installer,delta)||name===deltaFilename(prepared.installer,delta)+'.json','Unexpected baseline payload');
          const file=path.join(payloadDirectory,name),size=(await fs.stat(file)).size;
          const offset=Number((options.headers?.Range||'').match(/^bytes=(\d+)-$/)?.[1]||0);
          requests.push({name,offset});received+=size-offset;
          const stream=createReadStream(file,{start:offset});options.signal?.addEventListener('abort',()=>stream.destroy(),{once:true});
          return new Response(Readable.toWeb(stream),{status:offset?206:200,headers:{'Content-Length':String(size-offset),...(offset?{'Content-Range':`bytes ${offset}-${size-1}/${size}`}:{})}});
        };
        const store=new InstallerUpdate(job,fetcher,{retryDelays:[],baselineSources:{historical:base.installer}});
        start=performance.now();const status=await store.download(release.version,{build:release.build,sha256:release.installer.sha256});
        const prepareSeconds=(performance.now()-start)/1000;assert.equal(status.phase,'ready');assert.equal(status.mode,'delta');
        start=performance.now();const completed=await store.verifiedInstaller(release.version);const finalVerifySeconds=(performance.now()-start)/1000;
        start=performance.now();await compareFiles(scenario.target,completed);const byteCompareSeconds=(performance.now()-start)/1000;
        result={passed:true,engine:'production Windows Node engine; local file-backed HTTPS fixture',receivedBytesExcludingMetadata:received,requests,prepareSeconds,finalVerifySeconds,byteCompareSeconds,byteMismatch:-1,outputRemovedAfterVerification:true};
        assert.equal(path.dirname(await fs.realpath(completed)),await fs.realpath(job));await fs.unlink(completed);
        console.log('PASS real EXE delta: '+base.version+' -> '+release.version+', payload '+delta.bytes+' bytes; exact file match');
      }else{
        const javaReport=path.join(directory,'android-'+base.version+'-report.json');
        await runJava('java',['-Xmx256m','-cp',[javaOutput,jsonJar].join(path.delimiter),'cn.readage.app.NativeInstallerUpdateArtifactAudit',manifestPath,payloadDirectory,base.installer,job,scenario.target,javaReport]);
        result=JSON.parse(await fs.readFile(javaReport,'utf8'));
      }
      report.cases.push({...result,platform:scenario.platform,baseVersion:base.version,targetVersion:release.version,baseSha256:delta.baseSha256,targetSha256:prepared.installer.sha256,targetBytes:prepared.installer.bytes,
        payloadBytes:delta.bytes,descriptorBytes:delta.manifestBytes,downloadBytes:delta.bytes+delta.manifestBytes,reusedPercent:100*(1-(delta.bytes+delta.manifestBytes)/prepared.installer.bytes),generationSecondsForAllBases:generationSeconds});
      await save();
    }
  }
  report.passed=true;await save();console.log('PASS all real-package audits. Report: '+path.join(directory,'report.json'));
}catch(error){report.error=error.stack||String(error);await save();throw error;}
