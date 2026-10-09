import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { englishLanguageAdapter } from '../../packages/dictionary/languages/english';
import type { ReadAgePackIndex, ReadAgeWord } from '../../packages/dictionary/readage';

/** Load exactly the active data scripts, in their published order, never backup files. */
export function assembleReadAge(sourceDirectory: string) {
  const root = path.resolve(sourceDirectory);
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const files = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/g)]
    .map(match => match[1].split('?')[0]).filter(file => /^assets\/js\/(core|data)\//.test(file));
  if (!files.includes('assets/js/data/registry.js')) throw new Error('ReadAge 数据装配入口缺失。');
  const context = vm.createContext({ console, performance,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} } });
  const sourceHash = createHash('sha256').update(html);
  for (const file of files) {
    const resolved = path.resolve(root, file);
    if (!resolved.startsWith(root + path.sep)) throw new Error('数据脚本路径超出词典目录。');
    const code = fs.readFileSync(resolved, 'utf8');
    sourceHash.update(file).update(code);
    // Each file has the same private scope as ReadAge's Node data checks.
    vm.runInContext(`(function(){\n${code}\n})();`, context, { filename: file, timeout: 10000 });
  }
  const dictionary = context.RA.dictionary;
  const issues: string[] = dictionary.issues();
  if (issues.length) throw new Error(`ReadAge 数据校验失败：${issues.slice(0, 10).join('；')}`);
  const words = Object.values(dictionary.words()) as ReadAgeWord[];
  if (!words.length || words.some(word => word.tier === 'pending' || !word.senses.length)) throw new Error('词库为空或仍含待编占位词条。');
  return { words, files, sourceHash: sourceHash.digest('hex') };
}

export function importReadAge(sourceDirectory: string, outputDirectory = path.resolve('data/dictionary/readage')) {
  const { words, files, sourceHash } = assembleReadAge(sourceDirectory);
  const output = path.resolve(outputDirectory);
  fs.mkdirSync(output, { recursive: true });
  const index: ReadAgePackIndex = { format: 'readage-index.v1', entries: [], forms: Object.create(null) };
  const dataHash = createHash('sha256');
  let offset = 0;
  const file = fs.openSync(path.join(output, 'entries.pack.tmp'), 'w');
  try {
    for (const word of words) {
      const line = gzipSync(Buffer.from(JSON.stringify(word)), { level: 6 });
      fs.writeSync(file, line);
      dataHash.update(line);
      index.entries.push({ id: word.id, headword: word.lemma, offset, length: line.length });
      offset += line.length;
      for (const form of word.forms) {
        const key = englishLanguageAdapter.normalize(form.form);
        if (!key) continue;
        const previous = index.forms[key];
        index.forms[key] = previous === undefined || previous === word.id ? word.id : null;
      }
    }
  } finally { fs.closeSync(file); }
  const indexBytes = Buffer.from(JSON.stringify(index));
  const manifest = { format: 'readage-authored-pack.v1', name: 'ReadAge 自编词典',
    entryCount: words.length, senseCount: words.reduce((total, word) => total + word.senses.length, 0),
    pendingCount: 0, encoding: 'gzip-blocks', dataBytes: offset, dataSha256: dataHash.digest('hex'),
    indexSha256: createHash('sha256').update(indexBytes).digest('hex'), sourceHash, scripts: files,
    source: 'ReadAge 项目自编词条，按 index.html 的当前数据脚本完整装配。',
  };
  fs.writeFileSync(path.join(output, 'index.json.tmp'), indexBytes);
  fs.writeFileSync(path.join(output, 'manifest.json.tmp'), JSON.stringify(manifest, null, 2) + '\n');
  for (const name of ['entries.pack', 'index.json', 'manifest.json']) fs.renameSync(path.join(output, name + '.tmp'), path.join(output, name));
  return manifest;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const source = process.argv[2];
  if (!source) throw new Error('用法：npm run dictionary:import-readage -- <ReadAge 项目目录> [输出目录]');
  const manifest = importReadAge(source, process.argv[3]);
  console.log(JSON.stringify({ entryCount: manifest.entryCount, senseCount: manifest.senseCount, dataBytes: manifest.dataBytes, sourceHash: manifest.sourceHash }));
}
