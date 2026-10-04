import { build } from 'esbuild';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import JSZip from 'jszip';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.dirname(fileURLToPath(import.meta.url));
const outdir = path.join(root, 'dist');
await mkdir(outdir, { recursive: true });
await build({ entryPoints: ['background', 'content', 'bridge', 'popup'].map(name => path.join(root, `${name}.ts`)),
  absWorkingDir: root, tsconfig: path.join(root, 'tsconfig.json'),
  bundle: true, outdir, format: 'iife', platform: 'browser', target: 'chrome120', sourcemap: true });
for (const name of ['manifest.json', 'popup.html', 'popup.css']) await copyFile(path.join(root, name), path.join(outdir, name));
await mkdir(path.join(outdir, 'icons'), { recursive: true });
const icons = [16, 32, 48, 128].map(size => `icons/icon-${size}.png`);
for (const name of icons) await copyFile(path.join(root, name), path.join(outdir, name));
const zip = new JSZip();
for (const name of ['manifest.json', 'popup.html', 'popup.css', 'background.js', 'content.js', 'bridge.js', 'popup.js', ...icons]) {
  zip.file(name, await readFile(path.join(outdir, name)));
}
const archive = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
const publicDir = path.join(root, '..', 'public');
await mkdir(publicDir, { recursive: true });
await writeFile(path.join(publicDir, 'readage-extension.zip'), archive);
try { await writeFile(path.join(root, '..', 'dist', 'readage-extension.zip'), archive); } catch (error) { if (error.code !== 'ENOENT') throw error; }
console.log(`扩展安装目录：${outdir}`);
