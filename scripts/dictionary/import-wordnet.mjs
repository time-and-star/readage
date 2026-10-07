import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';

export const WORDNET_URL = 'https://wordnetcode.princeton.edu/wn3.1.dict.tar.gz';
export const WORDNET_SHA256 = '3f7d8be8ef6ecc7167d39b10d66954ec734280b5bdcd57f7d9eafe429d11c22a';
export const WORDNET_FILES = ['noun', 'verb', 'adj', 'adv'].flatMap(pos => [`index.${pos}`, `data.${pos}`]);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** Read only the fixed data files. Tar paths are never used as output paths. */
export function unpackWordNet(archive) {
  if (archive.length > 40 * 1024 * 1024 || sha256(archive) !== WORDNET_SHA256) {
    throw new Error('WordNet 3.1 archive checksum does not match the pinned official release.');
  }
  const tar = gunzipSync(archive, { maxOutputLength: 128 * 1024 * 1024 });
  const files = new Map();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    if (!name) break;
    const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/s, '').trim();
    if (!/^[0-7]+$/.test(sizeText)) throw new Error('Invalid WordNet tar size.');
    const size = parseInt(sizeText, 8);
    if (offset + 512 + size > tar.length) throw new Error('Truncated WordNet archive.');
    const outputName = WORDNET_FILES.find(file => name === `dict/${file}`);
    if (outputName) {
      if (header[156] !== 0 && header[156] !== 48) throw new Error('Dictionary data must be a regular file.');
      if (files.has(outputName)) throw new Error('Duplicate dictionary data file.');
      files.set(outputName, tar.subarray(offset + 512, offset + 512 + size));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (files.size !== WORDNET_FILES.length) throw new Error('The WordNet archive is missing required dictionary files.');
  // The official 3.1 dict-only release embeds its complete license in every file header.
  const license = files.get('data.noun').toString('utf8').split('\n')
    .filter(line => /^  \d+ /.test(line)).map(line => line.replace(/^  \d+ /, '')).join('\n').trim() + '\n';
  if (!license.includes('WordNet 3.1 Copyright 2011') || !license.includes('LICENSEE agrees to preserve same.')) {
    throw new Error('WordNet copyright and license header is incomplete.');
  }
  files.set('LICENSE.txt', Buffer.from(license));
  return files;
}

export async function importWordNet({ archivePath, outputDir = 'data/dictionary/imported/wordnet-3.1' } = {}) {
  let archive;
  if (archivePath) archive = await fs.readFile(archivePath);
  else {
    const response = await fetch(WORDNET_URL, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Official WordNet download failed (${response.status}).`);
    archive = Buffer.from(await response.arrayBuffer());
  }
  const files = unpackWordNet(archive);
  const headwords = new Set();
  let senseCount = 0;
  for (const file of WORDNET_FILES.filter(file => file.startsWith('index.'))) {
    for (const line of files.get(file).toString('utf8').split('\n')) {
      if (!line || /^\s/.test(line)) continue;
      const [lemma, , count] = line.trim().split(/\s+/);
      headwords.add(lemma);
      senseCount += Number(count);
    }
  }
  const manifest = { format: 'wordnet-import.v1', release: '3.1', sourceUrl: WORDNET_URL,
    archiveSha256: WORDNET_SHA256, headwordCount: headwords.size, senseCount,
    files: Object.fromEntries([...files].map(([name, bytes]) => [name, { bytes: bytes.length, sha256: sha256(bytes) }])) };
  await fs.mkdir(outputDir, { recursive: true });
  for (const [name, bytes] of files) await fs.writeFile(path.join(outputDir, name), bytes);
  // Written last, so an interrupted import is reported as unavailable, rather than a partial dictionary.
  await fs.writeFile(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.some((arg, index) => index % 2 === 0 && !['--archive', '--output'].includes(arg)) || args.length % 2) {
    throw new Error('Usage: npm run dictionary:import-wordnet -- [--archive file.tar.gz] [--output directory]');
  }
  const options = Object.fromEntries(Array.from({ length: args.length / 2 }, (_, index) => [args[index * 2], args[index * 2 + 1]]));
  const result = await importWordNet({ archivePath: options['--archive'], outputDir: options['--output'] });
  console.log(`WordNet ${result.release}: ${result.headwordCount} headwords, ${result.senseCount} indexed senses imported.`);
}
