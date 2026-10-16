import { createHash } from 'node:crypto';

const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');

export function icoFrames(buffer) {
  if (buffer.length < 6 || buffer.readUInt16LE(0) !== 0 || buffer.readUInt16LE(2) !== 1) throw new Error('Invalid ICO header.');
  const count = buffer.readUInt16LE(4);
  if (!count || 6 + count * 16 > buffer.length) throw new Error('Invalid ICO directory.');
  return Array.from({ length: count }, (_, index) => {
    const offset = 6 + index * 16;
    const bytes = buffer.readUInt32LE(offset + 8), start = buffer.readUInt32LE(offset + 12);
    if (start < 6 + count * 16 || start + bytes > buffer.length) throw new Error('Invalid ICO frame bounds.');
    return { size: buffer[offset] || 256, height: buffer[offset + 1] || 256,
      bytes, sha256: sha256(buffer.subarray(start, start + bytes)) };
  });
}

/** Read the actual Windows RT_GROUP_ICON and RT_ICON resources without executing a PE. */
export function peIconGroups(buffer) {
  if (buffer.length < 64 || buffer.toString('ascii', 0, 2) !== 'MZ') throw new Error('Invalid Windows executable.');
  const pe = buffer.readUInt32LE(60);
  if (pe + 24 > buffer.length || buffer.toString('ascii', pe, pe + 4) !== 'PE\0\0') throw new Error('Invalid PE header.');
  const optional = pe + 24, magic = buffer.readUInt16LE(optional);
  if (magic !== 0x10b && magic !== 0x20b) throw new Error('Invalid PE optional header.');
  const directory = optional + (magic === 0x20b ? 112 : 96);
  const resourceRva = buffer.readUInt32LE(directory + 16), resourceBytes = buffer.readUInt32LE(directory + 20);
  if (!resourceRva || !resourceBytes) return [];
  const sections = optional + buffer.readUInt16LE(pe + 20), count = buffer.readUInt16LE(pe + 6);
  function fileOffset(rva, bytes = 1) {
    for (let index = 0; index < count; index++) {
      const entry = sections + index * 40;
      const virtual = buffer.readUInt32LE(entry + 12), rawBytes = buffer.readUInt32LE(entry + 16), raw = buffer.readUInt32LE(entry + 20);
      if (rva >= virtual && rva + bytes <= virtual + rawBytes && raw + rva - virtual + bytes <= buffer.length) return raw + rva - virtual;
    }
    throw new Error('PE resource is outside its section.');
  }
  const base = fileOffset(resourceRva);
  function entries(relative) {
    if (relative < 0 || relative + 16 > resourceBytes) throw new Error('Invalid PE resource directory.');
    const offset = base + relative, total = buffer.readUInt16LE(offset + 12) + buffer.readUInt16LE(offset + 14);
    if (total > 4096 || relative + 16 + total * 8 > resourceBytes) throw new Error('Invalid PE resource entries.');
    return Array.from({ length: total }, (_, index) => {
      const entry = offset + 16 + index * 8, name = buffer.readUInt32LE(entry), target = buffer.readUInt32LE(entry + 4);
      return { id: name & 0x80000000 ? undefined : name, directory: Boolean(target & 0x80000000), relative: target & 0x7fffffff };
    });
  }
  function payload(relative) {
    if (relative + 16 > resourceBytes) throw new Error('Invalid PE resource data.');
    const offset = base + relative, rva = buffer.readUInt32LE(offset), bytes = buffer.readUInt32LE(offset + 4);
    const start = fileOffset(rva, bytes);
    return buffer.subarray(start, start + bytes);
  }
  const types = entries(0);
  function resources(type) {
    const root = types.find(entry => entry.id === type && entry.directory);
    if (!root) return [];
    const result = [];
    for (const resource of entries(root.relative).filter(entry => entry.directory)) {
      for (const language of entries(resource.relative).filter(entry => !entry.directory)) {
        result.push({ id: resource.id, language: language.id, buffer: payload(language.relative) });
      }
    }
    return result;
  }
  const icons = resources(3);
  return resources(14).map(group => {
    const header = group.buffer;
    if (header.length < 6 || header.readUInt16LE(2) !== 1) throw new Error('Invalid PE icon group.');
    const count = header.readUInt16LE(4);
    if (6 + count * 14 > header.length) throw new Error('Invalid PE icon group bounds.');
    const frames = Array.from({ length: count }, (_, index) => {
      const offset = 6 + index * 14, id = header.readUInt16LE(offset + 12);
      const icon = icons.find(entry => entry.id === id && entry.language === group.language) || icons.find(entry => entry.id === id);
      if (!icon) throw new Error(`Missing PE icon payload ${id}.`);
      return { size: header[offset] || 256, height: header[offset + 1] || 256,
        bytes: icon.buffer.length, sha256: sha256(icon.buffer) };
    });
    return { id: group.id, language: group.language, frames };
  });
}

export function matchingBrandIcon(groups, expected) {
  // Explorer/shortcut icon index 0 uses the first group, not an arbitrary extra icon.
  const group = groups[0];
  return Boolean(group && group.frames.length === expected.length && expected.every(frame =>
    group.frames.some(candidate => candidate.size === frame.size && candidate.height === frame.height && candidate.sha256 === frame.sha256)));
}
