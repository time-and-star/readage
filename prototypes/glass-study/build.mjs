import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const samplePath = path.join(root, 'data/magazines/assets/26c7bf6a62e5b6730ae664b6bdb97a7bdc0e6aa511e2537a22ed0cf79805cb30.jpg');
const result = await build({ entryPoints: [path.join(here, 'main.ts')], bundle: true, minify: true,
  format: 'iife', platform: 'browser', target: 'es2020', write: false });
const sample = `data:image/jpeg;base64,${(await fs.readFile(samplePath)).toString('base64')}`;
const html = (await fs.readFile(path.join(here, 'page.html'), 'utf8'))
  .replace('__SAMPLE_PHOTO__', sample)
  .replace('__STUDY_SCRIPT__', result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script'));
const destination = path.join(root, 'public/glass-seam-study.html');
await fs.writeFile(destination, html);
process.stdout.write(`Standalone comparison saved: ${destination}\n${Buffer.byteLength(html)} bytes\n`);
