#!/usr/bin/env node
/**
 * Stage 1 — re-lock the 50 sample words against the frozen contract.
 *
 * Two kinds of change happen here, and they are kept visibly separate:
 *
 *  1. CONTENT_PATCHES — the hand-written corrections found during the stage-1
 *     review. Each one states the reason it exists. The script applies them
 *     verbatim; it never invents a definition of its own.
 *
 *  2. PROVENANCE_BACKFILL — mechanical. Every sense, example and collocation
 *     must record where its text came from; the value is derived from the
 *     record's own `edit.source`, never invented.
 *
 * After applying both, every record is checked against the frozen record
 * contract. If any record still fails, the script exits non-zero and writes
 * nothing further — a half-locked sample set is worse than an unlocked one.
 *
 * Idempotent: a second run makes no change.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readJsonl, sha256, writeFileSafely, writeJsonSafely } from './pack.mjs';
import { AUTHORING_METHOD, REVIEW_STATUSES, isValidLemma } from './spec.mjs';
import { validateRecordContract } from './validate-content.mjs';

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const DEFAULT_SOURCE = [{ kind: 'manual', label: 'curated-v1', status: 'confirmed' }];

/**
 * Hand-written corrections from the stage-1 review, in application order.
 * `id` collisions matter: rename the old sense out of the way before reusing
 * its number.
 */
const CONTENT_PATCHES = [
  {
    lemma: 'in',
    op: 'renameSense',
    from: 'in-3',
    to: 'in-4',
    reason: 'Make room for a second time sense under the preposition group.',
  },
  {
    lemma: 'in',
    op: 'replaceSense',
    senseId: 'in-2',
    definitionEn: 'after a period of time has passed',
    definitionZh: '在（一段时间）之后；过（若干时间）',
    example: { en: 'The store closes in ten minutes.', zh: '商店十分钟后关门。' },
    reason: 'The ten-minute example shows "after a period", not "during a period".',
  },
  {
    lemma: 'in',
    op: 'addSense',
    afterSenseId: 'in-2',
    sense: {
      id: 'in-3',
      definitionEn: 'during a period of time',
      definitionZh: '在……期间；在某段时间内',
      example: { en: 'Many birds migrate in autumn.', zh: '许多鸟在秋天迁徙。' },
    },
    reason: 'Give the genuine "during a period" meaning its own sense and example.',
  },
  {
    lemma: 'set',
    op: 'replaceSense',
    senseId: 'set-n-2',
    definitionEn: 'the place where a film or play is made or performed',
    definitionZh: '片场；拍摄或演出场地',
    example: { en: 'The film was shot on set.', zh: '这部电影在片场拍摄。' },
    reason: 'The film example belongs to the film-set sense, not to a group of people.',
  },
  {
    lemma: 'set',
    op: 'addSense',
    afterSenseId: 'set-n-2',
    sense: {
      id: 'set-n-3',
      definitionEn: 'a group of people who meet or spend time together',
      definitionZh: '一伙人；经常来往的一群人',
      example: { en: 'She spends time with a small set of close friends.', zh: '她只和一小群密友来往。' },
    },
    reason: 'Keep the group-of-people meaning that lost its example, with an example of its own.',
  },
  {
    lemma: 'take',
    op: 'replaceExample',
    senseId: 'take-v-4',
    example: { en: 'She took a book from the shelf.', zh: '她从书架上取下一本书。' },
    reason: '"Take an umbrella" shows carrying something with you, not removing it from a place.',
  },
];

/** Reasons appended to a record's changeNote when its content was corrected. */
const CHANGE_NOTES = {
  in: 'Split the two time senses: "after a period of time" now owns the ten-minute example, and "during a period of time" is its own sense.',
  set: 'Split the film-set sense from the group-of-people sense so every example matches the sense it illustrates.',
  take: 'Replaced a carry example that belonged to another sense with one that shows removing something from a place.',
};

function findGroup(record, senseId) {
  return record.partOfSpeechGroups.find((group) => group.senses.some((sense) => sense.id === senseId));
}

