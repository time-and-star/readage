import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, generateKeyPairSync, sign, createPublicKey } from 'node:crypto';
import { safePatchPath, validatePatch, PATCH_PREFIX, PATCH_MANIFEST_MAX } from '../website/patch-protocol.mjs';
import { verifyPatchEnvelope, patchHash } from '../server/patchStore.mjs';
import { updateRuntime } from './update-shell.mjs';
import { assertBuildCurrent } from './platform-build-info.mjs';

export async function createPatchRelease({ directory, output, platform, revision, version, privateKey }) {
  const shell = JSON.parse(await fs.readFile(path.join(directory, 'readage-shell.json'), 'utf8'));
  if (shell.platform !== platform || createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }) !== shell.publicKey) throw new Error('发布签名密钥与应用信任密钥不匹配。');
  const files = [];
  async function walk(relative = '') {
    for (const entry of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
      const name = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isSymbolicLink()) throw new Error('发布目录不能包含链接。');
      if (entry.isDirectory()) await walk(name);
      else if (safePatchPath(name)) files.push({ path: name, bytes: (await fs.stat(path.join(directory, name))).size, sha256: await patchHash(path.join(directory, name)) });
      else if (!['server.mjs', 'readage-shell.json', 'readge-build.json'].includes(name) && !name.endsWith('.map') && !name.split('/').some(p => p.startsWith('.'))) throw new Error(`小更新不支持此资源，不能省略交付：${name}。请补全资源类型或发布完整安装版。`);
    }
  }
  await walk(); files.sort((a,b) => a.path.localeCompare(b.path, 'en'));
  const payload = Buffer.from(JSON.stringify(validatePatch({ schema: 1, kind: 'readage-web-patch', platform, runtime: shell.runtime, revision, version, files })));
  const envelope = Buffer.from(JSON.stringify({ payload: payload.toString('base64'), signature: sign('RSA-SHA256', payload, privateKey).toString('base64') }));
  if (envelope.length > PATCH_MANIFEST_MAX) throw new Error('发布清单过大。');
  const manifests = path.join(output, 'manifests'); await fs.mkdir(manifests, { recursive: true }); await fs.mkdir(path.join(output, 'files'), { recursive: true });
  const previous = await fs.readFile(path.join(manifests, platform + '.json')).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (previous && verifyPatchEnvelope(previous, shell.publicKey).revision >= revision) throw new Error('发布 revision 必须递增。');
  for (const file of files) {
    const destination = path.join(output, 'files', file.sha256);
    try { await fs.copyFile(path.join(directory, file.path), destination, 1); }
    catch (error) { if (error.code !== 'EEXIST' || await patchHash(destination) !== file.sha256) throw error; }
  }
  const filename = path.join(manifests, platform + '.json');
  await fs.writeFile(filename + '.tmp', envelope); await fs.rename(filename + '.tmp', filename);
  return { revision, runtime: shell.runtime, version, bytes: files.reduce((sum,f) => sum + f.bytes, 0), manifest: PATCH_PREFIX + '/' + platform };
}
async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const args = process.argv.slice(2); const option = name => args[args.indexOf(name) + 1];
  const keyFile = process.env.READAGE_UPDATE_SIGNING_KEY || path.join(root, 'website/.data/update-signing-private.pem');
  if (args.includes('--init-key')) {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 3072, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    await fs.mkdir(path.dirname(keyFile), { recursive: true }); await fs.mkdir(path.join(root, 'config'), { recursive: true });
    // Exclusive writes: never silently replace a release signing identity.
    await fs.writeFile(keyFile, privateKey, { flag: 'wx', mode: 0o600 });
    await fs.writeFile(path.join(root, 'config/update-trust.json'), JSON.stringify({ publicKey }, null, 2) + '\n', { flag: 'wx' });
    console.log('已初始化小更新签名。请备份私钥；私钥不会打入应用或公开下载。'); return;
  }
  const platform = option('--platform');
  if (!['web', 'windows', 'android'].includes(platform)) throw new Error('请指定 --platform web|windows|android --revision 整数 --version x.y.z');
  const directory = path.join(root, platform === 'android' ? 'dist-android' : 'dist');
  const recordPlatform = platform === 'windows' ? 'desktop' : platform;
  const build = JSON.parse(await fs.readFile(path.join(root, 'build/platforms/' + recordPlatform + '-build.json'), 'utf8'));
  await assertBuildCurrent(root, build);
  const shell = JSON.parse(await fs.readFile(path.join(directory, 'readage-shell.json'), 'utf8'));
  if (shell.runtime !== await updateRuntime(root, platform)) throw new Error('构建已不匹配当前原生 / 服务源码，请先构建对应端。');
  const patch = await createPatchRelease({ directory, output: path.join(root, 'website/.data/patches'), platform,
    revision: Number(option('--revision')), version: option('--version'), privateKey: await fs.readFile(keyFile, 'utf8') });
  console.log(JSON.stringify({ platform, bundle: patch, note: '审核后将 bundle 字段写入 releases.json 对应端；本命令不会自动上线。' }, null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
