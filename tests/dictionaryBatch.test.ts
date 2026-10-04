import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DICTIONARY_CONTENT_VERSION,
  DEFAULT_BATCH_SIZE,
  WORK_PACKAGE_SIZE,
  hashWordList,
  isPureWordForm,
  isValidLemma,
  selectBatchWords,
  workPackagesFor,
} from '../scripts/dictionary/spec.mjs';
import { validateBatch } from '../scripts/dictionary/validate-content.mjs';

const root = process.cwd();
const read = (...segments: string[]) => fs.readFileSync(path.join(root, ...segments), 'utf8');
const readJson = (...segments: string[]) => JSON.parse(read(...segments));

const batchDir = ['data', 'dictionary', 'revisions', 'batches', 'batch-001'];
const batchManifest = readJson(...batchDir, 'manifest.json') as {
  batchId: string;
  batchSize: number;
  schemaVersion: string;
  contentVersion: string;
  status: string;
  authoringMethod: string;
  sourceHash: string;
  wordListHash: string;
  revisionCount: number;
  publishedAt: string | null;
  workPackages: Array<{ id: string; from: number; to: number; size: number }>;
};
const batchWords = readJson(...batchDir, 'words.json') as {
  size: number;
  wordListHash: string;
  words: Array<{ rank: number; lemma: string; frequency: number | null; pureWordForm: boolean }>;
};
const sourceManifest = readJson(...batchDir, 'source-manifest.json') as {
  source: { sha256: string; rows: number };
  wordListHash: string;
};
const lemmas = batchWords.words.map((item) => item.lemma);
const sampleWords = (readJson('data', 'dictionary', 'sample-words.json') as { words: Array<{ word: string }> })
  .words.map((item) => item.word);
const curatedLemmas = read('data', 'dictionary', 'revisions', 'curated-50.jsonl')
  .trim().split(/\r?\n/).map((line) => (JSON.parse(line) as { lemma: string }).lemma);

describe('frozen selection rule', () => {
  const rows = [
    { word: 'zed', frq: '30', pos: 'n.', translation: 'n. 泽德', definition: 'a test word' },
    { word: 'apple', frq: '10', pos: 'n.', translation: 'n. 苹果', definition: 'a fruit' },
    { word: 'Apple', frq: '10', pos: 'n.', translation: 'n. 苹果', definition: 'a fruit' },
    { word: 'went', frq: '5', pos: '', translation: 'go 的过去式', definition: '' },
    { word: 'bee', frq: '20', pos: 'n.', translation: 'n. 蜜蜂', definition: 'an insect' },
    { word: 'cat', frq: '20', pos: 'n.', translation: 'n. 猫', definition: 'a pet' },
    { word: 'x', frq: '1', pos: '', translation: '', definition: '' },
  ];

  it('accepts only plain lowercase lemmas of two or more letters', () => {
    assert.ok(isValidLemma('run'));
    assert.ok(isValidLemma('RUN'));
    assert.ok(!isValidLemma('x'));
    assert.ok(!isValidLemma('well-known'));
    assert.ok(!isValidLemma("don't"));
    assert.ok(!isValidLemma('词'));
  });

  it('treats an inflected-form gloss as an entry point, not a headword', () => {
    assert.ok(isPureWordForm({ translation: 'go 的过去式', definition: '' }));
    assert.ok(isPureWordForm({ translation: '', definition: 'n. 复数' }));
    assert.ok(!isPureWordForm({ translation: 'v. 跑；经营', definition: 'to move quickly' }));
  });

  it('drops pure word forms and excluded words, then orders by frq then alphabetically', () => {
    const selected = selectBatchWords(rows, { size: 10, excludedWords: new Set(['bee']) });
    assert.deepEqual(selected.map((item) => item.lemma), ['apple', 'cat', 'zed']);
    assert.deepEqual(selected.map((item) => item.rank), [1, 2, 3]);
    assert.deepEqual(selected.map((item) => item.frequency), [10, 20, 30]);
  });

  it('freezes the order: two runs over the same rows agree exactly', () => {
    const first = selectBatchWords(rows, { size: 10 });
    const second = selectBatchWords(rows, { size: 10 });
    assert.deepEqual(first, second);
    assert.equal(hashWordList(first.map((item) => item.lemma)), hashWordList(second.map((item) => item.lemma)));
  });

  it('changes the digest when the frozen order changes', () => {
    assert.notEqual(hashWordList(['apple', 'cat']), hashWordList(['cat', 'apple']));
  });

  it('splits a batch into 50-word work packages that cover the list exactly', () => {
    const words = Array.from({ length: 2000 }, (_, index) => `w${index}`);
    const packages = workPackagesFor(words);
    assert.equal(packages.length, DEFAULT_BATCH_SIZE / WORK_PACKAGE_SIZE);
    assert.equal(packages[0].from, 1);
    assert.equal(packages[0].to, 50);
    assert.equal(packages.at(-1)?.to, 2000);
    assert.equal(packages.reduce((total, item) => total + item.size, 0), 2000);
  });
});