/**
 * Array position is the authoritative order; `sortOrder` is only its mirror.
 * Sorting by `sortOrder` here would scramble a freshly inserted sense, whose
 * placeholder order collides with the first sense of its group.
 */
function normalizeSortOrder(record) {
  record.partOfSpeechGroups.forEach((group, groupIndex) => {
    group.sortOrder = groupIndex;
    group.senses.forEach((sense, senseIndex) => { sense.sortOrder = senseIndex; });
  });
}

function buildSense(partOfSpeech, { id, definitionEn, definitionZh, example }) {
  return {
    id,
    definitionEn,
    definitionZh,
    usageLabels: [partOfSpeech],
    sortOrder: 0,
    examples: example ? [{ id, en: example.en, zh: example.zh }] : [],
    collocations: [],
    grammarNotes: [],
  };
}

function applyPatch(record, patch) {
  if (patch.op === 'renameSense') {
    const group = findGroup(record, patch.from);
    if (!group) return false;
    if (record.partOfSpeechGroups.some((item) => item.senses.some((candidate) => candidate.id === patch.to))) return false;
    const sense = group.senses.find((item) => item.id === patch.from);
    sense.id = patch.to;
    for (const example of sense.examples ?? []) example.id = patch.to;
    return true;
  }

  if (patch.op === 'replaceSense') {
    const group = findGroup(record, patch.senseId);
    if (!group) return false;
    const index = group.senses.findIndex((item) => item.id === patch.senseId);
    const existing = group.senses[index];
    const replacement = {
      ...existing,
      definitionEn: patch.definitionEn,
      definitionZh: patch.definitionZh,
      sortOrder: existing.sortOrder,
      examples: patch.example
        ? [{ ...(existing.examples?.[0] ?? {}), id: patch.senseId, en: patch.example.en, zh: patch.example.zh }]
        : existing.examples ?? [],
    };
    const changed = JSON.stringify(existing) !== JSON.stringify(replacement);
    group.senses[index] = replacement;
    return changed;
  }

  if (patch.op === 'addSense') {
    const anchorGroup = findGroup(record, patch.afterSenseId);
    if (!anchorGroup) return false;
    const next = buildSense(anchorGroup.partOfSpeech, patch.sense);
    const existingIndex = anchorGroup.senses.findIndex((item) => item.id === patch.sense.id);
    if (existingIndex >= 0) {
      const existing = anchorGroup.senses[existingIndex];
      const same = existing.definitionEn === next.definitionEn
        && existing.definitionZh === next.definitionZh
        && existing.examples?.[0]?.en === next.examples[0]?.en
        && existing.examples?.[0]?.zh === next.examples[0]?.zh;
      if (same) return false;
      anchorGroup.senses[existingIndex] = { ...existing, ...next, source: existing.source, reviewStatus: existing.reviewStatus };
      return true;
    }
    const index = anchorGroup.senses.findIndex((item) => item.id === patch.afterSenseId);
    anchorGroup.senses.splice(index + 1, 0, next);
    return true;
  }

  if (patch.op === 'replaceExample') {
    const group = findGroup(record, patch.senseId);
    if (!group) return false;
    const sense = group.senses.find((item) => item.id === patch.senseId);
    const current = sense.examples?.[0];
    if (current && current.en === patch.example.en && current.zh === patch.example.zh) return false;
    sense.examples = [{ ...(current ?? {}), id: patch.senseId, en: patch.example.en, zh: patch.example.zh }];
    return true;
  }

  throw new Error(`Unknown patch op: ${patch.op}`);
}

