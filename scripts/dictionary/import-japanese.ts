import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { convertJapaneseRecord, JAPANESE_PACK_FORMAT, JAPANESE_INDEX_VERSION, JAPANESE_CHINESE_PROVENANCE,
  JAPANESE_CHINESE_WIKTIONARY_ID, type WiktionaryJapaneseRecord } from '../../packages/dictionary/server/wiktionaryJapanese';
import { normalizeJapaneseSurface } from '../../packages/dictionary/languages/japaneseSurface';

export const JAPANESE_CHINESE_SOURCE_URLS = [
  'https://kaikki.org/zhwiktionary/%E6%97%A5%E8%AF%AD/kaikki.org-dictionary-%E6%97%A5%E8%AF%AD.jsonl',
  'https://kaikki.org/zhwiktionary/%E6%97%A5%E8%AA%9E/kaikki.org-dictionary-%E6%97%A5%E8%AA%9E.jsonl',
] as const;
async function fileHash(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}
function licenseText(sourceUrls: readonly string[]): string {
  return `Japanese entries from Chinese Wiktionary, extracted by Kaikki / Wiktextract.
Attribution: Chinese Wiktionary contributors. Individual entry histories are accessible from each linked Wiktionary page.
Data sources: ${sourceUrls.join('\n')}
Extraction project: https://github.com/tatuylonen/wiktextract
Source licensing: https://zh.wiktionary.org/wiki/Wiktionary:版权信息
Text is available under CC BY-SA 4.0 and the GNU Free Documentation License.
CC BY-SA 4.0: https://creativecommons.org/licenses/by-sa/4.0/
GFDL: https://www.gnu.org/licenses/fdl-1.3.html
Changes: selected Japanese entries; converted Chinese definitions and examples;
indexed Japanese readings, source-declared forms, alternatives and explicit form-of relationships;
added finite tense/polarity variants only to the source's explicit verb polite ます forms;
normalized lookup aliases with NFKC; stored an offline SQLite index.
No generated definitions, translation services or unconstrained suffix rules were added.
`;
}