describe('batch-001 frame is frozen while content is authored', () => {
  it('records the batch as hand-written content that is not published yet', () => {
    assert.equal(batchManifest.batchId, 'batch-001');
    assert.equal(batchManifest.batchSize, DEFAULT_BATCH_SIZE);
    assert.equal(batchManifest.schemaVersion, 'dictionary.v2');
    assert.equal(batchManifest.contentVersion, 'dictionary-content.v2');
    assert.ok(['draft', 'authoring', 'reviewing'].includes(batchManifest.status), batchManifest.status);
    assert.equal(batchManifest.authoringMethod, 'model-manual');
    assert.equal(batchManifest.publishedAt, null);
    assert.equal(batchManifest.workPackages.length, 40);
    const authored = read(...batchDir, 'revisions.jsonl').trim().split(/\r?\n/).filter(Boolean);
    assert.equal(batchManifest.revisionCount, authored.length, 'revisionCount must track the authored file');
  });

  it('holds exactly 2000 unique lemmas whose stored hash matches the manifest', () => {
    assert.equal(batchWords.size, DEFAULT_BATCH_SIZE);
    assert.equal(lemmas.length, DEFAULT_BATCH_SIZE);
    assert.equal(new Set(lemmas).size, DEFAULT_BATCH_SIZE);
    assert.equal(hashWordList(lemmas), batchManifest.wordListHash);
    assert.equal(batchWords.wordListHash, batchManifest.wordListHash);
    assert.equal(sourceManifest.wordListHash, batchManifest.wordListHash);
  });

  it('is sorted by ascending frequency with stable alphabetical ties and locked ranks', () => {
    batchWords.words.forEach((item, index) => {
      assert.equal(item.rank, index + 1);
      assert.ok(isValidLemma(item.lemma), item.lemma);
      assert.equal(item.pureWordForm, false, item.lemma);
      const previous = batchWords.words[index - 1];
      if (previous) {
        const left = previous.frequency ?? Number.POSITIVE_INFINITY;
        const right = item.frequency ?? Number.POSITIVE_INFINITY;
        assert.ok(left <= right, `${previous.lemma} > ${item.lemma}`);
        if (left === right) assert.ok(previous.lemma <= item.lemma, `${previous.lemma} / ${item.lemma}`);
      }
    });
  });

  it('keeps the sample words and already-revised words out of the batch', () => {
    const sample = new Set(sampleWords);
    const curated = new Set(curatedLemmas);
    assert.deepEqual(lemmas.filter((word) => sample.has(word)), []);
    assert.deepEqual(lemmas.filter((word) => curated.has(word)), []);
  });

  it('keeps the tooling out of content: revisions carry manual provenance and the review log holds only review records', () => {
    // The batch tool never writes dictionary content. Anything sitting in
    // revisions.jsonl must carry the manual provenance marker, and the review
    // log may only contain well-formed review entries — never tooling output.
    const authored = read(...batchDir, 'revisions.jsonl').trim().split(/\r?\n/).filter(Boolean)
      .map((line) => JSON.parse(line) as { edit?: { authoringMethod?: string } });
    assert.ok(authored.length > 0, 'expected the authored file to carry content');
    for (const record of authored) assert.equal(record.edit?.authoringMethod, 'model-manual');

    const logText = read(...batchDir, 'review-log.jsonl');
    if (logText.length > 0) {
      const entries = logText.trim().split(/\r?\n/).filter(Boolean)
        .map((line) => JSON.parse(line) as { round?: number; result?: string; reviewer?: string });
      for (const entry of entries) {
        assert.ok([1, 2].includes(Number(entry.round)), `bad round: ${entry.round}`);
        assert.ok(['approved', 'needs-revision', 'needs-human-review'].includes(String(entry.result)), `bad result: ${entry.result}`);
        assert.ok(entry.reviewer, 'review entry must name its reviewer');
      }
    }
  });

  it('snapshots the input source it was derived from', () => {
    assert.equal(sourceManifest.source.sha256, batchManifest.sourceHash);
    assert.ok(sourceManifest.source.rows > 700000);
  });

  it('is registered in the revision index', () => {
    const index = readJson('data', 'dictionary', 'revisions', 'manifest.json') as {
      contentVersion: string;
      batches: Array<{ batchId: string; wordListHash: string }>;
    };
    assert.equal(index.contentVersion, 'dictionary-content.v2');
    assert.equal(index.batches.filter((item) => item.batchId === 'batch-001').length, 1);
    assert.equal(index.batches.find((item) => item.batchId === 'batch-001')?.wordListHash, batchManifest.wordListHash);
  });
});

