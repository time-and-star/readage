import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');
const PNG = Buffer.from([137,80,78,71,13,10,26,10]);

export function pngIconSize(buffer) {
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(PNG) || buffer.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Icon frame must be a PNG.');
  const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20);
  if (width !== height || width < 1 || width > 256) throw new Error('Windows ICO frames must be square and at most 256 pixels.');
  return width;
}

export function createPngIco(frames) {
  const sizes = frames.map(pngIconSize);
  if (!frames.length || new Set(sizes).size !== sizes.length || !sizes.includes(256)) throw new Error('A Windows ICO needs unique sizes including 256 pixels.');
  const header = Buffer.alloc(6 + 16 * frames.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  let offset = header.length;
  frames.forEach((frame, index) => {
    const entry = 6 + index * 16;
    header[entry] = header[entry + 1] = sizes[index] === 256 ? 0 : sizes[index];
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(frame.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += frame.length;
  });
  return Buffer.concat([header, ...frames]);
}

export async function buildDesktopIcons() {
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(root, 'scripts/build-brand-assets.ps1')], { cwd: root, stdio: 'inherit', windowsHide: true });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Desktop icon resizing failed (exit code ${code}).`)));
  });
  const sources = [16,32,48,128,256].map(size => `desktop/resources/readge-icon-${size}.png`);
  const frames = await Promise.all(sources.map(source => fs.readFile(path.join(root, source))));
  const ico = createPngIco(frames);
  const directory = path.join(root, 'desktop/resources');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'readge.ico'), ico);
  await fs.writeFile(path.join(directory, 'readge.png'), frames.at(-1));
  const original = await fs.readFile(path.join(root, 'assets/brand/readge-icon.png'));
  const manifest = { schemaVersion: 1, name: 'ReadAge', source: 'assets/brand/readge-icon.png',
    sourceSha256: sha256(original), sourceNote: 'Shared ReadAge logo with exterior background removed for transparent icons across desktop, web and mobile.',
    ico: { file: 'readge.ico', bytes: ico.length, sha256: sha256(ico) },
    window: { file: 'readge.png', bytes: frames.at(-1).length, sha256: sha256(frames.at(-1)) },
    frames: frames.map((frame, index) => ({ size: pngIconSize(frame), source: sources[index], bytes: frame.length, sha256: sha256(frame) })) };
  await fs.writeFile(path.join(directory, 'icon-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildDesktopIcons();
  console.log(JSON.stringify({ icon: result.ico, window: result.window, sizes: result.frames.map(frame => frame.size) }, null, 2));
}
