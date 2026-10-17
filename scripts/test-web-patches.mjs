import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { androidToolchainEnvironment } from './android-toolchain.mjs';
import { createPatchRelease } from './prepare-patch-release.mjs';
import { compileAndroidUpdateApi } from './android-update-api-check.mjs';

const root = process.cwd(), output = path.join(root, 'tmp/android-tools/web-patch-tests');
await fs.mkdir(output, { recursive: true });
const fixture = await fs.mkdtemp(path.join(output, 'run-'));
const keys = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const shell = { platform: 'android', runtime: 'a'.repeat(64), publicKey: keys.publicKey, version: '1.0.0' };
for (const folder of ['base/public', 'next']) {
  const directory = path.join(fixture, folder); await fs.mkdir(path.join(directory, 'assets'), { recursive: true });
  await fs.writeFile(path.join(directory, 'readage-shell.json'), JSON.stringify(shell));
  await fs.writeFile(path.join(directory, 'index.html'), '<html><head></head><body>reader</body></html>');
  await fs.writeFile(path.join(directory, 'assets/unchanged.js'), 'same dependency');
}
await fs.writeFile(path.join(fixture, 'base/public/assets/deleted.js'), 'obsolete');
await fs.writeFile(path.join(fixture, 'next/assets/new.js'), 'new feature');
const publish = revision => createPatchRelease({ directory: path.join(fixture,'next'), output: path.join(fixture,'v'+revision), platform:'android',revision,version:'1.0.'+revision,privateKey:keys.privateKey });
await publish(1); await fs.writeFile(path.join(fixture,'next/assets/newer.js'),'second feature'); await publish(2);
const original = JSON.parse(await fs.readFile(path.join(fixture,'v1/manifests/android.json'),'utf8'));
for (const mode of ['bad-signature','incompatible']) {
  const envelope = structuredClone(original);
  if(mode==='bad-signature')envelope.signature='bad';else{
    const payload=JSON.parse(Buffer.from(envelope.payload,'base64'));payload.runtime='b'.repeat(64);const bytes=Buffer.from(JSON.stringify(payload));
    envelope.payload=bytes.toString('base64');envelope.signature=sign('RSA-SHA256',bytes,keys.privateKey).toString('base64');
  }
  await fs.mkdir(path.join(fixture,mode,'manifests'),{recursive:true}); await fs.writeFile(path.join(fixture,mode,'manifests/android.json'),JSON.stringify(envelope));
}
const env=androidToolchainEnvironment();
function run(name,args){const result=spawnSync(path.join(env.JAVA_HOME,'bin',name+(process.platform==='win32'?'.exe':'')),args,{cwd:root,env,encoding:'utf8',windowsHide:true});process.stdout.write((result.stdout||'')+(result.stderr||''));if(result.status!==0)process.exit(result.status||1);}
const source='android/app/src/main/java/cn/readage/app/';
const classes=path.join(output,'classes');await fs.mkdir(classes,{recursive:true});
const jsonJar=path.join(root,'tmp/android-tools/host-tests/lib/android-json.jar');
run('javac',['-encoding','UTF-8','-cp',jsonJar,'-d',classes,source+'WebPatchEngine.java','tests/android-document-host/WebPatchEngineTest.java']);
run('java',['-cp',[classes,jsonJar].join(path.delimiter),'cn.readage.app.WebPatchEngineTest',fixture]);
await compileAndroidUpdateApi(classes);
console.log('Android activity / bridge source API compilation passed. Fixtures: '+fixture);
run('javac',['-encoding','UTF-8','-cp',jsonJar,'-d',classes,source+'NativeAppUpdateHttp.java',source+'NativeInstallerUpdate.java','tests/android-document-host/NativeInstallerUpdateTest.java']);
run('java',['-cp',[classes,jsonJar].join(path.delimiter),'cn.readage.app.NativeInstallerUpdateTest',path.join(fixture,'installer-checks')]);