describe('stage-0 provenance freeze', () => {
  it('marks every curated sample revision as hand-written', () => {
    const revisions = read('data', 'dictionary', 'revisions', 'curated-50.jsonl')
      .trim().split(/\r?\n/).map((line) => JSON.parse(line) as {
        lemma: string;
        edit: { authoringMethod?: string; reviewStatus?: string };
      });
    assert.equal(revisions.length, 50);
    for (const revision of revisions) {
      assert.equal(revision.edit.authoringMethod, 'model-manual', revision.lemma);
      assert.equal(revision.edit.reviewStatus, 'reviewed', revision.lemma);
    }
  });

  it('ships an empty revision template carrying the frozen provenance', () => {
    const template = readJson('data', 'dictionary', 'revisions', 'revision-template.json') as {
      partOfSpeechGroups: unknown[];
      phrases: unknown[];
      supplementaryChinese: unknown[];
      edit: { authoringMethod?: string; reviewStatus?: string; revisionVersion?: string };
    };
    assert.deepEqual(template.partOfSpeechGroups, []);
    assert.deepEqual(template.phrases, []);
    assert.deepEqual(template.supplementaryChinese, []);
    assert.equal(template.edit.authoringMethod, 'model-manual');
    assert.equal(template.edit.reviewStatus, 'draft');
  });
});

// ---------------------------------------------------------------------------
// The validator is only worth having if it actually fails. These fixtures are
// deliberately broken and live in a throwaway temp directory.
// ---------------------------------------------------------------------------
type FixtureRecord = Record<string, unknown>;

