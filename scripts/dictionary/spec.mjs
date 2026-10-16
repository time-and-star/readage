/**
 * Frozen authoring spec for the unified learning dictionary.
 *
 * Everything in this file is a *rule*, never content. Scripts may select words,
 * read source rows, sort, hash, validate and package — they must never write a
 * definition, translate a sense, invent an example, merge two meanings or mark
 * anything reviewed. That boundary is the whole point of the batch workflow:
 * content comes from the model, word by word; the tooling only makes it
 * checkable and reproducible.
 *
 * Frozen at stage 0 for batch-001. Changing any constant here is a deliberate
 * spec revision and must be reflected in docs/dictionary-batch-workflow.md.
 */
import { normalizeWord, sha256 } from './pack.mjs';

export { normalizeWord, sha256 };

/** Data-model version carried by every record, pack header and report. */
export const DICTIONARY_SCHEMA_VERSION = 'dictionary.v2';

/** Content version of the *editorial* layer; bumped per locked content release. */
export const DICTIONARY_CONTENT_VERSION = 'dictionary-content.v2';

/** How a record's text came to exist. Only `model-manual` may be published. */
export const AUTHORING_METHODS = ['model-manual', 'pack-import', 'unknown'];
export const AUTHORING_METHOD = 'model-manual';
export const BASE_AUTHORING_METHOD = 'pack-import';

/**
 * Editorial state of a word.
 * `draft`, `unreviewed` and `needs-review` are pre-publication states and can
 * never appear in a published batch.
 */
export const REVIEW_STATUSES = ['draft', 'unreviewed', 'needs-review', 'reviewed'];
export const PUBLISHABLE_REVIEW_STATUS = 'reviewed';

/** Lifecycle of a batch manifest. */
export const BATCH_STATUSES = [
  'draft',
  'authoring',
  'reviewing',
  'needs-human-review',
  'approved',
  'published',
  'rolled-back',
];
export const PUBLISHABLE_BATCH_STATUS = 'approved';

/** A batch is the *release* unit; work packages are only context checkpoints. */
export const DEFAULT_BATCH_SIZE = 2000;
export const WORK_PACKAGE_SIZE = 50;

/** Part-of-speech values the canonical model is allowed to emit. */
export const ALLOWED_PART_OF_SPEECH = [
  'n.',
  'v.',
  'adj.',
  'adv.',
  'prep.',
  'pron.',
  'conj.',
  'int.',
  'interj.',
  'modal.',
  'det.',
  'num.',
  'art.',
  'aux.',
  'phrase',
];

/**
 * Source part-of-speech tokens as they appear in ECDICT, including the short
 * forms `a` / `s` / `r` that the canonical model rewrites to adj. / adv.
 * `modal` is included because modals (can, would, must) are a real category:
 * the canonical model passes unknown tokens through as `<token>.` and rejecting
 * them would force modals into a category that misdescribes them.
 */
export const SOURCE_POS_RE = /^(?:n|v|vi|vt|a|s|r|adj|adv|prep|pron|conj|int|interj|modal|num|art|det|aux)\.?$/i;

/** A publishable headword is a plain lowercase alpha lemma of at least two letters. */
const WORD_SHAPE_RE = /^[a-z]+$/;

/** Markers that mean the row only describes an inflected form of another word. */
const PURE_WORD_FORM_RE = /(?:的)?(?:过去式|过去分词|现在分词|第三人称单数|最高级|比较级|复数)$/;

/** A definition longer than this is treated as several senses run together. */
export const CONCATENATED_DEFINITION_LENGTH = 240;

export function isValidLemma(value) {
  const word = normalizeWord(value);
  return WORD_SHAPE_RE.test(word) && word.length >= 2;
}

/**
 * True when a source row carries nothing but an inflected-form gloss
 * (e.g. "go 的过去式"). Those rows are entry points, not headwords.
 */
export function isPureWordForm(row) {
  const text = `${row?.translation ?? ''} ${row?.definition ?? ''}`.replace(/\s+/g, '');
  return PURE_WORD_FORM_RE.test(text) && text.length < 40;
}

/**
 * ECDICT `frq` is a frequency *rank*: smaller means more frequent. Rows without
 * a usable positive rank sort to the end so they can never displace real hits.
 * This direction is frozen — see the spec doc.
 */
export function parseFrequency(value) {
  const number = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(number) && number > 0 ? number : Number.POSITIVE_INFINITY;
}

/**
 * Collapse the source to one canonical row per eligible lemma. When a lemma
 * appears several times, the lowest rank wins; a real headword row beats a
 * pure-word-form row at the same rank. Duplicate-key handling is deterministic.
 */
export function rankSourceRows(rows) {
  const byWord = new Map();
  for (const row of rows) {
    const word = normalizeWord(row?.word);
    if (!isValidLemma(word)) continue;
    const candidate = {
      word,
      frequency: parseFrequency(row?.frq),
      pos: String(row?.pos ?? '').trim(),
      translation: String(row?.translation ?? ''),
      definition: String(row?.definition ?? ''),
      pureWordForm: isPureWordForm(row),
    };
    const current = byWord.get(word);
    if (
      !current
      || candidate.frequency < current.frequency
      || (candidate.frequency === current.frequency && !candidate.pureWordForm && current.pureWordForm)
    ) {
      byWord.set(word, candidate);
    }
  }
  return byWord;
}

/**
 * The frozen batch selection rule:
 *   1. one canonical row per eligible lemma (see rankSourceRows);
 *   2. drop words already covered by a sample list or a published revision;
 *   3. drop pure word-form rows;
 *   4. sort by numeric frq ascending, ties alphabetically;
 *   5. take the first `size` and freeze the order.
 * The returned rank is part of the frozen list and must not be re-sorted later.
 */
export function selectBatchWords(rows, { size = DEFAULT_BATCH_SIZE, excludedWords = new Set() } = {}) {
  const byWord = rankSourceRows(rows);
  return [...byWord.values()]
    .filter((row) => !excludedWords.has(row.word) && !row.pureWordForm)
    .sort((left, right) => left.frequency - right.frequency || left.word.localeCompare(right.word))
    .slice(0, size)
    .map((row, index) => ({
      rank: index + 1,
      lemma: row.word,
      frequency: Number.isFinite(row.frequency) ? row.frequency : null,
      sourcePartOfSpeech: row.pos,
      pureWordForm: false,
    }));
}

/** Human-readable, machine-stable description of the frozen selection rule. */
export const SELECTION_RULE =
  'one canonical source row per eligible lemma; exclude sample words and published revisions; '
  + 'exclude pure word-form rows; ascending numeric frq then alphabetical; freeze the first N';

/**
 * Hash a word list by its lemmas, one per line, in locked order. Two runs over
 * the same source must produce the same digest; a changed digest means the
 * frozen list moved.
 */
export function hashWordList(words) {
  return sha256(words.map((word) => normalizeWord(word)).join('\n'));
}

/** Split a frozen list into the 50-word work packages used only for authoring. */
export function workPackagesFor(words, size = WORK_PACKAGE_SIZE) {
  const packages = [];
  for (let start = 0; start < words.length; start += size) {
    const slice = words.slice(start, start + size);
    packages.push({
      id: `work-${String(packages.length + 1).padStart(3, '0')}`,
      from: start + 1,
      to: start + slice.length,
      size: slice.length,
    });
  }
  return packages;
}
