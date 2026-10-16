import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const androidSpeechSources = [
  { name: 'kokoro-int8-multi-lang-v1_0.tar.bz2', version: '1.0', directory: 'kokoro-int8-multi-lang-v1_0',
    sha256: '4c3052abaa60943a341f193888cf6abd68787dae6ab8ae5c925a706caa247e4e', license: 'Apache-2.0 model; GPL-3.0 eSpeak-ng frontend' },
  { name: 'sherpa-onnx-supertonic-3-tts-int8-2026-05-11.tar.bz2', version: '3 (int8 2026-05-11)', directory: 'sherpa-onnx-supertonic-3-tts-int8-2026-05-11',
    sha256: '82fa96f91c4ef8abaae3a14a3f4153facf88bed821d1f7331cec2700f432c427', license: 'OpenRAIL-M model; MIT inference source' },
  { name: 'sherpa-onnx-1.13.8.aar', version: '1.13.8',
    sha256: '633c24321e06b1fe79feafa03ea16cbc0f8a286641e2da3559bac91bdb13bd96', license: 'Apache-2.0; third-party notices included' },
].map(source => ({ ...source, url: `https://github.com/k2-fsa/sherpa-onnx/releases/download/${source.name.endsWith('.aar') ? 'v1.13.8' : 'tts-models'}/${source.name}` }));
const licenseSources = [
  { name: 'LICENSE-sherpa-onnx.txt', url: 'https://raw.githubusercontent.com/k2-fsa/sherpa-onnx/v1.13.8/LICENSE', sha256: 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30' },
  { name: 'LICENSE-espeak-ng.txt', url: 'https://raw.githubusercontent.com/espeak-ng/espeak-ng/1.52.0/COPYING', sha256: '8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903' },
  { name: 'LICENSE-onnxruntime.txt', url: 'https://raw.githubusercontent.com/microsoft/onnxruntime/v1.23.2/LICENSE', sha256: '2f07c72751aed99790b8a4869cf2311df85a860b22ded05fa22803587a48922c' },
  { name: 'LICENSE-Supertonic-model.txt', url: 'https://huggingface.co/Supertone/supertonic-3/resolve/724fb5abbf5502583fb520898d45929e62f02c0b/LICENSE', sha256: '0d944a9110fed9a9602d60e0423a272903e7bd21ab060490774efc77c2275e9f' },
];

async function digest(filename) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(filename)) hash.update(bytes);
  return hash.digest('hex');
}
async function run(executable, args) {
  const child = spawn(executable, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Speech resource extraction failed (${code}).`))); });
}

// ModelProto field 14 contains StringStringEntryProto metadata. Skip the large graph
// without interpreting tensors; verify selected IDs against the actual pinned ONNX.
async function modelMetadata(filename) {
  const bytes = await fs.readFile(filename);
  function fields(buffer) {
    let position = 0; const output = [];
    const varint = () => {
      let value = 0, shift = 0, byte;
      do {
        if (position >= buffer.length || shift > 63) throw new Error('Invalid ONNX metadata encoding.');
        byte = buffer[position++]; value += (byte & 127) * 2 ** shift; shift += 7;
      } while (byte & 128);
      return value;
    };
    while (position < buffer.length) {
      const key = varint(), field = Math.floor(key / 8), wire = key % 8;
      if (wire === 0) varint();
      else if (wire === 1) position += 8;
      else if (wire === 5) position += 4;
      else if (wire === 2) {
        const length = varint(), end = position + length;
        if (!Number.isSafeInteger(end) || end > buffer.length) throw new Error('Invalid ONNX field length.');
        output.push([field, buffer.subarray(position, end)]); position = end;
      } else throw new Error('Unsupported ONNX metadata encoding.');
      if (position > buffer.length) throw new Error('Truncated ONNX model.');
    }
    return output;
  }
  return Object.fromEntries(fields(bytes).filter(([field]) => field === 14).map(([, entry]) => {
    const values = new Map(fields(entry));
    if (!values.has(1) || !values.has(2)) throw new Error('Invalid ONNX metadata entry.');
    return [values.get(1).toString('utf8'), values.get(2).toString('utf8')];
  }));
}

/** Downloads only during explicit build preparation; APK inference has no network transport. */
export async function prepareAndroidSpeech({ allowDownload = false } = {}) {
  const component = path.join(root, 'local-data', 'android-speech');
  const downloads = path.join(component, 'downloads');
  await fs.mkdir(downloads, { recursive: true });
  for (const source of androidSpeechSources) {
    const target = path.join(downloads, source.name);
    const present = await fs.stat(target).catch(() => null);
    if (!present || await digest(target) !== source.sha256) {
      if (!allowDownload) throw new Error(`Missing or invalid Android speech resource: ${source.name}. Run prepare-android-speech.mjs --download.`);
      console.log(`Downloading official speech resource: ${source.name}`);
      const response = await fetch(source.url, { signal: AbortSignal.timeout(15 * 60_000) });
      if (!response.ok || !response.body) throw new Error(`Speech resource download failed (${response.status}).`);
      const temporary = `${target}.partial`;
      await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
      if (await digest(temporary) !== source.sha256) throw new Error(`Speech resource checksum mismatch: ${source.name}.`);
      await fs.rename(temporary, target);
    }
    if (source.directory && !await fs.stat(path.join(component, source.directory)).catch(() => null)) {
      await run('tar', ['-xf', target, '-C', component]);
    }
  }
  const kokoro = path.join(component, 'kokoro-int8-multi-lang-v1_0');
  const model = await modelMetadata(path.join(kokoro, 'model.int8.onnx'));
  const speakerIds = new Map(model.speaker2id?.split(',').map(value => value.split('->')));
  for (const [name, id] of [['af_heart', 3], ['bf_emma', 21], ['ff_siwis', 30]]) {
    if (speakerIds.get(name) !== String(id)) throw new Error(`Bundled Kokoro speaker mapping mismatch: ${name}.`);
  }
  const speakerCount = Number(model.n_speakers);
  if (!Number.isSafeInteger(speakerCount) || speakerCount < 31
    || (await fs.stat(path.join(kokoro, 'voices.bin'))).size !== speakerCount * 510 * 256 * 4) {
    throw new Error('Kokoro voice table does not match its model metadata.');
  }
  for (const [file, alias] of [['gmw/en', 'en-gb'], ['gmw/en-US', 'en-us'], ['roa/fr', 'fr-fr']]) {
    const voice = await fs.readFile(path.join(kokoro, 'espeak-ng-data/lang', file), 'utf8');
    if (!voice.split(/\r?\n/).some(line => line.startsWith(`language ${alias}`))) throw new Error(`Bundled eSpeak voice is missing: ${file}.`);
  }
  const libraries = path.join(root, 'android', 'app', 'libs');
  await fs.mkdir(libraries, { recursive: true });
  await fs.copyFile(path.join(downloads, 'sherpa-onnx-1.13.8.aar'), path.join(libraries, 'sherpa-onnx-1.13.8.aar'));
  const licenses = path.join(component, 'licenses'); await fs.mkdir(licenses, { recursive: true });
  for (const source of licenseSources) {
    const target = path.join(licenses, source.name);
    if (!await fs.stat(target).catch(() => null) || await digest(target) !== source.sha256) {
      if (!allowDownload) throw new Error(`Speech resource license missing: ${source.name}.`);
      const response = await fetch(source.url, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`Speech license download failed (${response.status}).`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (createHash('sha256').update(bytes).digest('hex') !== source.sha256) throw new Error(`Speech license checksum mismatch: ${source.name}.`);
      await fs.writeFile(target, bytes);
    }
  }
  await fs.writeFile(path.join(licenses, 'NOTICE.txt'), 'Readge bundled Android speech resources\n\nSherpa ONNX 1.13.8: Copyright Xiaomi Corporation and contributors, Apache-2.0.\nONNX Runtime: Copyright Microsoft Corporation, MIT.\nKokoro 82M v1.0 model: hexgrad, Apache-2.0. Quantized Sherpa conversion distributed unmodified.\neSpeak-ng pronunciation data and native frontend: GPL-3.0. Upstream source: https://github.com/espeak-ng/espeak-ng and https://github.com/k2-fsa/sherpa-onnx/tree/v1.13.8.\nSupertonic 3 model: Supertone Inc., BigScience Open RAIL-M. Quantized Sherpa conversion distributed unmodified.\nUse and distribution of the bundled Supertonic model is subject to LICENSE-Supertonic-model.txt, including paragraph 5 and Attachment A. These use restrictions are conditions of this model distribution and apply to subsequent recipients.\nSupertonic inference source: Copyright 2025 Supertone Inc., MIT.\n\nThe full licenses accompany these files. The APK runtime never downloads models. Android Japanese uses Supertonic 3 speaker 0; desktop Japanese uses Kokoro jf_alpha.\n');
  const files = [];
  const collect = async (directory, prefix, relative = '') => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      // The selected plain eSpeak languages do not use voice variants or the Chinese lexicon/dictionary.
      if (entry.name === '!v' || entry.name === 'dict' || /^(date|number|phone)-zh\.fst$/.test(entry.name) || /^lexicon-/.test(entry.name)) continue;
      const next = path.posix.join(relative, entry.name);
      const filename = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Speech bundle cannot contain links.');
      if (entry.isDirectory()) await collect(filename, prefix, next);
      else if (entry.name !== 'README.md' && !/\.(wav|mp3|py)$/i.test(entry.name)) {
        const source = path.posix.join(prefix, next);
        files.push({ source, path: path.posix.join('speech', source), bytes: (await fs.stat(filename)).size, sha256: await digest(filename) });
      }
    }
  };
  for (const source of androidSpeechSources.filter(source => source.directory)) await collect(path.join(component, source.directory), source.directory);
  await collect(licenses, 'licenses');
  const metadata = {
    engine: 'sherpa-onnx', engineVersion: '1.13.8', wordBoundaries: false,
    voices: [
      { language: 'en-US', model: 'kokoro-int8-multi-lang-v1_0', name: 'af_heart', speakerId: 3, sampleRate: 24000, engineLanguage: 'en-us' },
      { language: 'en-GB', model: 'kokoro-int8-multi-lang-v1_0', name: 'bf_emma', speakerId: 21, sampleRate: 24000, engineLanguage: 'en' },
      { language: 'fr-FR', model: 'kokoro-int8-multi-lang-v1_0', name: 'ff_siwis', speakerId: 30, sampleRate: 24000, engineLanguage: 'fr' },
      { language: 'ja-JP', model: 'sherpa-onnx-supertonic-3-tts-int8-2026-05-11', name: 'Supertonic 3', speakerId: 0, sampleRate: 44100,
        note: 'Android Japanese uses the bundled Supertonic 3 voice; desktop uses Kokoro jf_alpha.' },
    ],
  };
  await fs.writeFile(path.join(component, 'speech.json'), `${JSON.stringify(metadata, null, 2)}\n`);
  files.push({ source: 'speech.json', path: 'speech/speech.json', bytes: (await fs.stat(path.join(component, 'speech.json'))).size, sha256: await digest(path.join(component, 'speech.json')) });
  files.sort((a, b) => a.path.localeCompare(b.path));
  const bundle = { schema: 1, component: 'speech', files,
    provenance: androidSpeechSources.map(({ name, version, url, license, sha256 }) => ({ name, version, url, license, sha256 })),
    metadata };
  await fs.writeFile(path.join(component, 'bundle.json'), `${JSON.stringify(bundle, null, 2)}\n`);
  return { directory: component, files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0), bundle };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const { directory, files, bytes } = await prepareAndroidSpeech({ allowDownload: process.argv.includes('--download') }); console.log(JSON.stringify({ directory, files, bytes }, null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
