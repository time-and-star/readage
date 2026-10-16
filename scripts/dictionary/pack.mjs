import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const PACK_MAGIC = 'NWDICT01';
export const PACK_HEADER_BYTES = 4;

export function sha256(value) {
  const hash = crypto.createHash('sha256');
  if (Buffer.isBuffer(value)) hash.update(value);
  else if (typeof value === 'string' || value instanceof Uint8Array) hash.update(value);
  else hash.update(fs.readFileSync(value));
  return hash.digest('hex');
}

export function readPack(packPath) {
  const buffer = fs.readFileSync(packPath);
  if (buffer.subarray(0, PACK_MAGIC.length).toString('ascii') !== PACK_MAGIC) {
    throw new Error(`Invalid dictionary pack magic: ${packPath}`);
  }
  const headerLength = buffer.readUInt32BE(PACK_MAGIC.length);
  const headerStart = PACK_MAGIC.length + PACK_HEADER_BYTES;
  const headerEnd = headerStart + headerLength;
  if (headerEnd > buffer.length) throw new Error('Dictionary pack header is truncated.');
  const header = JSON.parse(buffer.subarray(headerStart, headerEnd).toString('utf8'));
  if (!Array.isArray(header.sections)) throw new Error('Dictionary pack is missing its section table.');
  const sections = new Map(header.sections.map((section) => [section.name, section]));
  for (const section of header.sections) {
    if (!Number.isSafeInteger(section.offset) || !Number.isSafeInteger(section.length) || section.offset < 0 || section.length < 0 || section.offset + section.length > buffer.length) {
      throw new Error(`Invalid dictionary pack section: ${section.name}`);
    }
  }
  return { buffer, header, sections };
}

export function readSection(pack, name) {
  const section = pack.sections.get(name);
  return section ? pack.buffer.subarray(section.offset, section.offset + section.length) : null;
}

export function parseCsvLine(raw) {
  const row = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === '"' && quoted && raw[index + 1] === '"') {
      value += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      row.push(value);
      value = '';
    } else {
      value += char;
    }
  }
  row.push(value);
  return row;
}

export function* csvRecords(buffer) {
  let start = 0;
  let quoted = false;
  for (let index = 0; index < buffer.length; index += 1) {
    const byte = buffer[index];
    if (byte === 0x22 && quoted && buffer[index + 1] === 0x22) {
      index += 1;
    } else if (byte === 0x22) {
      quoted = !quoted;
    } else if (byte === 0x0a && !quoted) {
      const end = buffer[index - 1] === 0x0d ? index - 1 : index;
      if (end > start) yield buffer.subarray(start, end).toString('utf8');
      start = index + 1;
    }
  }
  const tail = buffer.subarray(start).toString('utf8').replace(/\r$/, '');
  if (tail) yield tail;
}

export function quoteCsv(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function serializeCsvRow(row) {
  return `${row.map(quoteCsv).join(',')}\n`;
}

export function normalizeWord(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function ensureDir(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

export function writeFileSafely(targetPath, data) {
  ensureDir(path.dirname(targetPath));
  const temporaryPath = `${targetPath}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryPath, data);
  try {
    fs.renameSync(temporaryPath, targetPath);
  } catch (error) {
    try { fs.rmSync(temporaryPath, { force: true }); } catch { /* preserve the original target */ }
    throw error;
  }
}

export function writeJsonSafely(targetPath, value) {
  writeFileSafely(targetPath, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); }
    catch (error) { throw new Error(`Invalid JSONL at ${filePath}:${index + 1}: ${error.message}`); }
  });
}

export function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJson(value[key])]));
  }
  return value;
}

