#!/usr/bin/env node
/**
 * Detect definitions copied verbatim from the source.
 *
 * The spec requires every definition to be *written*, with the source used as
 * material — not pasted. This check normalises both sides and flags any sense
 * whose English definition appears verbatim inside the source definition text.
 *
 * Two tiers, because a 25-character generic phrase can coincide by accident
 * while a long WordNet gloss with semicolons cannot:
 *   tier1 — 40+ characters, or contains ';' / '(' → clearly a copied gloss
 *   tier2 — 25–39 characters → possible coincidence, needs a human glance
 *
 * Usage:
 *   node scripts/dictionary/check-source-copy.mjs --batch batch-001 [--out tmp/dict-review/source-copy.json]
 * Exit code is 1 when any tier-1 copy is found, so it can gate a pipeline.
 */
import fs from 'node:fs';
import path from 'node:path';
import { csvRecords, parseCsvLine, writeJsonSafely } from './pack.mjs';
import { normalizeWord } from './spec.mjs';

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const norm = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const batchId = argument('--batch', 'batch-001');
const minLength = Number.parseInt(argument('--min-length', '25'), 10);
const sourcePath = path.resolve(argument('--source', 'data/dictionary/source/ecdict.csv'));
const batchDir = path.resolve('data/dictionary/revisions/batches', batchId);

// --- index the source -------------------------------------------------------
// Both the ECDICT `definition` column AND the enhanced area carry WordNet-style
// glosses, and a copy can come from either. Indexing only ECDICT misses the
// sentence-cased, period-terminated glosses that come from the enhanced side.
const source = new Map();
const addSource = (word, text) => {
  if (!word) return;
  const value = norm(text);
  if (!value) return;
  source.set(word, source.has(word) ? `${source.get(word)} \u0000 ${value}` : value);
};

{
  const records = csvRecords(fs.readFileSync(sourcePath));
  const header = parseCsvLine(records.next().value ?? '');
  const wordColumn = header.indexOf('word');
  const definitionColumn = header.indexOf('definition');
  if (wordColumn < 0 || definitionColumn < 0) throw new Error('Source CSV is missing word/definition columns.');
  for (const raw of records) {
    const values = parseCsvLine(raw);
    addSource(normalizeWord(values[wordColumn]), values[definitionColumn]);
  }
}
{
  const enhancedPath = path.resolve(argument('--enhanced', 'data/dictionary/source/enhanced.jsonl'));
  if (fs.existsSync(enhancedPath)) {
    for (const line of fs.readFileSync(enhancedPath, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      let item;
      try { item = JSON.parse(line); } catch { continue; }
      const word = normalizeWord(item.word);
      if (!word) continue;
      const definitions = Array.isArray(item.entry?.definitions) ? item.entry.definitions : [];
      for (const definition of definitions) {
        addSource(word, definition?.en);
        addSource(word, definition?.definitionEn);
      }
    }
  }
}

// --- scan the batch ---------------------------------------------------------
const revisions = fs.readFileSync(path.join(batchDir, 'revisions.jsonl'), 'utf8')
  .trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const frozen = JSON.parse(fs.readFileSync(path.join(batchDir, 'words.json'), 'utf8')).words;

const tier1 = [];
const tier2 = [];
const byPackage = {};
let checked = 0;

revisions.forEach((revision, index) => {
  const sourceText = source.get(revision.lemma);
  if (!sourceText) return;
  const pkg = `work-${String(Math.floor(index / 50) + 1).padStart(3, '0')}`;
  for (const group of revision.partOfSpeechGroups ?? []) {
    for (const sense of group.senses ?? []) {
      checked += 1;
      const definition = norm(sense.definitionEn);
      if (definition.length < minLength || !sourceText.includes(definition)) continue;
      const entry = {
        package: pkg,
        lemma: revision.lemma,
        rank: frozen.find((item) => item.lemma === revision.lemma)?.rank ?? null,
        senseId: sense.id,
        partOfSpeech: group.partOfSpeech,
        definitionEn: sense.definitionEn,
        definitionZh: sense.definitionZh ?? null,
      };
      const copied = sense.definitionEn.length >= 40 || /[;()]/.test(sense.definitionEn);
      (copied ? tier1 : tier2).push(entry);
      byPackage[pkg] = (byPackage[pkg] ?? 0) + 1;
    }
  }
});

const report = {
  format: 'dictionary-source-copy.v1',
  batchId,
  sensesChecked: checked,
  tier1Count: tier1.length,
  tier2Count: tier2.length,
  copiedFraction: checked ? Number(((tier1.length + tier2.length) / checked).toFixed(4)) : 0,
  byPackage: Object.fromEntries(Object.entries(byPackage).sort((left, right) => right[1] - left[1])),
  tier1,
  tier2,
};

// `--package work-031` narrows the report to one work package, so a rewrite job
// can be handed out and verified package by package.
const only = argument('--package', undefined);
const scoped = only ? { tier1: tier1.filter((item) => item.package === only), tier2: tier2.filter((item) => item.package === only) } : { tier1, tier2 };
if (only) {
  report.scope = only;
  report.tier1 = scoped.tier1;
  report.tier2 = scoped.tier2;
  report.tier1Count = scoped.tier1.length;
  report.tier2Count = scoped.tier2.length;
}

const outPath = path.resolve(argument('--out', `data/dictionary/reports/source-copy-${batchId}${only ? `-${only}` : ''}.json`));
writeJsonSafely(outPath, report);

console.log(JSON.stringify({
  ok: scoped.tier1.length === 0,
  batchId,
  scope: only ?? 'whole batch',
  sensesChecked: checked,
  tier1Count: scoped.tier1.length,
  tier2Count: scoped.tier2.length,
  copiedPercent: `${((scoped.tier1.length + scoped.tier2.length) / Math.max(1, checked) * 100).toFixed(1)}%`,
  worstPackages: Object.entries(report.byPackage).slice(0, 6),
  reportPath: path.relative(process.cwd(), outPath).replaceAll('\\', '/'),
}, null, 2));
if (scoped.tier1.length) process.exitCode = 1;
