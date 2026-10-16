import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { inflateRawSync, crc32 } from 'node:zlib';
import { EcdictAdapter } from '../../packages/dictionary/server/ecdict';
import { ReadAgeAuthoredAdapter } from '../../packages/dictionary/server/readageAuthored';
import type { DictionaryAdapter } from '../../packages/dictionary/contracts';
import { checkAbort } from '../../packages/dictionary/core';
import { DictionaryImportError, type DictionaryImportInput, type DictionaryImportResult } from './imports';

export const DISTRIBUTION_MAX_BYTES = 512 * 1024 * 1024;
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function fileHash(file: string): string {
  const digest = createHash('sha256'), fd = fs.openSync(file, 'r'), buffer = Buffer.alloc(65536);
  try { let length: number; while ((length = fs.readSync(fd, buffer, 0, buffer.length, null))) digest.update(buffer.subarray(0, length)); }
  finally { fs.closeSync(fd); }
  return digest.digest('hex');
}
function valid(condition: unknown, message = '离线词典包损坏或格式无效。'): asserts condition {
  if (!condition) throw new DictionaryImportError(400, 'INVALID_DICTIONARY_PACK', message);
}
/** User installs take precedence over bundled resources, and remain explicitly unavailable when damaged. */
export function installedDictionaryDirectories(importsDir?: string): { dataDir?: string; readageDir?: string } {
  if (!importsDir) return {};
  const root = path.resolve(importsDir, 'distribution'), result: { dataDir?: string; readageDir?: string } = {};
  for (const [id, key] of [['ecdict', 'dataDir'], ['readage', 'readageDir']] as const) {
    const pointer = path.join(root, `${id}.json`);
    if (!fs.existsSync(pointer)) continue;
    try {
      valid(fs.statSync(pointer).size <= 4096);
      const selected = JSON.parse(fs.readFileSync(pointer, 'utf8'));
      valid(typeof selected.folder === 'string' && new RegExp(`^${id}-[a-f0-9]{64}$`).test(selected.folder));
      const directory = path.join(root, selected.folder), filename = id === 'ecdict' ? 'dictionary.pack' : 'manifest.json';
      valid(fileHash(path.join(directory, filename)) === selected.folder.slice(id.length + 1));
      result[key] = directory;
    } catch { result[key] = path.join(root, `unavailable-${id}`); }
  }
  return result;
}

function inspectEcdict(bytes: Buffer): number {
  valid(bytes.length >= 12 && bytes.subarray(0, 8).toString('ascii') === 'NWDICT01');
  const length = bytes.readUInt32BE(8); valid(length > 0 && length <= 1024 * 1024 && length <= bytes.length - 12);
  const header = JSON.parse(bytes.subarray(12, 12 + length).toString('utf8'));
  valid(Number.isSafeInteger(header.indexedWords) && header.indexedWords > 0 && Array.isArray(header.sections));
  const names = new Set<string>(); let records: { offset: number; length: number } | undefined;
  for (const section of header.sections) {
    valid(typeof section.name === 'string' && /^(?:records|cefr|families|(?:index|enhanced)\.[a-z_])$/.test(section.name) && !names.has(section.name)); names.add(section.name);
    valid(Number.isSafeInteger(section.offset) && Number.isSafeInteger(section.length) && section.offset >= 12 + length && section.length > 0 && section.offset <= bytes.length - section.length);
    if (section.name === 'records') records = section;
    else valid(section.length <= 16 * 1024 * 1024);
  }
  valid(records && [...names].some(name => name.startsWith('index.')));
  let count = 0;
  for (const section of header.sections.filter((item: { name: string }) => item.name.startsWith('index.'))) {
    const rows = JSON.parse(bytes.subarray(section.offset, section.offset + section.length).toString('utf8'));
    for (const [word, location] of Object.entries(rows)) {
      valid(word && Array.isArray(location) && Number.isSafeInteger(location[0]) && Number.isSafeInteger(location[1]) && location[0] >= 0 && location[1] >= 1 && location[1] <= 1024 * 1024 && location[0] <= records.length - location[1]); count++;
    }
  }
  valid(count === header.indexedWords);
  return count;
}