function backfillProvenance(record) {
  let changed = false;
  const edit = record.edit && typeof record.edit === 'object' ? record.edit : (record.edit = {});
  if (!Array.isArray(edit.source) || edit.source.length === 0) { edit.source = structuredClone(DEFAULT_SOURCE); changed = true; }
  if (edit.authoringMethod !== AUTHORING_METHOD) { edit.authoringMethod = AUTHORING_METHOD; changed = true; }
  if (!REVIEW_STATUSES.includes(edit.reviewStatus)) { edit.reviewStatus = 'reviewed'; changed = true; }

  const editSource = structuredClone(edit.source);
  for (const group of record.partOfSpeechGroups ?? []) {
    for (const sense of group.senses ?? []) {
      if (!Array.isArray(sense.source) || sense.source.length === 0) { sense.source = structuredClone(editSource); changed = true; }
      if (!REVIEW_STATUSES.includes(sense.reviewStatus)) { sense.reviewStatus = 'reviewed'; changed = true; }
      for (const example of sense.examples ?? []) {
        if (!example.source) { example.source = structuredClone(editSource); changed = true; }
        if (!REVIEW_STATUSES.includes(example.reviewStatus)) { example.reviewStatus = 'reviewed'; changed = true; }
      }
      for (const collocation of sense.collocations ?? []) {
        if (!collocation.source) { collocation.source = structuredClone(editSource); changed = true; }
        if (!REVIEW_STATUSES.includes(collocation.reviewStatus)) { collocation.reviewStatus = 'reviewed'; changed = true; }
      }
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------
const revisionPath = path.resolve(argument('--revisions', 'data/dictionary/revisions/curated-50.jsonl'));
const reportPath = path.resolve(argument('--report', 'data/dictionary/reports/sample-lock.json'));

const records = readJsonl(revisionPath);
if (records.length !== 50) throw new Error(`Expected 50 sample revisions, found ${records.length}`);
const byLemma = new Map(records.map((record) => [record.lemma, record]));

const applied = [];
for (const patch of CONTENT_PATCHES) {
  const record = byLemma.get(patch.lemma);
  if (!record) throw new Error(`Patch targets unknown lemma: ${patch.lemma}`);
  if (applyPatch(record, patch)) applied.push(`${patch.lemma}:${patch.op}:${patch.senseId ?? patch.sense?.id ?? patch.to ?? ''}`);
}

let provenanceRecords = 0;
const changedRecords = new Set(applied.map((entry) => entry.split(':')[0]));
for (const record of records) {
  if (backfillProvenance(record)) provenanceRecords += 1;
  if (changedRecords.has(record.lemma)) record.changeNoteReason = CHANGE_NOTES[record.lemma];
}
for (const record of records) {
  if (record.changeNoteReason) {
    if (!record.edit.changeNote?.includes(record.changeNoteReason)) {
      record.edit.changeNote = `${record.edit.changeNote ? `${record.edit.changeNote.replace(/\s*$/, ' ')}` : ''}${record.changeNoteReason}`.trim();
    }
    delete record.changeNoteReason;
  }
  normalizeSortOrder(record);
}

// --- every record must satisfy the frozen contract --------------------------
const contractIssues = [];
for (const record of records) {
  if (!isValidLemma(record.lemma)) contractIssues.push({ lemma: record.lemma, issues: ['lemma is not a headword'] });
  const issues = validateRecordContract(record, record.lemma);
  if (issues.length) contractIssues.push({ lemma: record.lemma, issues });
}
if (contractIssues.length) {
  console.error(JSON.stringify({ ok: false, contractIssues }, null, 2));
  throw new Error(`${contractIssues.length} sample records still fail the frozen contract; nothing was written.`);
}

const before = sha256(fs.readFileSync(revisionPath));
const serialized = `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
const after = sha256(serialized);
const changed = before !== after;
if (changed) writeFileSafely(revisionPath, serialized);

writeJsonSafely(reportPath, {
  format: 'dictionary-sample-lock.v1',
  schemaVersion: 'dictionary.v2',
  records: records.length,
  patchesApplied: applied,
  provenanceRecordsBackfilled: provenanceRecords,
  contractIssues: [],
  ok: true,
  changed,
  hashBefore: before,
  hashAfter: after,
});

console.log(JSON.stringify({
  ok: true,
  changed,
  records: records.length,
  patchesApplied: applied,
  provenanceRecordsBackfilled: provenanceRecords,
  contractIssues: 0,
  hashAfter: after.slice(0, 16),
}, null, 2));
