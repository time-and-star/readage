import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateRecordContract } from '../scripts/dictionary/validate-content.mjs';
import { ALLOWED_PART_OF_SPEECH, SOURCE_POS_RE, isPureWordForm } from '../scripts/dictionary/spec.mjs';
import { cleanWordForms } from '../server/dictionary/model';

const root = process.cwd();
type Sense = {
  id: string;
  definitionEn: string;
  definitionZh?: string;
  usageLabels?: string[];
  sortOrder: number;
  examples: Array<{ id?: string; en: string; zh?: string; source?: unknown; reviewStatus?: string }>;
  source?: unknown;
  reviewStatus?: string;
};
type Record_ = {
  lemma: string;
  partOfSpeechGroups: Array<{ partOfSpeech: string; usageLabels: string[]; sortOrder: number; senses: Sense[] }>;
  edit: { authoringMethod?: string; reviewStatus?: string; changeNote?: string };
};

const records = fs.readFileSync(path.join(root, 'data/dictionary/revisions/curated-50.jsonl'), 'utf8')
  .trim().split(/\r?\n/).map((line) => JSON.parse(line) as Record_);
const byLemma = new Map(records.map((record) => [record.lemma, record]));
const sensesOf = (lemma: string) => byLemma.get(lemma)?.partOfSpeechGroups.flatMap((group) => group.senses) ?? [];

describe('sample words meet the frozen record contract', () => {
  it('clears every one of the 50 records', () => {
    const failures = records
      .map((record) => ({ lemma: record.lemma, issues: validateRecordContract(record, record.lemma) }))
      .filter((entry) => entry.issues.length > 0);
    assert.deepEqual(failures, []);
  });

  it('records provenance on every sense and every example', () => {
    for (const record of records) {
      for (const group of record.partOfSpeechGroups) {
        for (const sense of group.senses) {
          assert.ok(Array.isArray(sense.source) && sense.source.length > 0, `${sense.id}: sense source missing`);
          assert.equal(sense.reviewStatus, 'reviewed', `${sense.id}: sense not reviewed`);
          for (const example of sense.examples) {
            assert.ok(example.source, `${sense.id}: example source missing`);
            assert.equal(example.reviewStatus, 'reviewed', `${sense.id}: example not reviewed`);
            assert.ok(example.en?.trim(), `${sense.id}: example has no English`);
            assert.ok(example.zh?.trim(), `${sense.id}: example has no Chinese`);
          }
        }
      }
      assert.equal(record.edit.authoringMethod, 'model-manual', record.lemma);
      assert.equal(record.edit.reviewStatus, 'reviewed', record.lemma);
      assert.ok(record.edit.changeNote?.trim(), `${record.lemma}: changeNote missing`);
    }
  });

  it('keeps sortOrder as a faithful mirror of array position', () => {
    for (const record of records) {
      record.partOfSpeechGroups.forEach((group, groupIndex) => {
        assert.equal(group.sortOrder, groupIndex, `${record.lemma}: group order drifted`);
        group.senses.forEach((sense, senseIndex) => {
          assert.equal(sense.sortOrder, senseIndex, `${sense.id}: sense order drifted`);
        });
      });
    }
  });

  it('lets modals keep their own part of speech instead of forcing them into another', () => {
    assert.ok(ALLOWED_PART_OF_SPEECH.includes('modal.'));
    assert.ok(SOURCE_POS_RE.test('modal.'));
    for (const lemma of ['can', 'would']) {
      const group = byLemma.get(lemma)?.partOfSpeechGroups.find((item) => item.partOfSpeech === 'modal.');
      assert.ok(group, `${lemma} should be grouped as a modal`);
    }
  });
});

describe('stage-1 corrections hold', () => {
  it('pairs each of set / in / take sense with an example that illustrates it', () => {
    const setSenses = sensesOf('set').map((sense) => sense.id);
    assert.deepEqual(setSenses, ['set-v-1', 'set-v-2', 'set-v-3', 'set-n-1', 'set-n-2', 'set-n-3', 'set-adj-1']);
    const film = sensesOf('set').find((sense) => sense.id === 'set-n-2');
    assert.match(film?.definitionEn ?? '', /film or play/);
    assert.match(film?.examples[0]?.en ?? '', /on set/);
    const group = sensesOf('set').find((sense) => sense.id === 'set-n-3');
    assert.match(group?.definitionEn ?? '', /group of people/);

    const inSenses = sensesOf('in');
    const after = inSenses.find((sense) => sense.id === 'in-2');
    assert.match(after?.definitionEn ?? '', /after a period/);
    assert.equal(after?.examples[0]?.en, 'The store closes in ten minutes.');
    const during = inSenses.find((sense) => sense.id === 'in-3');
    assert.match(during?.definitionEn ?? '', /during a period/);
    assert.equal(inSenses.at(-1)?.id, 'in-4', 'the adverbial sense should follow the preposition group');

    const take = sensesOf('take').find((sense) => sense.id === 'take-v-4');
    assert.match(take?.definitionEn ?? '', /remove/);
    assert.equal(take?.examples[0]?.en, 'She took a book from the shelf.');
  });

  it('keeps the word-form entries of go / see clean', () => {
    // A single letter labelled as a form is ECDICT noise, never a real form.
    assert.ok(isPureWordForm({ translation: 'go 的过去式', definition: '' }));
    assert.deepEqual(cleanWordForms([{ label: '原形', value: 'go' }, { label: '第三人称单数', value: 'p' }]), [
      { label: '原形', value: 'go' },
    ]);
    assert.deepEqual(
      cleanWordForms([
        { label: '原形', value: 'see' },
        { label: '第三人称单数', value: 'saws' },
        { label: '第三人称单数', value: 'saws' },
        { label: '复数', value: 'saws' },
      ]),
      [
        { label: '原形', value: 'see' },
        { label: '第三人称单数', value: 'saws' },
        { label: '复数', value: 'saws' },
      ],
    );
    assert.deepEqual(cleanWordForms([{ label: '第三人称单数', value: ' ' }]), []);
  });
});
