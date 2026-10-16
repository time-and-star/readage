import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { inflateSync } from 'node:zlib';
import { MDX, type KeyWordItem } from 'js-mdict';
import { convert as htmlToText } from 'html-to-text';
import { DICTIONARY_ENTRY_SCHEMA_VERSION, type AdapterLookupRequest, type AdapterMatch, type DictionaryAdapter, type DictionaryEntry, type DictionaryMetadata } from '../contracts';
import { checkAbort } from '../core';

export const MDX_MAX_FILE_BYTES = 256 * 1024 * 1024;
export const MDX_MAX_ENTRIES = 1_000_000;
export const MDX_MAX_ENTRY_BYTES = 2 * 1024 * 1024;
const MAX_BLOCK_BYTES = 32 * 1024 * 1024;
const MAX_INDEX_BYTES = 128 * 1024 * 1024;
const MAX_RECORD_BYTES = 512 * 1024 * 1024;
const MAX_BLOCKS = 100_000;
export const MDX_PLAIN_TEXT_EXTENSION = 'readage.originalPlainText.v1';
export const mdxHash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export class MdxFormatError extends Error {
  constructor(message = 'MDX 文件损坏或格式不受支持。') { super(message); this.name = 'MdxFormatError'; }
}
export interface ImportedMdxManifest {
  format: 'dictionary-mdx-import.v1';
  dictionaryId: string;
  name: string;
  language: string;
  sha256: string;
  bytes: number;
  entryCount: number;
  filename: string;
  collationLocale?: string;
}

