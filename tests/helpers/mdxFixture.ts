import { deflateSync } from 'node:zlib';
import path from 'node:path';
import { createRequire } from 'node:module';
import { mdxAdler32 } from '../../packages/dictionary/server/mdxAdapter';

/** Synthetic, freely reusable MDX corpus; no publisher dictionary content is bundled. */
export function makeMdxFixture(options: {
  entries?: Array<{ key: string; html: string }>;
  title?: string;
  version?: 1.2 | 2;
  encoding?: 'UTF-8' | 'UTF-16';
  compressed?: boolean;
  encryptedKeyInfo?: boolean;
  recordBlockBytes?: number;
  caseSensitive?: boolean;
  keysPerBlock?: number;
} = {}): Buffer {
  const entries = options.entries ?? [
    { key: 'bank', html: '<article><h2>bank</h2><p>A place that holds money.</p><p>银行；河岸</p></article>' },
    { key: 'banks', html: '@@@LINK=bank' },
    { key: 'run', html: '<p>Move quickly on foot. 跑步。</p>' },
    { key: 'running', html: '@@@LINK=run' },
    { key: '𠮷', html: '<p>Unicode example: 𠮷。日本語の例。</p>' },
  ];
  const version = options.version ?? 2;
  const utf16 = options.encoding === 'UTF-16';
  const width = version >= 2 ? 8 : 4;
  const text = (value: string) => Buffer.from(value, utf16 ? 'utf16le' : 'utf8');
  const num = (value: number, size = width) => { const buffer = Buffer.alloc(size); if (size === 8) buffer.writeBigUInt64BE(BigInt(value)); else buffer.writeUIntBE(value, 0, size); return buffer; };
  const checksum = (bytes: Buffer, little = false) => { const result = Buffer.alloc(4); if (little) result.writeUInt32LE(mdxAdler32(bytes)); else result.writeUInt32BE(mdxAdler32(bytes)); return result; };
  const block = (bytes: Buffer, compressed = options.compressed !== false) => Buffer.concat([
    Buffer.from([compressed ? 2 : 0, 0, 0, 0]), checksum(bytes), compressed ? deflateSync(bytes) : bytes,
  ]);
  let offset = 0;
  const records = entries.map(entry => text(entry.html + '\0'));
  const keys = entries.map((entry, index) => {
    const key = Buffer.concat([num(offset), text(entry.key + '\0')]); offset += records[index].length; return key;
  });
  const boundary = (key: string) => Buffer.concat([num(utf16 ? key.length : text(key).length, width / 4), text(key + (version >= 2 ? '\0' : ''))]);
  const keyBlocks: Buffer[] = [];
  const keyInfos: Buffer[] = [];
  const keysPerBlock = options.keysPerBlock ?? entries.length;
  for (let first = 0; first < entries.length; first += keysPerBlock) {
    const last = Math.min(entries.length, first + keysPerBlock);
    const raw = Buffer.concat(keys.slice(first, last));
    const packed = block(raw);
    keyBlocks.push(packed);
    keyInfos.push(num(last - first), boundary(entries[first].key), boundary(entries[last - 1].key), num(packed.length), num(raw.length));
  }
  const rawKeyInfo = Buffer.concat(keyInfos);
  let keyInfo = version >= 2 ? block(rawKeyInfo, true) : rawKeyInfo;
  if (options.encryptedKeyInfo) {
    const requireModule = createRequire(import.meta.url);
    const utilities = requireModule(path.join(path.dirname(requireModule.resolve('js-mdict')), 'utils.js')).default;
    const key = utilities.ripemd128(Buffer.concat([keyInfo.subarray(4, 8), Buffer.from([0x95, 0x36, 0, 0])]));
    const encrypted = Buffer.from(keyInfo);
    let previous = 0x36;
    for (let i = 8; i < encrypted.length; i++) {
      const mixed = keyInfo[i] ^ previous ^ ((i - 8) & 0xff) ^ key[(i - 8) % key.length];
      encrypted[i] = ((mixed >> 4) | (mixed << 4)) & 0xff;
      previous = encrypted[i];
    }
    keyInfo = encrypted;
  }
  const header = Buffer.from(`<Dictionary GeneratedByEngineVersion="${version}" RequiredEngineVersion="${version}" Encrypted="${options.encryptedKeyInfo ? '2' : 'No'}" Encoding="${options.encoding ?? 'UTF-8'}" KeyCaseSensitive="${options.caseSensitive ? 'Yes' : 'No'}" StripKey="No" Title="${options.title ?? 'ReadAge MDX 演示词典'}" Description="Generated test corpus"/>\0`, 'utf16le');
  const allKeys = Buffer.concat(keyBlocks);
  const keyHeader = Buffer.concat([num(keyBlocks.length), num(entries.length), ...(version >= 2 ? [num(rawKeyInfo.length)] : []), num(keyInfo.length), num(allKeys.length)]);
  const allRecords = Buffer.concat(records);
  const recordParts: Buffer[] = [];
  const recordInfo: Buffer[] = [];
  const chunkSize = options.recordBlockBytes ?? allRecords.length;
  for (let start = 0; start < allRecords.length; start += chunkSize) {
    const raw = allRecords.subarray(start, start + chunkSize);
    const packed = block(raw);
    recordParts.push(packed); recordInfo.push(num(packed.length), num(raw.length));
  }
  const recordsPacked = Buffer.concat(recordParts);
  const recordHeader = Buffer.concat([num(recordParts.length), num(entries.length), num(recordInfo.length * width), num(recordsPacked.length)]);
  return Buffer.concat([num(header.length, 4), header, checksum(header, true), keyHeader,
    ...(version >= 2 ? [checksum(keyHeader)] : []), keyInfo, allKeys, recordHeader, ...recordInfo, recordsPacked]);
}
