import fs from 'node:fs';
import path from 'node:path';
import { makeMdxFixture } from '../tests/helpers/mdxFixture';
import { mdxHash, MdxDictionaryAdapter, preflightMdx } from '../packages/dictionary/server/mdxAdapter';

const root = path.resolve('tmp/android-tools/mdx-parity-fixtures');
fs.mkdirSync(root, { recursive: true });
const variants = [
  { name: 'v2-utf8', options: {} },
  { name: 'v1-plain', options: { version: 1.2 as const, compressed: false } },
  { name: 'v2-encrypted-utf16', options: { encoding: 'UTF-16' as const, encryptedKeyInfo: true, recordBlockBytes: 30, keysPerBlock: 1 } },
];
for (const { name, options } of variants) {
  const bytes = makeMdxFixture(options), sha256 = mdxHash(bytes), inspected = preflightMdx(bytes), filename = `${name}.mdx`, file = path.join(root, filename);
  fs.writeFileSync(file, bytes);
  const adapter = new MdxDictionaryAdapter({ file, manifest: { format: 'dictionary-mdx-import.v1', dictionaryId: `mdx-${sha256}`, name, language: 'en',
    sha256, bytes: bytes.length, entryCount: inspected.entryCount, filename } });
  const expected = [];
  for (const word of ['bank', 'banks', 'run', 'running', '𠮷']) {
    const [match] = await adapter.lookup({ text: word, language: 'en', candidates: [{ text: word, kind: 'exact' }] });
    expected.push({ query: word, id: match.entry.entryId, headword: match.entry.headword, content: match.entry.content });
  }
  fs.writeFileSync(path.join(root, `${name}.json`), JSON.stringify(expected)); adapter.dispose();
}
fs.writeFileSync(path.join(root, 'folded.mdx'), makeMdxFixture({ entries: [{ key: 'Mixed', html: '<p>Mixed definition.</p>' }] }));
fs.writeFileSync(path.join(root, 'case-sensitive.mdx'), makeMdxFixture({ caseSensitive: true, entries: [{ key: 'Mixed', html: '<p>Mixed definition.</p>' }] }));
fs.writeFileSync(path.join(root, 'cyclic.mdx'), makeMdxFixture({ entries: [{ key: 'bank', html: '@@@LINK=banks' }, { key: 'banks', html: '@@@LINK=bank' }] }));
const damaged = makeMdxFixture(); damaged[damaged.length - 1] ^= 1; fs.writeFileSync(path.join(root, 'damaged.mdx'), damaged);
console.log('Generated isolated MDX corpus and Node reference entries.');
