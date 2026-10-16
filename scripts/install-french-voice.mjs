import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { FRENCH_VOICE_SHA256, FRENCH_VOICE_URL } from './kokoro-french.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'local-data', 'kokoro-french');
const destination = path.join(directory, 'ff_siwis.bin');
const valid = bytes => createHash('sha256').update(bytes).digest('hex') === FRENCH_VOICE_SHA256;
const existing = await fs.readFile(destination).catch(() => null);
if (existing && valid(existing)) console.log('French voice already installed.');
else {
  const response = await fetch(FRENCH_VOICE_URL, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`French voice download failed (${response.status}).`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!valid(bytes)) throw new Error('French voice checksum mismatch.');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(destination, bytes);
  console.log(`French voice installed (${bytes.length} bytes, checksum verified).`);
}
