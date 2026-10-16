#!/usr/bin/env node
/**
 * Print the raw source brief for one work package.
 *
 * Hand-writing a word starts by reading what the sources actually say, so this
 * tool gathers, for every word in a work package:
 *   - the ECDICT row (definition / translation / part of speech / forms / tags),
 *   - the existing enhanced entry, when the pack carries one,
 *   - and the frozen word-list entry (rank, frequency).
 *
 * It is read-only and prints; it never writes dictionary content.
 *
 * Usage:
 *   node scripts/dictionary/source-brief.mjs --batch batch-001 --work work-001
 */
import fs from 'node:fs';
import path from 'node:path';
import { csvRecords, parseCsvLine, readJsonl, writeFileSafely } from './pack.mjs';
import { normalizeWord } from './spec.mjs';

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function clean(value, limit = 600) {
  const text = String(value ?? '').replace(/\\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

const batchId = argument('--batch', 'batch-001');
const workId = argument('--work');
const listPath = path.resolve(argument('--words', path.join('data/dictionary/revisions/batches', batchId, 'words.json')));
const sourcePath = path.resolve(argument('--source', 'data/dictionary/source/ecdict.csv'));
const enhancedPath = path.resolve(argument('--enhanced', 'data/dictionary/source/enhanced.jsonl'));
const outPath = argument('--out', undefined);

if (!workId && !argument('--range')) throw new Error('Pass --work work-001 (or --range 1-50) to select words.');

const list = JSON.parse(fs.readFileSync(listPath, 'utf8')).words;
let selected = list;
if (workId) {
  const match = /^work-(\d+)$/.exec(workId);
  if (!match) throw new Error(`Invalid work id: ${workId}`);
  const index = Number.parseInt(match[1], 10) - 1;
  selected = list.slice(index * 50, index * 50 + 50);
} else {
  const [from, to] = String(argument('--range')).split('-').map((value) => Number.parseInt(value, 10));
  selected = list.filter((item) => item.rank >= from && item.rank <= to);
}
if (!selected.length) throw new Error('The requested work package is empty.');

const wanted = new Set(selected.map((item) => normalizeWord(item.lemma)));

// --- ECDICT rows ------------------------------------------------------------
const sourceByName = new Map();
{
  const records = csvRecords(fs.readFileSync(sourcePath));
  const header = parseCsvLine(records.next().value ?? '');
  const column = Object.fromEntries(['word', 'phonetic', 'definition', 'translation', 'pos', 'tag', 'bnc', 'frq', 'exchange'].map((field) => [field, header.indexOf(field)]));
  for (const raw of records) {
    const values = parseCsvLine(raw);
    const word = normalizeWord(values[column.word]);
    if (!wanted.has(word) || sourceByName.has(word)) continue;
    sourceByName.set(word, {
      definition: values[column.definition] ?? '',
      translation: values[column.translation] ?? '',
      pos: values[column.pos] ?? '',
      tag: values[column.tag] ?? '',
      frq: values[column.frq] ?? '',
      exchange: values[column.exchange] ?? '',
      phonetic: values[column.phonetic] ?? '',
    });
    if (sourceByName.size === wanted.size) break;
  }
}

// --- enhanced entries -------------------------------------------------------
const enhancedByName = new Map();
for (const item of readJsonl(enhancedPath)) {
  const word = normalizeWord(item.word);
  if (!wanted.has(word) || enhancedByName.has(word)) continue;
  enhancedByName.set(word, item.entry);
}

// --- brief ------------------------------------------------------------------
const lines = [`# Source brief — ${batchId} / ${workId ?? 'range'}`, `words: ${selected.length}`, ''];
for (const item of selected) {
  const source = sourceByName.get(item.lemma);
  const enhanced = enhancedByName.get(item.lemma);
  lines.push(`## ${item.rank}. ${item.lemma}  (frq=${item.frequency ?? 'n/a'})`);
  if (!source) {
    lines.push('- ECDICT: (no source row)');
  } else {
    lines.push(`- ECDICT pos: ${clean(source.pos, 120) || '(none)'} | tag: ${clean(source.tag, 60) || '(none)'} | phonetic: ${clean(source.phonetic, 60) || '(none)'}`);
    lines.push(`- ECDICT definition: ${clean(source.definition) || '(none)'}`);
    lines.push(`- ECDICT translation: ${clean(source.translation) || '(none)'}`);
    lines.push(`- ECDICT exchange: ${clean(source.exchange, 300) || '(none)'}`);
  }
  if (enhanced) {
    const definitions = Array.isArray(enhanced.definitions) ? enhanced.definitions.slice(0, 8) : [];
    lines.push(`- enhanced definitions (${Array.isArray(enhanced.definitions) ? enhanced.definitions.length : 0}):`);
    for (const definition of definitions) {
      lines.push(`    - pos=${clean(definition.partOfSpeech ?? definition.pos, 24) || '-'} en="${clean(definition.en, 220)}" zh="${clean(definition.zh, 160)}"`);
    }
    if (Array.isArray(enhanced.zhDefinitions) && enhanced.zhDefinitions.length) {
      lines.push(`- enhanced zhDefinitions: ${clean(JSON.stringify(enhanced.zhDefinitions).slice(0, 500), 500)}`);
    }
  } else {
    lines.push('- enhanced: (none)');
  }
  lines.push('');
}

const brief = `${lines.join('\n')}\n`;
if (outPath) {
  writeFileSafely(path.resolve(outPath), brief);
  console.log(JSON.stringify({ ok: true, words: selected.length, outPath: path.relative(process.cwd(), path.resolve(outPath)).replaceAll('\\', '/') }, null, 2));
} else {
  process.stdout.write(brief);
}
