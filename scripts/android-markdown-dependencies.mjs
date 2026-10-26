import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** Fixed production parser versions; the same jars are used by the JVM document tests. */
export async function androidMarkdownDependencies(root) {
  const folder = path.join(root, 'tmp/android-tools/document-import/lib');
  const hashes = {
    commonmark: '9b0d20064975a17e876fcb4b599c6b3667f46a7739ed61e2f06c96f44b50629f',
    'commonmark-ext-gfm-tables': 'c375b6d5b71efe179e5763a6d83fcf10e303c0bf82031310a46769727ac90da0',
    'commonmark-ext-gfm-strikethrough': '825a45a1b196f8e0351baf8eb140d657cbf3fd3e17ab34155aa99056db82f099',
    'commonmark-ext-footnotes': '2ec92f97d86035aca6b46757ff5ca8c333b9c55c4f34b531440dd5da8ebc2783',
  };
  await fs.mkdir(folder, { recursive: true });
  const files = [];
  for (const [name, hash] of Object.entries(hashes)) {
    const filename = `${name}-0.30.1.jar`, file = path.join(folder, filename);
    let bytes = await fs.readFile(file).catch(() => undefined);
    if (!bytes || createHash('sha256').update(bytes).digest('hex') !== hash) {
      const response = await fetch(`https://repo.maven.apache.org/maven2/org/commonmark/${name}/0.30.1/${filename}`, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`Markdown dependency ${name}: ${response.status}`);
      bytes = Buffer.from(await response.arrayBuffer());
      if (createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error(`Markdown dependency checksum: ${name}`);
      await fs.writeFile(file, bytes);
    }
    files.push(file);
  }
  return files;
}
