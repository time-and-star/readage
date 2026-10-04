import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { REVIEW_STATUSES } from '../scripts/dictionary/spec.mjs';

const root = process.cwd();
const batchesDir = path.join(root, 'data', 'dictionary', 'revisions', 'batches');

type Sense = { id: string; definitionEn: string; examples: Array<{ id?: string; en?: string; zh?: string }>; source?: unknown; reviewStatus?: string };
type Record_ = {
  schemaVersion: string;
  query: string;
  lemma: string;
  partOfSpeechGroups: Array<{ id: string; partOfSpeech: string; senses: Sense[] }>;
  edit: { revisionVersion?: string; authoringMethod?: string; reviewStatus?: string; changeNote?: string };
};

const readJsonl = (filePath: string): Record_[] => fs.readFileSync(filePath, 'utf8')
  .trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record_);

const batchIds = fs.existsSync(batchesDir)
  ? fs.readdirSync(batchesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(batchesDir, entry.name, 'manifest.json')))
      .map((entry) => entry.name)
  : [];

assert.ok(batchIds.length > 0, 'expected at least one batch under data/dictionary/revisions/batches');

for (const batchId of batchIds) {
  const batchDir = path.join(batchesDir, batchId);
  const manifest = JSON.parse(fs.readFileSync(path.join(batchDir, 'manifest.json'), 'utf8')) as { status: string; batchSize: number };
  const frozen = (JSON.parse(fs.readFileSync(path.join(batchDir, 'words.json'), 'utf8')) as { words: Array<{ lemma: string }> }).words.map((item) => item.lemma);
  const revisionsPath = path.join(batchDir, 'revisions.jsonl');
  const revisions = fs.existsSync(revisionsPath) ? readJsonl(revisionsPath) : [];

  describe(`${batchId} authored revisions`, () => {
    it('follows the frozen word list order exactly', () => {
      const authored = revisions.map((record) => record.lemma);
      assert.deepEqual(authored, frozen.slice(0, authored.length));
    });

    it('never repeats a word', () => {
      const authored = revisions.map((record) => record.lemma);
      assert.equal(new Set(authored).size, authored.length);
    });

    it('labels every record as hand-written content of this batch', () => {
      for (const record of revisions) {
        assert.equal(record.schemaVersion, 'dictionary.v2', record.lemma);
        assert.equal(record.lemma, record.query, record.lemma);
        assert.equal(record.edit.authoringMethod, 'model-manual', record.lemma);
        assert.equal(record.edit.revisionVersion, `${batchId}.v1`, record.lemma);
        assert.ok(record.edit.changeNote?.trim(), `${record.lemma}: changeNote must explain the edit`);
        assert.ok(REVIEW_STATUSES.includes(String(record.edit.reviewStatus)), `${record.lemma}: bad reviewStatus`);
      }
    });

    it('gives every sense a unique id, a source and a bilingual example of its own', () => {
      for (const record of revisions) {
        const groupIds = record.partOfSpeechGroups.map((group) => group.id);
        assert.equal(new Set(groupIds).size, groupIds.length, `${record.lemma}: duplicate group id`);
        const senseIds: string[] = [];
        for (const group of record.partOfSpeechGroups) {
          assert.ok(group.senses.length > 0, `${record.lemma}/${group.id}: group has no sense`);
          for (const sense of group.senses) {
            assert.ok(sense.definitionEn?.trim(), `${sense.id}: empty definition`);
            assert.ok(Array.isArray(sense.source) && sense.source.length > 0, `${sense.id}: source missing`);
            senseIds.push(sense.id);
            const bilingual = sense.examples.filter((example) => example.en?.trim() && example.zh?.trim());
            assert.ok(bilingual.length > 0, `${sense.id}: no bilingual example`);
            for (const example of bilingual) {
              assert.equal(example.id, sense.id, `${sense.id}: example id must match its sense`);
            }
          }
        }
        assert.equal(new Set(senseIds).size, senseIds.length, `${record.lemma}: duplicate sense id`);
      }
    });

    it('only marks a word reviewed when the review log shows both rounds approved', () => {
      // The original intent — "nothing is reviewed without the stage-4 gate" —
      // is now expressed against the review log itself, which is stronger than
      // the old "no record may be reviewed yet" snapshot.
      const logPath = path.join(batchDir, 'review-log.jsonl');
      const log = fs.existsSync(logPath)
        ? fs.readFileSync(logPath, 'utf8').trim().split(/\r?\n/).filter(Boolean)
            .map((line) => JSON.parse(line) as { lemma: string; round: number; result: string })
        : [];
      const rounds = new Map<string, Record<number, string>>();
      for (const entry of log) {
        const forLemma = rounds.get(entry.lemma) ?? {};
        forLemma[entry.round] = entry.result;
        rounds.set(entry.lemma, forLemma);
      }
      for (const record of revisions) {
        if (record.edit.reviewStatus !== 'reviewed') continue;
        const forLemma = rounds.get(record.lemma);
        assert.ok(forLemma, `${record.lemma}: marked reviewed with no review record at all`);
        assert.equal(forLemma[1], 'approved', `${record.lemma}: marked reviewed but round 1 was not approved`);
        assert.equal(forLemma[2], 'approved', `${record.lemma}: marked reviewed but round 2 was not approved`);
      }
    });

    it('keeps every authored word inside the frozen list', () => {
      const allowed = new Set(frozen);
      const stray = revisions.map((record) => record.lemma).filter((lemma) => !allowed.has(lemma));
      assert.deepEqual(stray, []);
    });
  });
}
