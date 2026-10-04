#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { csvRecords, normalizeWord, parseCsvLine, readJsonl, sha256, writeJsonSafely } from './pack.mjs';

const POS_RE = /^(?:n|v|vi|vt|a|s|r|adj|adv|prep|pron|conj|int|interj)\.?$/i;

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function clean(value) {
  return String(value ?? '').replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseDefinitionLines(value) {
  const definitions = [];
  for (const raw of String(value ?? '').split(/\\n|\r?\n/)) {
    const line = clean(raw);
    if (!line) continue;
    const match = line.match(/^((?:n|v|vi|vt|a|s|r|adj|adv|prep|pron|conj|int|interj)\.?)\s+(.+)$/i);
    if (match) definitions.push({ pos: match[1], text: match[2] });
    else if (definitions.length) definitions.at(-1).text = `${definitions.at(-1).text} ${line}`;
    else definitions.push({ pos: '', text: line });
  }
  return definitions;
}

function meaningCount(value) {
  return clean(value).split(/[,，;；]/).map((item) => item.trim()).filter(Boolean).length;
}

function normalizedDefinition(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function enhancedEnglishAndChinese(enhanced) {
  const definitions = Array.isArray(enhanced?.definitions) ? enhanced.definitions : [];
  return {
    hasEnglish: definitions.some((item) => clean(item.en)),
    hasChinese: definitions.some((item) => clean(item.zh)) || Array.isArray(enhanced?.zhDefinitions) && enhanced.zhDefinitions.some((item) => clean(item.zh ?? item.definitionZh)),
    definitions,
  };
}

export function buildQualityReport(rows, enhancedByWord, sourceSha256) {
  const metrics = {
    totalRows: rows.length,
    uniqueWords: new Set(rows.map((row) => normalizeWord(row.word)).filter(Boolean)).size,
    missingEnglish: [],
    missingChinese: [],
    duplicateDefinitions: [],
    abnormalPartOfSpeech: [],
    concatenatedDefinitions: [],
    unpairedChinese: [],
    abnormalWordShape: [],
  };

  for (const row of rows) {
    const word = normalizeWord(row.word);
    const enhanced = enhancedByWord.get(word);
    const enhancedState = enhancedEnglishAndChinese(enhanced);
    const definitions = parseDefinitionLines(row.definition);
    const hasEnglish = definitions.some((item) => clean(item.text)) || enhancedState.hasEnglish;
    const hasChinese = Boolean(clean(row.translation)) || enhancedState.hasChinese;
    if (!hasEnglish) metrics.missingEnglish.push(word);
    if (!hasChinese) metrics.missingChinese.push(word);

    const seen = new Set();
    for (const definition of definitions) {
      const pos = definition.pos.toLowerCase().replace(/\.$/, '');
      if (pos && !POS_RE.test(definition.pos)) metrics.abnormalPartOfSpeech.push(`${word}\t${definition.pos}`);
      const key = `${pos}:${normalizedDefinition(definition.text)}`;
      if (key.endsWith(':') || !normalizedDefinition(definition.text)) continue;
      if (seen.has(key)) metrics.duplicateDefinitions.push(`${word}\t${definition.pos}\t${clean(definition.text)}`);
      seen.add(key);
    }

    const definitionText = clean(row.definition);
    if (definitionText.length > 240 || /(?:^|\s)[a-z]{1,3}\s+[^;]{2,}\s+v\s+/i.test(definitionText) || (meaningCount(definitionText) >= 6 && /\bv\.?\b/i.test(definitionText))) {
      metrics.concatenatedDefinitions.push(`${word}\t${definitionText}`);
    }

    if (clean(row.translation) && !enhancedState.hasChinese) {
      metrics.unpairedChinese.push(`${word}\t${clean(row.translation)}`);
    }
    if (!/^[a-z][a-z'’-]*$/i.test(word)) metrics.abnormalWordShape.push(`${word}\t${clean(row.translation || row.definition)}`);
  }

  const lists = Object.fromEntries(Object.entries(metrics).filter(([, value]) => Array.isArray(value)).map(([name, value]) => [name, [...new Set(value)].sort()]));
  return {
    format: 'dictionary-quality-report.v1',
    schemaVersion: 'dictionary.v2',
    sourceSha256,
    generatedFrom: 'extracted ECDICT CSV plus enhanced JSONL',
    counts: Object.fromEntries(Object.entries(lists).map(([name, value]) => [name, value.length])),
    totals: { totalRows: metrics.totalRows, uniqueWords: metrics.uniqueWords },
    wordLists: lists,
  };
}

function readRows(sourcePath) {
  const records = csvRecords(fs.readFileSync(sourcePath));
  const header = parseCsvLine(records.next().value ?? '');
  return [...records].map((raw) => {
    const values = parseCsvLine(raw);
    return Object.fromEntries(header.map((key, index) => [key, values[index] ?? '']));
  });
}

function readEnhanced(filePath) {
  return new Map(readJsonl(filePath).map((item) => [normalizeWord(item.word), item.entry]));
}

const sourcePath = path.resolve(argument('--source', 'data/dictionary/source/ecdict.csv'));
const enhancedPath = path.resolve(argument('--enhanced', path.join(path.dirname(sourcePath), 'enhanced.jsonl')));
const outputDir = path.resolve(argument('--out', 'data/dictionary/reports'));
const rows = readRows(sourcePath);
const report = buildQualityReport(rows, readEnhanced(enhancedPath), sha256(sourcePath));
fs.mkdirSync(outputDir, { recursive: true });
for (const [name, values] of Object.entries(report.wordLists)) {
  fs.writeFileSync(path.join(outputDir, `${name}.tsv`), values.length ? `${values.join('\n')}\n` : '');
}
writeJsonSafely(path.join(outputDir, 'quality-report.json'), report);
console.log(JSON.stringify({ ok: true, outputDir, totals: report.totals, counts: report.counts }, null, 2));

