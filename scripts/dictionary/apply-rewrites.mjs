#!/usr/bin/env node
/**
 * Apply rewritten definitions for senses that had been copied from the source.
 *
 * The point of the rewrite is that the new wording must NOT come from the
 * source, so this tool rejects any replacement that still appears verbatim in
 * the source definition text. It also refuses to touch anything but the
 * definition fields: parts of speech, sense structure and examples stay as they
 * are unless a rewrite also supplies a new example.
 *
 * Usage:
 *   node scripts/dictionary/apply-rewrites.mjs --file tmp/dict-rewrite/work-031.fixes.jsonl --check
 *   node scripts/dictionary/apply-rewrites.mjs --file tmp/dict-rewrite/work-031.fixes.jsonl
 */
import fs from 'node:fs';
import path from 'node:path';
import { csvRecords, parseCsvLine, writeFileSafely } from './pack.mjs';
import { normalizeWord } from './spec.mjs';

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function flag(name) {
  return process.argv.includes(name);
}

const norm = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const batchId = argument('--batch', 'batch-001');
const filePath = argument('--file');
if (!filePath) throw new Error('Pass --file <fixes.jsonl>');
const checkOnly = flag('--check');

const batchDir = path.resolve('data/dictionary/revisions/batches', batchId);
const revisionPath = path.join(batchDir, 'revisions.jsonl');
const frozen = JSON.parse(fs.readFileSync(path.join(batchDir, 'words.json'), 'utf8')).words.map((item) => item.lemma);
const allowed = new Set(frozen);

// --- source text, to prove the replacement is not a copy --------------------
// Index the ECDICT definition column and the enhanced area: a gloss can be
// copied from either, so checking only one of them lets a copy slip through.
const source = new Map();
const addSource = (word, text) => {
  if (!word) return;
  const value = norm(text);
  if (!value) return;
  source.set(word, source.has(word) ? `${source.get(word)} \u0000 ${value}` : value);
};
{
  const records = csvRecords(fs.readFileSync(path.resolve('data/dictionary/source/ecdict.csv')));
  const header = parseCsvLine(records.next().value ?? '');
  const wordColumn = header.indexOf('word');
  const definitionColumn = header.indexOf('definition');
  for (const raw of records) {
    const values = parseCsvLine(raw);
    addSource(normalizeWord(values[wordColumn]), values[definitionColumn]);
  }
}
{
  const enhancedPath = path.resolve('data/dictionary/source/enhanced.jsonl');
  if (fs.existsSync(enhancedPath)) {
    for (const line of fs.readFileSync(enhancedPath, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      let item;
      try { item = JSON.parse(line); } catch { continue; }
      const word = normalizeWord(item.word);
      for (const definition of Array.isArray(item.entry?.definitions) ? item.entry.definitions : []) {
        addSource(word, definition?.en);
        addSource(word, definition?.definitionEn);
      }
    }
  }
}

// --- read the fixes ---------------------------------------------------------
const raw = fs.readFileSync(path.resolve(filePath), 'utf8');
const problems = [];
if (raw.length > 0 && !raw.endsWith('\n')) problems.push('fixes file does not end with a newline');
if (/\r/.test(raw)) problems.push('fixes file contains CR characters');
const fixes = [];
raw.trim().split(/\r?\n/).filter(Boolean).forEach((line, index) => {
  const where = `line ${index + 1}`;
  let value;
  try {
    value = JSON.parse(line);
  } catch (error) {
    problems.push(`${where}: invalid JSON (${error.message.slice(0, 70)})`);
    return;
  }
  const lemma = normalizeWord(value.lemma);
  const senseId = String(value.senseId ?? '').trim();
  const definitionEn = String(value.definitionEn ?? '').trim();
  if (!allowed.has(lemma)) { problems.push(`${where}: "${lemma}" is not in this batch`); return; }
  if (!senseId) { problems.push(`${where} (${lemma}): missing senseId`); return; }
  if (definitionEn.length < 8) { problems.push(`${where} (${lemma}): replacement definition is too short`); return; }
  const sourceText = source.get(lemma);
  if (sourceText && sourceText.includes(norm(definitionEn))) {
    problems.push(`${where} (${lemma}): the replacement is still copyable from the source — ${definitionEn}`);
  }
  if (value.definitionZh !== undefined && /[""]/.test(String(value.definitionZh))) {
    problems.push(`${where} (${lemma}): Chinese definition contains a straight double quote`);
  }
  if (value.example && (!String(value.example.en ?? '').trim() || !String(value.example.zh ?? '').trim())) {
    problems.push(`${where} (${lemma}): a supplied example must be bilingual`);
  }
  fixes.push({
    lemma,
    senseId,
    definitionEn,
    ...(value.definitionZh !== undefined ? { definitionZh: String(value.definitionZh).trim() } : {}),
    ...(value.example ? { example: { en: String(value.example.en).trim(), zh: String(value.example.zh).trim() } } : {}),
    ...(value.note ? { note: String(value.note).trim() } : {}),
  });
});

// --- resolve each fix against the current batch ------------------------------
const revisions = fs.readFileSync(revisionPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const byLemma = new Map(revisions.map((record) => [record.lemma, record]));
const pending = [];
for (const fix of fixes) {
  const record = byLemma.get(fix.lemma);
  const sense = record?.partOfSpeechGroups.flatMap((group) => group.senses).find((item) => item.id === fix.senseId);
  if (!sense) { problems.push(`${fix.lemma}: sense ${fix.senseId} not found`); continue; }
  pending.push({ fix, sense });
}

if (problems.length) {
  console.log(JSON.stringify({ ok: false, mode: checkOnly ? 'check' : 'apply', file: filePath, fixes: fixes.length, problems }, null, 2));
  process.exitCode = 1;
} else {
  let changed = 0;
  if (!checkOnly) {
    for (const { fix, sense } of pending) {
      if (sense.definitionEn !== fix.definitionEn) { sense.definitionEn = fix.definitionEn; changed += 1; }
      if (fix.definitionZh && sense.definitionZh !== fix.definitionZh) sense.definitionZh = fix.definitionZh;
      if (fix.example) {
        for (const example of sense.examples ?? []) {
          if (example.id === sense.id) { example.en = fix.example.en; example.zh = fix.example.zh; }
        }
      }
    }
    const touched = new Set(pending.map(({ fix }) => fix.lemma));
    for (const lemma of touched) {
      const record = byLemma.get(lemma);
      const reason = 'Rewrote a definition that had been copied from the source instead of written for a learner.';
      if (!record.edit.changeNote.includes(reason)) record.edit.changeNote = `${record.edit.changeNote.replace(/\s*$/, ' ')}${reason}`.trim();
    }
    fs.writeFileSync(revisionPath, `${revisions.map((record) => JSON.stringify(record)).join('\n')}\n`);
  }
  console.log(JSON.stringify({
    ok: true,
    mode: checkOnly ? 'check' : 'apply',
    file: filePath,
    fixes: fixes.length,
    changed,
    lemmas: new Set(pending.map(({ fix }) => fix.lemma)).size,
  }, null, 2));
}
