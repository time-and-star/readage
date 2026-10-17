import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

/** Cache only verified, unchanged files; bound disk work and share concurrent checks. */
export function createFileVerifier({ maximumConcurrent = 2, maximumEntries = 2000, stream = createReadStream } = {}) {
  const verified = new Map(), pending = new Map();
  const fingerprint = info => [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':');
  return async function verify(filename, sha, info) {
    const version = fingerprint(info), key = `${filename}:${sha}`;
    if (verified.get(key) === version) return true;
    if (pending.has(key)) return pending.get(key);
    if (pending.size >= maximumConcurrent) return null;
    const task = (async () => {
      const hash = createHash('sha256');
      for await (const chunk of stream(filename)) hash.update(chunk);
      const after = await stat(filename);
      if (fingerprint(after) !== version || hash.digest('hex') !== sha) return false;
      if (verified.size >= maximumEntries) verified.delete(verified.keys().next().value);
      verified.set(key, version);
      return true;
    })();
    pending.set(key, task);
    try { return await task; } finally { pending.delete(key); }
  };
}