function writeBatchFixture(batchId: string, status: string, lemmas: string[], revisions: FixtureRecord[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dict-batch-fixture-'));
  const batchesDir = path.join(dir, 'batches');
  const batchDir = path.join(batchesDir, batchId);
  fs.mkdirSync(batchDir, { recursive: true });
  const wordListHash = hashWordList(lemmas);
  fs.writeFileSync(path.join(batchDir, 'words.json'), JSON.stringify({
    format: 'dictionary-batch-words.v1',
    batchId,
    schemaVersion: 'dictionary.v2',
    size: lemmas.length,
    selectionRule: 'fixture',
    wordListHash,
    words: lemmas.map((lemma, index) => ({ rank: index + 1, lemma, frequency: index + 1, sourcePartOfSpeech: '', pureWordForm: false })),
  }));
  fs.writeFileSync(path.join(batchDir, 'manifest.json'), JSON.stringify({
    format: 'dictionary-batch.v1',
    batchId,
    batchSize: lemmas.length,
    schemaVersion: 'dictionary.v2',
    contentVersion: DICTIONARY_CONTENT_VERSION,
    status,
    authoringMethod: 'model-manual',
    sourceHash: 'fixture',
    wordListHash,
    revisionCount: revisions.length,
    publishedAt: status === 'published' ? '2026-01-01T00:00:00.000Z' : null,
  }));
  fs.writeFileSync(
    path.join(batchDir, 'revisions.jsonl'),
    revisions.length ? `${revisions.map((item) => JSON.stringify(item)).join('\n')}\n` : '',
  );
  const revisionManifestPath = path.join(dir, 'manifest.json');
  fs.writeFileSync(revisionManifestPath, JSON.stringify({
    format: 'dictionary-revisions.v1',
    schemaVersion: 'dictionary.v2',
    contentVersion: DICTIONARY_CONTENT_VERSION,
    batches: [{ batchId, status, size: lemmas.length, wordListHash, revisionCount: revisions.length, publishedAt: null }],
  }));
  return { batchesDir, revisionManifestPath };
}

function record(lemma: string, overrides: Partial<FixtureRecord> = {}): FixtureRecord {
  return {
    schemaVersion: 'dictionary.v2',
    query: lemma,
    lemma,
    partOfSpeechGroups: [{
      id: `${lemma}:n.`,
      partOfSpeech: 'n.',
      usageLabels: ['n.'],
      sortOrder: 0,
      senses: [{
        id: `${lemma}-n-1`,
        definitionEn: `the meaning of ${lemma}`,
        definitionZh: `${lemma} 的含义`,
        usageLabels: ['n.'],
        sortOrder: 0,
        examples: [{ id: `${lemma}-n-1`, en: `This is ${lemma}.`, zh: `这是 ${lemma}。`, reviewStatus: 'reviewed' }],
        collocations: [],
        grammarNotes: [],
        source: [{ kind: 'manual', label: 'curated-revision', status: 'confirmed' }],
        reviewStatus: 'reviewed',
      }],
    }],
    phrases: [],
    supplementaryChinese: [],
    edit: {
      source: [{ kind: 'manual', label: 'curated-revision', status: 'confirmed' }],
      revisionVersion: 'fixture.v1',
      authoringMethod: 'model-manual',
      reviewStatus: 'reviewed',
      changeNote: 'fixture',
    },
    ...overrides,
  };
}

describe('batch validator', () => {
  it('passes a complete, hand-written, approved batch', () => {
    const { batchesDir, revisionManifestPath } = writeBatchFixture(
      'batch-778',
      'approved',
      ['alpha', 'beta'],
      [record('alpha'), record('beta')],
    );
    const result = validateBatch({ batchId: 'batch-778', batchesDir, revisionManifestPath });
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    assert.equal(result.publishReady, true);
    assert.deepEqual(result.invalidRecords, []);
    assert.equal(result.totals.missing, 0);
    assert.equal(result.checks.noDraftWhenPublished, true);
  });

  it('rejects broken senses instead of waving them through', () => {
    const brokenBeta = record('beta', {
      partOfSpeechGroups: [{
        id: 'beta:zz.',
        partOfSpeech: 'zz.',
        usageLabels: ['weird'],
        sortOrder: 0,
        senses: [
          { id: 'beta-1', definitionEn: '', usageLabels: [], sortOrder: 0, examples: [], collocations: [], grammarNotes: [], source: [], reviewStatus: 'draft' },
          {
            id: 'beta-2',
            definitionEn: 'the same thing',
            usageLabels: ['n.'],
            sortOrder: 1,
            examples: [{ id: 'beta-2', en: '', zh: '', reviewStatus: 'draft' }],
            collocations: [{ en: '', zh: '' }],
            grammarNotes: [],
            source: [],
            reviewStatus: 'draft',
          },
          {
            id: 'beta-3',
            definitionEn: 'the same thing',
            usageLabels: ['n.'],
            sortOrder: 2,
            examples: [{ id: 'beta-3', en: 'This is beta.', zh: '', reviewStatus: 'unreviewed' }],
            collocations: [],
            grammarNotes: [],
            source: [{ kind: 'manual', status: 'confirmed' }],
            reviewStatus: 'draft',
          },
        ],
      }],
      edit: { source: [{ kind: 'manual', status: 'confirmed' }], revisionVersion: 'fixture.v1', reviewStatus: 'draft' },
    });
    const { batchesDir, revisionManifestPath } = writeBatchFixture(
      'batch-777',
      'published',
      ['alpha', 'beta', 'gamma'],
      [record('alpha'), brokenBeta],
    );
    const result = validateBatch({ batchId: 'batch-777', batchesDir, revisionManifestPath });
    const issuesFor = (lemma: string) => result.invalidRecords.find((item) => item.lemma === lemma)?.issues.join(' | ') ?? '';

    assert.equal(result.ok, false);
    assert.equal(result.publishReady, false);
    assert.deepEqual(result.invalidRecords.map((item) => item.lemma), ['beta'], 'the clean record must not be flagged');
    assert.match(issuesFor('beta'), /invalid part of speech/);
    assert.match(issuesFor('beta'), /invalid usage label/);
    assert.match(issuesFor('beta'), /empty English definition/);
    assert.match(issuesFor('beta'), /duplicate sense/);
    assert.match(issuesFor('beta'), /no bilingual example/);
    assert.match(issuesFor('beta'), /has no Chinese text/);
    assert.match(issuesFor('beta'), /collocation has no English text/);
    assert.match(issuesFor('beta'), /example is draft|example is unreviewed/);
    assert.match(issuesFor('beta'), /no Chinese counterpart/);
    assert.match(issuesFor('beta'), /sense source is missing/);
    assert.match(issuesFor('beta'), /changeNote is missing/);
    assert.match(issuesFor('beta'), /authoringMethod is missing/);

    assert.deepEqual(result.missingRevisions, ['gamma']);
    assert.equal(result.checks.noDuplicateLemmas, true);
    assert.equal(result.checks.noDraftWhenPublished, false);
    assert.ok(result.problems.some((item) => /published batch is missing a revision for "gamma"/.test(item)));
    assert.ok(result.problems.some((item) => /published batch carries "beta" with reviewStatus draft/.test(item)));
  });

  it('refuses a batch whose frozen word list moved', () => {
    const { batchesDir, revisionManifestPath } = writeBatchFixture('batch-776', 'draft', ['alpha'], [record('alpha')]);
    const wordsPath = path.join(batchesDir, 'batch-776', 'words.json');
    const words = JSON.parse(fs.readFileSync(wordsPath, 'utf8'));
    words.words.push({ rank: 2, lemma: 'zeta', frequency: 9, sourcePartOfSpeech: '', pureWordForm: false });
    fs.writeFileSync(wordsPath, JSON.stringify(words));
    const result = validateBatch({ batchId: 'batch-776', batchesDir, revisionManifestPath });
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((item) => /word list moved/.test(item)));
    assert.equal(result.checks.wordListHashMatches, false);
  });
});