/** A complete manifest publishes a reproducible pack; existing dictionaries are never overwritten. */
export async function importJapaneseDictionary(options: {
  sourceFile?: string; sourceFiles?: readonly string[]; outputDir: string; sourceUrls?: readonly string[];
}) {
  const files = [...(options.sourceFile ? [options.sourceFile] : []), ...(options.sourceFiles ?? [])];
  if (!files.length || files.some(file => typeof file !== 'string' || !file.trim())
    || new Set(files.map(file => path.resolve(file))).size !== files.length) throw new Error('Choose one or more distinct Japanese JSONL snapshots.');
  const sourceUrls = options.sourceUrls ? [...options.sourceUrls] : [...JAPANESE_CHINESE_SOURCE_URLS].slice(0, files.length);
  if (sourceUrls.length !== files.length || sourceUrls.some(url => typeof url !== 'string' || !/^https:\/\//.test(url))) {
    throw new Error('Each Japanese source snapshot needs its own HTTPS source URL.');
  }
  const sources = await Promise.all(files.map(async (file, index) => ({ sourceUrl: sourceUrls[index],
    sourceSha256: await fileHash(file), sourceBytes: (await fs.stat(file)).size })));
  const sourceSha256 = createHash('sha256').update(JSON.stringify(sources.map(source => source.sourceSha256))).digest('hex');
  const contentVersion = `${JAPANESE_CHINESE_WIKTIONARY_ID}:${sourceSha256}`;
  await fs.mkdir(options.outputDir, { recursive: true });
  const finalFile = path.join(options.outputDir, 'dictionary.sqlite');
  try { await fs.access(finalFile); throw new Error('A Japanese dictionary already exists here; choose a new output directory.'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const staging = path.join(options.outputDir, `dictionary-${randomUUID()}.sqlite`);
  const database = new DatabaseSync(staging); let entryCount = 0; let recordCount = 0; let closed = false;
  try {
    database.exec(`PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;
      CREATE TABLE entries (id TEXT PRIMARY KEY, headword TEXT NOT NULL, key TEXT NOT NULL, pos TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE lookups (surface TEXT NOT NULL, target TEXT NOT NULL, pos TEXT NOT NULL, kind TEXT NOT NULL,
        PRIMARY KEY(surface, target, pos, kind)) WITHOUT ROWID; BEGIN;`);
    const insertEntry = database.prepare('INSERT INTO entries VALUES (?, ?, ?, ?, ?)');
    const insertLink = database.prepare('INSERT OR IGNORE INTO lookups VALUES (?, ?, ?, ?)');
    for (const file of files) {
      const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line.trim()) continue;
        recordCount++;
        const raw = JSON.parse(line) as WiktionaryJapaneseRecord;
        const converted = convertJapaneseRecord(raw, `ja-zh:${recordCount}`, contentVersion);
        if (converted.entry) {
          const entry = converted.entry; const key = normalizeJapaneseSurface(entry.headword);
          insertEntry.run(entry.entryId, entry.headword, key, raw.pos ?? '', JSON.stringify(entry));
          insertLink.run(key, key, '', 'exact'); entryCount++;
        }
        for (const link of converted.links) insertLink.run(link.surface, link.target, link.pos, link.kind);
        if (recordCount % 10_000 === 0) database.exec('COMMIT; BEGIN;');
      }
    }
    if (!entryCount) throw new Error('The source contains no usable Japanese dictionary entries.');
    database.exec('COMMIT; CREATE INDEX entries_key ON entries(key); CREATE INDEX entries_headword ON entries(headword);');
    const count = (kind: string) => database.prepare('SELECT COUNT(*) AS count FROM lookups WHERE kind = ?').get(kind)!.count as number;
    const relationCount = count('inflection'); const readingCount = count('reading'); const alternativeCount = count('alternative');
    const headwordCount = database.prepare('SELECT COUNT(DISTINCT key) AS count FROM entries').get()!.count as number;
    database.close(); closed = true;
    const manifest = { format: JAPANESE_PACK_FORMAT, indexVersion: JAPANESE_INDEX_VERSION, dictionaryId: JAPANESE_CHINESE_WIKTIONARY_ID,
      definitionLanguage: 'zh', contentVersion, sourceUrls, sources, sourceSha256,
      sourceBytes: sources.reduce((sum, source) => sum + source.sourceBytes, 0), recordCount, entryCount, headwordCount,
      relationCount, readingCount, alternativeCount, databaseBytes: (await fs.stat(staging)).size,
      databaseSha256: await fileHash(staging), provenance: JAPANESE_CHINESE_PROVENANCE, license: 'CC-BY-SA-4.0 / GFDL' };
    await fs.rename(staging, finalFile);
    await fs.writeFile(path.join(options.outputDir, 'LICENSE.txt'), licenseText(sourceUrls));
    await fs.writeFile(path.join(options.outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    return manifest;
  } catch (error) {
    if (!closed) database.close();
    await fs.unlink(staging).catch(() => {});
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length % 2 || args.some((arg, index) => index % 2 === 0 && !['--source', '--output'].includes(arg))) {
    throw new Error('Usage: npm run dictionary:import-japanese -- --source file.jsonl --source another.jsonl [--output directory]');
  }
  const pairs = Array.from({ length: args.length / 2 }, (_, i) => [args[i * 2], args[i * 2 + 1]]);
  const sourceFiles = pairs.filter(([key]) => key === '--source').map(([, value]) => value);
  if (!sourceFiles.length) throw new Error('--source must point to downloaded Kaikki Japanese JSONL snapshots.');
  const outputDir = pairs.find(([key]) => key === '--output')?.[1] ?? `data/dictionary/imported/${JAPANESE_CHINESE_WIKTIONARY_ID}`;
  console.log(JSON.stringify(await importJapaneseDictionary({ sourceFiles, outputDir }), null, 2));
}
