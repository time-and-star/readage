import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { convertFrenchRecord, FRENCH_PACK_FORMAT, FRENCH_INDEX_VERSION, FRENCH_DICTIONARY_EDITIONS,
  type FrenchDictionaryEdition, type WiktionaryFrenchRecord } from '../../packages/dictionary/server/wiktionaryFrench';
import { normalizeFrenchSurface } from '../../packages/dictionary/languages/frenchSurface';

export const FRENCH_SOURCE_URL = 'https://kaikki.org/dictionary/French/kaikki.org-dictionary-French.jsonl';
export const FRENCH_CHINESE_SOURCE_URLS = [
  'https://kaikki.org/zhwiktionary/%E6%B3%95%E8%AF%AD/kaikki.org-dictionary-%E6%B3%95%E8%AF%AD.jsonl',
  'https://kaikki.org/zhwiktionary/%E6%B3%95%E8%AA%9E/kaikki.org-dictionary-%E6%B3%95%E8%AA%9E.jsonl',
] as const;
function licenseText(edition: FrenchDictionaryEdition, sourceUrls: readonly string[]): string {
  const profile = FRENCH_DICTIONARY_EDITIONS[edition];
  return `French entries from ${edition === 'en' ? 'English' : 'Chinese'} Wiktionary, extracted by Kaikki / Wiktextract.
Attribution: Wiktionary contributors. Individual entry history is accessible from each linked Wiktionary page.
Data sources: ${sourceUrls.join('\n')}
Extraction project: https://github.com/tatuylonen/wiktextract
Source licensing: ${profile.provenance.find(item => item.kind === 'license')!.detail}
Text is available under CC BY-SA 4.0 and the GNU Free Documentation License.
CC BY-SA 4.0: https://creativecommons.org/licenses/by-sa/4.0/
GFDL: https://www.gnu.org/licenses/fdl-1.3.html
Changes: selected French entries; converted definitions, examples, pronunciations and explicit form relations;
excluded pure form-of senses from main definitions while retaining their lookup relationships;
indexed normalized spelling without removing accents; stored an offline SQLite index.
No generated definitions or inferred suffix rules were added.
`;
}

export async function fileHash(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}