function distributionZip(bytes: Buffer): Map<string, Buffer> {
  let end = -1;
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65557); index--)
    if (bytes.readUInt32LE(index) === 0x06054b50 && index + 22 + bytes.readUInt16LE(index + 20) === bytes.length) { end = index; break; }
  valid(end >= 0 && bytes.readUInt16LE(end + 4) === 0 && bytes.readUInt16LE(end + 6) === 0);
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), offset = bytes.readUInt32LE(end + 16);
  valid(count > 0 && count <= 5 && bytes.readUInt16LE(end + 8) === count && offset <= end - size);
  const result = new Map<string, Buffer>(); let cursor = offset, total = 0;
  for (let index = 0; index < count; index++) {
    valid(cursor <= offset + size - 46 && bytes.readUInt32LE(cursor) === 0x02014b50);
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10), checksum = bytes.readUInt32LE(cursor + 16);
    const packed = bytes.readUInt32LE(cursor + 20), unpacked = bytes.readUInt32LE(cursor + 24), nameLength = bytes.readUInt16LE(cursor + 28);
    const next = cursor + 46 + nameLength + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32), local = bytes.readUInt32LE(cursor + 42);
    valid(!(flags & 0x41) && (method === 0 || method === 8) && unpacked <= 64 * 1024 * 1024 && next <= offset + size);
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength), name = nameBytes.toString('utf8');
    valid(/^(?:manifest\.json|index\.json|entries\.pack|LICENSE(?:\.txt)?)$/.test(name) && !result.has(name));
    total += unpacked; valid(total <= DISTRIBUTION_MAX_BYTES && local <= offset - 30 && bytes.readUInt32LE(local) === 0x04034b50
      && bytes.readUInt16LE(local + 6) === flags && bytes.readUInt16LE(local + 8) === method && bytes.readUInt16LE(local + 26) === nameLength);
    const start = local + 30 + nameLength + bytes.readUInt16LE(local + 28);
    valid(start <= offset - packed && bytes.subarray(local + 30, local + 30 + nameLength).equals(nameBytes));
    const compressed = bytes.subarray(start, start + packed);
    const content = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: Math.max(1, unpacked) });
    valid(content.length === unpacked && crc32(content) === checksum); result.set(name, content); cursor = next;
  }
  valid(cursor === offset + size && ['manifest.json', 'index.json', 'entries.pack'].every(name => result.has(name)));
  return result;
}

export function createDistributionImporter(options: {
  directory: string; snapshot(): Omit<DictionaryImportResult, 'imported'>;
  install(adapter: DictionaryAdapter, commit: () => Promise<void>): Promise<unknown>;
}) {
  let queue: Promise<unknown> = Promise.resolve();
  async function one(input: DictionaryImportInput): Promise<DictionaryImportResult> {
    checkAbort(input.signal); valid(Buffer.isBuffer(input.bytes) && input.bytes.length > 0);
    if (input.bytes.length > DISTRIBUTION_MAX_BYTES) throw new DictionaryImportError(413, 'DICTIONARY_TOO_LARGE', '离线词典包最大支持 512 MB。');
    const root = path.resolve(options.directory, 'distribution'), staging = path.join(root, `.install-${randomUUID()}`);
    await fs.promises.mkdir(staging, { recursive: true });
    let adapter: EcdictAdapter | ReadAgeAuthoredAdapter; let count: number; let kind: 'ecdict' | 'readage'; let identity: string;
    try {
      if (input.bytes.subarray(0, 8).toString('ascii') === 'NWDICT01') {
        count = inspectEcdict(input.bytes); kind = 'ecdict'; identity = hash(input.bytes);
        await fs.promises.writeFile(path.join(staging, 'dictionary.pack'), input.bytes, { flag: 'wx', mode: 0o600 });
      } else {
        kind = 'readage';
        const archive = distributionZip(input.bytes);
        for (const [name, bytes] of archive) {
          checkAbort(input.signal);
          await fs.promises.writeFile(path.join(staging, name), bytes, { flag: 'wx', mode: 0o600 });
        }
        identity = hash(await fs.promises.readFile(path.join(staging, 'manifest.json')));
        const inspected = new ReadAgeAuthoredAdapter({ dataDir: staging }); valid(inspected.getStatus().available); count = inspected.count;
      }
      checkAbort(input.signal);
      const folder = `${kind}-${identity}`, destination = path.join(root, folder);
      if (!fs.existsSync(destination)) await fs.promises.rename(staging, destination);
      else {
        for (const name of kind === 'ecdict' ? ['dictionary.pack'] : ['manifest.json', 'index.json', 'entries.pack'])
          valid(fileHash(path.join(staging, name)) === fileHash(path.join(destination, name)), '已安装的同一词典包内容损坏，请恢复文件后重试。');
      }
      adapter = kind === 'ecdict' ? new EcdictAdapter({ dataDir: destination }) : new ReadAgeAuthoredAdapter({ dataDir: destination });
      valid(adapter.getStatus().available); checkAbort(input.signal);
      const temporary = path.join(root, `.pointer-${randomUUID()}.tmp`);
      try {
        const handle = await fs.promises.open(temporary, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify({ folder, origin: 'user' }) + '\n'); await handle.sync(); } finally { await handle.close(); }
        await options.install(adapter, async () => { checkAbort(input.signal); await fs.promises.rename(temporary, path.join(root, `${kind}.json`)); });
      } finally { await fs.promises.unlink(temporary).catch(() => {}); }
      return { ...options.snapshot(), imported: { dictionaryId: adapter.metadata.id, name: adapter.metadata.name, entryCount: count } };
    } catch (error) {
      if (input.signal?.aborted) throw input.signal.reason;
      if (error instanceof DictionaryImportError) throw error;
      throw new DictionaryImportError(400, 'INVALID_DICTIONARY_PACK', '离线词典包无法读取或保存，原词典配置保留。');
    } finally {
      // Only this generated staging directory is removed; published historical packs stay recoverable.
      if (path.dirname(staging) === root && path.basename(staging).startsWith('.install-')) await fs.promises.rm(staging, { recursive: true, force: true });
    }
  }
  return { import(input: DictionaryImportInput) { const task = queue.then(() => one(input)); queue = task.catch(() => {}); return task; } };
}
