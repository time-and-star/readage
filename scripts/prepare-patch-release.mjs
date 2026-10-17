import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sign, createPublicKey } from 'node:crypto';
import { safePatchPath, validatePatch, PATCH_PREFIX, PATCH_MANIFEST_MAX } from '../website/patch-protocol.mjs';
import { verifyPatchEnvelope, patchHash } from '../server/patchStore.mjs';

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
  throw new Error('小更新发布已停用。请发布最新版 Windows / Android 完整安装包及对应版本信息。');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