function requireFormat(condition: unknown, message?: string): asserts condition { if (!condition) throw new MdxFormatError(message); }
export function mdxAdler32(bytes: Uint8Array): number {
  let a = 1; let b = 0;
  for (let start = 0; start < bytes.length; start += 5552) {
    const end = Math.min(bytes.length, start + 5552);
    for (let i = start; i < end; i++) { a += bytes[i]; b += a; }
    a %= 65521; b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** js-mdict 6.0.8 (MIT) has a bounded-input key-info decrypt routine. Keep the package pinned. */
const requireModule = createRequire(import.meta.url);
const mdictUtilities = requireModule(path.join(path.dirname(requireModule.resolve('js-mdict')), 'utils.js')).default as {
  mdxDecrypt(bytes: Uint8Array): Uint8Array;
  parseHeader(text: string): Record<string, unknown>;
};

function unpack(block: Uint8Array, expected: number): Buffer {
  requireFormat(block.length >= 8 && expected >= 0 && expected <= MAX_BLOCK_BYTES);
  const bytes = Buffer.from(block.buffer, block.byteOffset, block.byteLength);
  const kind = bytes.readUInt32LE(0);
  requireFormat(kind !== 1, '当前暂不支持 LZO 压缩的 MDX，请使用未压缩或 zlib 压缩的版本。');
  requireFormat(kind === 0 || kind === 2);
  let result: Buffer;
  try { result = kind === 0 ? bytes.subarray(8) : inflateSync(bytes.subarray(8), { maxOutputLength: Math.max(1, expected) }); }
  catch { throw new MdxFormatError('MDX 压缩块损坏或解压大小超过限制。'); }
  requireFormat(result.length === expected && mdxAdler32(result) === bytes.readUInt32BE(4));
  return result;
}

/** Validate every size and compressed block before the upstream parser can allocate from file metadata. */
export function preflightMdx(bytes: Buffer): { entryCount: number; title: string; recordBytes: number; caseSensitive: boolean } {
  requireFormat(bytes.length >= 64 && bytes.length <= MDX_MAX_FILE_BYTES);
  const started = Date.now();
  const checkBudget = () => requireFormat(Date.now() - started < 30_000, 'MDX 索引处理超时，请使用较小的词典。');
  let cursor = 0;
  function take(size: number): Buffer {
    requireFormat(Number.isSafeInteger(size) && size >= 0 && cursor + size <= bytes.length);
    const result = bytes.subarray(cursor, cursor + size); cursor += size; return result;
  }
  const headerSize = take(4).readUInt32BE();
  requireFormat(headerSize > 0 && headerSize <= 1024 * 1024 && headerSize % 2 === 0);
  const headerBytes = take(headerSize);
  requireFormat(take(4).readUInt32LE() === mdxAdler32(headerBytes));
  const header = new TextDecoder('utf-16le').decode(headerBytes);
  requireFormat(/^\uFEFF?\s*<Dictionary\b/i.test(header));
  const attributeNames = new Set<string>();
  for (const match of header.matchAll(/(\w+)="[^"]*"/g)) {
    const name = match[1].toLowerCase();
    requireFormat(!attributeNames.has(name)); attributeNames.add(name);
  }
  let attributes: Record<string, unknown>;
  try { attributes = mdictUtilities.parseHeader(header); }
  catch { throw new MdxFormatError('MDX 文件头无效。'); }
  // Use exactly the pinned parser's decoded attributes; mismatched header interpretation can bypass size preflight.
  const attribute = (key: string) => typeof attributes[key] === 'string' ? attributes[key] as string : '';
  const version = Number(attribute('GeneratedByEngineVersion'));
  requireFormat(version >= 1 && version <= 2, '当前支持 MDX 1.x 和 2.0；此 MDX 版本暂不支持。');
  const encryption = attribute('Encrypted');
  const encrypted = !encryption || /^no$/i.test(encryption) ? 0 : /^yes$/i.test(encryption) ? 1 : Number(encryption);
  requireFormat(encrypted === 0 || encrypted === 2, '受用户密码保护的 MDX 暂不支持导入。');
  requireFormat(!encrypted || version === 2);
  const width = version >= 2 ? 8 : 4;
  const utf16 = /^(?:utf-?16)$/i.test(attribute('Encoding'));
  function number(data: Buffer, offset: number, size = width): number {
    requireFormat(offset + size <= data.length);
    if (size === 8) { const value = data.readBigUInt64BE(offset); requireFormat(value <= BigInt(Number.MAX_SAFE_INTEGER)); return Number(value); }
    return data.readUIntBE(offset, size);
  }
  const keyHeader = take(width * (version >= 2 ? 5 : 4));
  if (version >= 2) requireFormat(take(4).readUInt32BE() === mdxAdler32(keyHeader));
  const keyBlocks = number(keyHeader, 0);
  const entryCount = number(keyHeader, width);
  requireFormat(keyBlocks > 0 && keyBlocks <= MAX_BLOCKS && entryCount > 0 && entryCount <= MDX_MAX_ENTRIES);
  const keyInfoSize = number(keyHeader, width * (version >= 2 ? 3 : 2));
  const keyPackedSize = number(keyHeader, width * (version >= 2 ? 4 : 3));
  requireFormat(keyInfoSize <= MAX_BLOCK_BYTES && keyPackedSize <= MDX_MAX_FILE_BYTES);
  let keyInfo: Buffer = take(keyInfoSize);
  if (version >= 2) {
    // Upstream decrypt mutates its slice; copy before calling it so the content hash stays the file's hash.
    if (encrypted === 2) keyInfo = Buffer.from(mdictUtilities.mdxDecrypt(Uint8Array.from(keyInfo)));
    keyInfo = unpack(keyInfo, number(keyHeader, width * 2));
  }
  let infoCursor = 0; let keyEntries = 0; let keySizeSum = 0; let indexBytes = 0;
  const keyBlockSizes: Array<{ packed: number; unpacked: number; count: number }> = [];
  for (let i = 0; i < keyBlocks; i++) {
    checkBudget();
    const count = number(keyInfo, infoCursor); infoCursor += width;
    requireFormat(count > 0 && count <= MDX_MAX_ENTRIES);
    for (let end = 0; end < 2; end++) {
      const length = number(keyInfo, infoCursor, width / 4); infoCursor += width / 4;
      requireFormat(length <= 4096);
      infoCursor += (length + (version >= 2 ? 1 : 0)) * (utf16 ? 2 : 1);
      requireFormat(infoCursor <= keyInfo.length);
    }
    const packed = number(keyInfo, infoCursor); infoCursor += width;
    const unpacked = number(keyInfo, infoCursor); infoCursor += width;
    requireFormat(packed >= 8 && unpacked <= MAX_BLOCK_BYTES);
    keyEntries += count; keySizeSum += packed; indexBytes += unpacked;
    requireFormat(keyEntries <= MDX_MAX_ENTRIES && indexBytes <= MAX_INDEX_BYTES);
    keyBlockSizes.push({ packed, unpacked, count });
  }
  requireFormat(infoCursor === keyInfo.length && keyEntries === entryCount && keySizeSum === keyPackedSize);
  const offsets: number[] = [];
  for (const block of keyBlockSizes) {
    checkBudget();
    const raw = unpack(take(block.packed), block.unpacked);
    let position = 0; let count = 0;
    while (position < raw.length) {
      const recordOffset = number(raw, position); position += width;
      let end = position;
      while (end < raw.length && !(raw[end] === 0 && (!utf16 || raw[end + 1] === 0))) end += utf16 ? 2 : 1;
      requireFormat(end < raw.length && end > position && end - position <= 16384);
      offsets.push(recordOffset); count++;
      requireFormat(count <= block.count);
      position = end + (utf16 ? 2 : 1);
    }
    requireFormat(position === raw.length && count === block.count);
  }
  const recordHeader = take(width * 4);
  const recordBlocks = number(recordHeader, 0);
  requireFormat(recordBlocks > 0 && recordBlocks <= MAX_BLOCKS && number(recordHeader, width) === entryCount);
  const recordInfoSize = number(recordHeader, width * 2);
  requireFormat(recordInfoSize === recordBlocks * width * 2);
  const recordsPacked = number(recordHeader, width * 3);
  const recordInfo = take(recordInfoSize);
  let packedSum = 0; let recordBytes = 0;
  for (let i = 0; i < recordBlocks; i++) {
    checkBudget();
    const packed = number(recordInfo, i * width * 2);
    const unpacked = number(recordInfo, i * width * 2 + width);
    requireFormat(packed >= 8 && unpacked <= MAX_BLOCK_BYTES);
    packedSum += packed; recordBytes += unpacked;
    requireFormat(recordBytes <= MAX_RECORD_BYTES);
    unpack(take(packed), unpacked);
  }
  requireFormat(packedSum === recordsPacked && cursor === bytes.length);
  for (let i = 0; i < offsets.length; i++) {
    const next = offsets[i + 1] ?? recordBytes;
    requireFormat(offsets[i] >= 0 && next >= offsets[i] && next <= recordBytes && next - offsets[i] <= MDX_MAX_ENTRY_BYTES);
  }
  return { entryCount, title: htmlToText(attribute('Title'), { wordwrap: false }).trim().slice(0, 160), recordBytes,
    caseSensitive: /^(?:yes|true|1)$/i.test(attribute('KeyCaseSensitive')) };
}

class BoundedMdxReader extends MDX {
  override readDict(): void {
    try { super.readDict(); }
    catch (error) { this.scanner.close(); throw error instanceof MdxFormatError ? error : new MdxFormatError(); }
  }
  /** Linear variant of js-mdict 6.0.8's MIT _readKeyBlocks; accumulated concat would be quadratic. */
  readKeyBlocksBounded(): void {
    const started = Date.now();
    this._keyBlockStartOffset = this._keyBlockInfoEndOffset;
    let cursor = this._keyBlockStartOffset;
    const items: KeyWordItem[] = [];
    for (const [index, info] of this.keyInfoList.entries()) {
      requireFormat(Date.now() - started < 30_000, 'MDX 索引处理超时，请使用较小的词典。');
      const raw = this.unpackKeyBlock(this.scanner.readBuffer(cursor, info.keyBlockPackSize), info.keyBlockUnpackSize);
      const block = this.splitKeyBlock(raw, index);
      if (items.length && block.length) items[items.length - 1].recordEndOffset = block[0].recordStartOffset;
      for (const item of block) {
        requireFormat(items.length < MDX_MAX_ENTRIES);
        items.push(item);
      }
      cursor += info.keyBlockPackSize;
    }
    requireFormat(items.length === this.keyHeader.keywordNum && cursor - this._keyBlockStartOffset === this.keyHeader.keywordBlockPackedSize);
    this._keyBlockEndOffset = cursor; this.keywordList = items;
  }
  protected override unpackKeyBlock(bytes: Uint8Array, expected: number): Uint8Array { return unpack(bytes, expected); }
  override lookupRecordByKeyBlock(item: KeyWordItem): Uint8Array {
    requireFormat(item.recordEndOffset >= item.recordStartOffset && item.recordEndOffset - item.recordStartOffset <= MDX_MAX_ENTRY_BYTES);
    const parts: Buffer[] = [];
    for (const block of this.recordInfoList) {
      const blockEnd = block.unpackAccumulatorOffset + block.unpackSize;
      if (blockEnd <= item.recordStartOffset) continue;
      if (block.unpackAccumulatorOffset >= item.recordEndOffset) break;
      const bytes = this.scanner.readBuffer(this._recordBlockStartOffset + block.packAccumulateOffset, block.packSize);
      const raw = unpack(bytes, block.unpackSize);
      parts.push(raw.subarray(Math.max(0, item.recordStartOffset - block.unpackAccumulatorOffset),
        Math.min(raw.length, item.recordEndOffset - block.unpackAccumulatorOffset)));
    }
    return Buffer.concat(parts);
  }
}
// The pinned package compiles TS-private methods to ordinary prototype methods. Patch only our subclass.
Object.defineProperty(BoundedMdxReader.prototype, '_readKeyBlocks', {
  value(this: BoundedMdxReader) { this.readKeyBlocksBounded(); }, configurable: false,
});

export function inspectMdxFile(file: string) {
  requireFormat(fs.statSync(file).size <= MDX_MAX_FILE_BYTES);
  const bytes = fs.readFileSync(file);
  const inspected = preflightMdx(bytes);
  let parser: BoundedMdxReader;
  try { parser = new BoundedMdxReader(file, { isStripKey: false, isCaseSensitive: true }); }
  catch { throw new MdxFormatError(); }
  try {
    requireFormat(parser.keywordList.length === inspected.entryCount);
    const groups = new Map<string, number>();
    for (const item of parser.keywordList) {
      requireFormat(item.keyText.length > 0 && item.keyText.length <= 4096);
      const key = inspected.caseSensitive ? item.keyText : item.keyText.toLowerCase();
      const count = (groups.get(key) ?? 0) + 1;
      requireFormat(count <= 64); groups.set(key, count);
    }
  }
  finally { parser.close(); }
  return { ...inspected, bytes: bytes.length, sha256: mdxHash(bytes) };
}

/** MDX carries original publisher markup; its plain-text projection makes no linguistic claims. */
export class MdxDictionaryAdapter implements DictionaryAdapter {
  readonly metadata: DictionaryMetadata;
  private parser?: BoundedMdxReader;
  private keys = new Map<string, KeyWordItem[]>();
  private entries = new Map<string, KeyWordItem>();
  private ids = new Map<KeyWordItem, string>();
  private foldedKeys = new Map<string, KeyWordItem[]>();
  private caseSensitive = true;
  private error?: Error;

  constructor(private readonly options: { file: string; manifest: ImportedMdxManifest }) {
    const manifest = options.manifest;
    this.metadata = { id: manifest.dictionaryId, name: manifest.name, languages: [manifest.language], definitionLanguages: [],
      contentVersion: `mdx:${manifest.sha256}`, schemaVersion: DICTIONARY_ENTRY_SCHEMA_VERSION, adapterVersion: 'mdx-adapter.v1:js-mdict6.0.8',
      capabilities: { lookup: true, details: true, resources: 'unsupported', originalContent: 'supported' },
      provenance: [{ kind: 'MDX', label: manifest.name, detail: '用户导入 MDX', status: 'confirmed' }] };
    try { requireFormat(fs.statSync(options.file).size === manifest.bytes); }
    catch { this.error = new Error('Imported MDX is unavailable.'); }
  }
  get count() { return this.options.manifest.entryCount; }
  getStatus() { return { available: !this.error }; }
  verifyStoredFile(): boolean {
    let fd: number | undefined;
    try {
      const size = fs.statSync(this.options.file).size;
      if (size !== this.options.manifest.bytes || size > MDX_MAX_FILE_BYTES) return false;
      fd = fs.openSync(this.options.file, 'r');
      const hash = createHash('sha256'); const chunk = Buffer.alloc(65536);
      let offset = 0;
      while (offset < size) {
        const count = fs.readSync(fd, chunk, 0, Math.min(chunk.length, size - offset), offset);
        if (!count) return false;
        hash.update(chunk.subarray(0, count)); offset += count;
      }
      return hash.digest('hex') === this.options.manifest.sha256;
    } catch { return false; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  dispose() { this.parser?.close(); this.parser = undefined; this.keys.clear(); this.entries.clear(); this.ids.clear(); this.foldedKeys.clear(); }
  private load() {
    if (this.error) throw this.error;
    if (this.parser) return;
    try {
      const inspected = inspectMdxFile(this.options.file);
      requireFormat(inspected.sha256 === this.options.manifest.sha256 && inspected.entryCount === this.count);
      this.caseSensitive = inspected.caseSensitive;
      this.parser = new BoundedMdxReader(this.options.file, { isStripKey: false, isCaseSensitive: true });
      if (this.options.manifest.collationLocale) {
        const collator = new Intl.Collator(this.options.manifest.collationLocale);
        this.parser.keywordList.sort((a, b) => collator.compare(a.keyText, b.keyText));
      }
      const offsets = [...new Set(this.parser.keywordList.map(item => item.recordStartOffset))].sort((a, b) => a - b);
      const ends = new Map(offsets.map((offset, index) => [offset, offsets[index + 1] ?? inspected.recordBytes]));
      for (const [index, item] of this.parser.keywordList.entries()) {
        item.recordEndOffset = ends.get(item.recordStartOffset)!;
        const group = this.keys.get(item.keyText) ?? [];
        requireFormat(group.length < 64);
        group.push(item); this.keys.set(item.keyText, group);
        const id = `record-${item.recordStartOffset}-${index}`;
        this.entries.set(id, item); this.ids.set(item, id);
        if (!this.caseSensitive) {
          const folded = this.foldedKeys.get(item.keyText.toLowerCase()) ?? [];
          requireFormat(folded.length < 64); folded.push(item); this.foldedKeys.set(item.keyText.toLowerCase(), folded);
        }
      }
    } catch (error) { this.error = new Error('Imported MDX is unavailable.'); this.dispose(); throw this.error; }
  }
  private content(item: KeyWordItem, visited = new Set<string>()): string {
    requireFormat(visited.size < 8 && !visited.has(item.keyText), 'MDX 词条链接存在循环或层级过深。');
    visited.add(item.keyText);
    const value = this.parser!.fetch(item).definition?.replace(/\0+$/, '').trim() ?? '';
    requireFormat(value.length <= MDX_MAX_ENTRY_BYTES);
    const linked = value.match(/^@@@?LINK=([^\r\n]+)\s*$/);
    if (!linked) return value;
    const target = this.keys.get(linked[1].trim())?.[0];
    requireFormat(target, 'MDX 词条链接指向不存在的词条。');
    return this.content(target, visited);
  }
  private entry(id: string, item: KeyWordItem): DictionaryEntry {
    const content = this.content(item);
    const text = htmlToText(content, { wordwrap: false, selectors: [
      { selector: 'img', format: 'skip' }, { selector: 'script', format: 'skip' }, { selector: 'style', format: 'skip' },
      ...['iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'svg', 'math', 'audio', 'video', 'source', 'canvas', 'link', 'meta']
        .map(selector => ({ selector, format: 'skip' })),
      { selector: 'a', options: { ignoreHref: true } },
    ] });
    return { dictionaryId: this.metadata.id, entryId: id, language: this.options.manifest.language, headword: item.keyText,
      contentVersion: this.metadata.contentVersion, schemaVersion: DICTIONARY_ENTRY_SCHEMA_VERSION, readings: [], provenance: this.metadata.provenance,
      content: { kind: 'original', mediaType: 'text/html', content },
      extensions: { [MDX_PLAIN_TEXT_EXTENSION]: { language: this.options.manifest.language, text } } };
  }
  async lookup(request: AdapterLookupRequest, signal?: AbortSignal): Promise<AdapterMatch[]> {
    checkAbort(signal); this.load();
    for (const candidate of request.candidates) {
      const items = this.keys.get(candidate.text) ?? (!request.exactOnly && !this.caseSensitive ? this.foldedKeys.get(candidate.text.toLowerCase()) : undefined);
      if (!items) continue;
      const matches = items.map(item => {
        const id = this.ids.get(item);
        requireFormat(id);
        return { entry: this.entry(id, item), matchKind: candidate.text !== item.keyText && candidate.kind === 'exact' ? 'normalized' as const : candidate.kind };
      });
      checkAbort(signal); return matches;
    }
    return [];
  }
  async getEntry(id: string, signal?: AbortSignal): Promise<DictionaryEntry | null> {
    checkAbort(signal); this.load();
    const item = this.entries.get(id);
    const result = item ? this.entry(id, item) : null;
    checkAbort(signal); return result;
  }
}