/** Import is reproducible from the source snapshot; a manifest is written only after a complete build. */
export async function importFrenchDictionary(options: {
  sourceFile?: string; sourceFiles?: readonly string[]; outputDir: string;
  sourceUrl?: string; sourceUrls?: readonly string[]; edition?: FrenchDictionaryEdition;
}) {
  const edition = options.edition ?? 'en';
  const profile = FRENCH_DICTIONARY_EDITIONS[edition];
  const files = [...(options.sourceFile ? [options.sourceFile] : []), ...(options.sourceFiles ?? [])];
  if (!files.length || files.some(file => typeof file !== 'string' || !file.trim())
    || new Set(files.map(file => path.resolve(file))).size !== files.length) throw new Error('Choose one or more distinct French JSONL snapshots.');
  const sourceUrls = options.sourceUrls ? [...options.sourceUrls]
    : options.sourceUrl ? files.map(() => options.sourceUrl!) : edition === 'en' ? files.map(() => FRENCH_SOURCE_URL) : [...FRENCH_CHINESE_SOURCE_URLS].slice(0, files.length);
  if (sourceUrls.length !== files.length || sourceUrls.some(url => typeof url !== 'string' || !/^https:\/\//.test(url))) {
    throw new Error('Each French source snapshot needs its own HTTPS source URL.');
  }
  const sources = await Promise.all(files.map(async (file, index) => ({ sourceUrl: sourceUrls[index],
    sourceSha256: await fileHash(file), sourceBytes: (await fs.stat(file)).size })));
  // A single English snapshot retains its established version token. Combined snapshots cover every input in order.
  const sourceSha256 = sources.length === 1 ? sources[0].sourceSha256
    : createHash('sha256').update(JSON.stringify(sources.map(source => source.sourceSha256))).digest('hex');
  const contentVersion = `${profile.id}:${sourceSha256}`;
  await fs.mkdir(options.outputDir, { recursive: true });
  const finalFile = path.join(options.outputDir, 'dictionary.sqlite');
  try { await fs.access(finalFile); throw new Error('A French dictionary already exists here; choose a new output directory.'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const staging = path.join(options.outputDir, `dictionary-${randomUUID()}.sqlite`);
  const database = new DatabaseSync(staging);
  let entryCount = 0;
  let recordCount = 0;
  let closed = false;
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
        const raw = JSON.parse(line) as WiktionaryFrenchRecord;
        const converted = convertFrenchRecord(raw, `${edition === 'en' ? 'fr' : 'fr-zh'}:${recordCount}`, contentVersion, edition);
        if (converted.entry) {
          const entry = converted.entry;
          const key = normalizeFrenchSurface(entry.headword);
          insertEntry.run(entry.entryId, entry.headword, key, raw.pos ?? '', JSON.stringify(entry));
          insertLink.run(key, key, '', 'exact');
          entryCount++;
        }
        for (const link of converted.links) insertLink.run(link.surface, link.target, link.pos, link.kind);
        if (recordCount % 10_000 === 0) { database.exec('COMMIT; BEGIN;'); }
      }
    }
    if (!entryCount) throw new Error('The source contains no usable French dictionary entries.');
    database.exec('COMMIT; CREATE INDEX entries_key ON entries(key); CREATE INDEX entries_headword ON entries(headword);');
    const relationCount = database.prepare("SELECT COUNT(*) AS count FROM lookups WHERE kind = 'inflection'").get()!.count as number;
    const headwordCount = database.prepare('SELECT COUNT(DISTINCT key) AS count FROM entries').get()!.count as number;
    database.close(); closed = true;
    const manifest = { format: FRENCH_PACK_FORMAT, indexVersion: FRENCH_INDEX_VERSION, edition, dictionaryId: profile.id,
      contentVersion, sourceUrl: sourceUrls[0], sourceUrls, sources, sourceSha256,
      sourceBytes: sources.reduce((sum, source) => sum + source.sourceBytes, 0), recordCount, entryCount, headwordCount, relationCount,
      databaseBytes: (await fs.stat(staging)).size, databaseSha256: await fileHash(staging), provenance: profile.provenance,
      license: 'CC-BY-SA-4.0 / GFDL', definitionLanguage: profile.definitionLanguage };
    await fs.rename(staging, finalFile);
    await fs.writeFile(path.join(options.outputDir, 'LICENSE.txt'), licenseText(edition, sourceUrls));
    await fs.writeFile(path.join(options.outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    return manifest;
  } catch (error) {
    if (!closed) database.close();
    // Only the exact temporary file created by this invocation is removed.
    await fs.unlink(staging).catch(() => {});
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length % 2 || args.some((arg, i) => i % 2 === 0 && !['--source', '--source-add', '--output', '--edition'].includes(arg))) {
    throw new Error('Usage: npm run dictionary:import-french -- --source file.jsonl [--source another.jsonl] [--edition en|zh] [--output directory]');
  }
  const pairs = Array.from({ length: args.length / 2 }, (_, i) => [args[i * 2], args[i * 2 + 1]]);
  const values = Object.fromEntries(pairs);
  const sourceFiles = pairs.filter(([key]) => key === '--source' || key === '--source-add').map(([, value]) => value);
  if (!sourceFiles.length) throw new Error('--source must point to a downloaded Kaikki French JSONL snapshot.');
  const edition = values['--edition'] ?? 'en';
  if (edition !== 'en' && edition !== 'zh') throw new Error('--edition must be en or zh.');
  const manifest = await importFrenchDictionary({ sourceFiles, edition,
    outputDir: values['--output'] ?? `data/dictionary/imported/${FRENCH_DICTIONARY_EDITIONS[edition].id}` });
  console.log(JSON.stringify(manifest, null, 2));
}
