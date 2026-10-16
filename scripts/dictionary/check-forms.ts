/**
 * Stage-1 acceptance for word-form entries.
 *
 * The plan calls out two cases by name and they are easy to regress:
 *   - `went` must be nothing but an entry point for `go`; it must not expose an
 *     invented noun sense.
 *   - `saw` must remain a standalone word (the cutting tool) *and* point at
 *     `see` as one of its forms.
 *
 * It also asserts the ECDICT hygiene rule: a one-character "form" is noise and
 * must never reach the card.
 *
 * Run with: npm run dictionary:check-forms
 */
import { lookupDictionaryWord } from '../../server/dictionary/service.ts';

interface Expectation {
  query: string;
  lemma: string;
  /** Part-of-speech groups the entry must expose, in order. */
  groups: string[];
  /** The base form the entry must point at, if any. */
  baseForm?: string;
  /** A part of speech that must NOT appear. */
  forbiddenGroup?: string;
}

const EXPECTATIONS: Expectation[] = [
  { query: 'went', lemma: 'went', groups: [], baseForm: 'go', forbiddenGroup: 'n.' },
  { query: 'saw', lemma: 'saw', groups: ['n.', 'v.'], baseForm: 'see' },
  { query: 'go', lemma: 'go', groups: ['v.', 'n.'] },
  { query: 'see', lemma: 'see', groups: ['v.'] },
];

const failures: string[] = [];

for (const expectation of EXPECTATIONS) {
  const entry = await lookupDictionaryWord(expectation.query);
  if (!entry) {
    failures.push(`${expectation.query}: not found`);
    continue;
  }
  const where = `${expectation.query}`;
  if (entry.lemma !== expectation.lemma) failures.push(`${where}: lemma is "${entry.lemma}", expected "${expectation.lemma}"`);

  const groups = entry.partOfSpeechGroups.map((group) => group.partOfSpeech);
  if (JSON.stringify(groups) !== JSON.stringify(expectation.groups)) {
    failures.push(`${where}: groups are ${JSON.stringify(groups)}, expected ${JSON.stringify(expectation.groups)}`);
  }
  if (expectation.forbiddenGroup && groups.includes(expectation.forbiddenGroup)) {
    failures.push(`${where}: exposes an invented "${expectation.forbiddenGroup}" group`);
  }
  if (expectation.baseForm) {
    const pointsAtBase = entry.wordForms.some((form) => form.label === '原形' && form.value === expectation.baseForm);
    if (!pointsAtBase) failures.push(`${where}: does not point at the base form "${expectation.baseForm}"`);
  }

  for (const form of entry.wordForms) {
    if (form.value.trim().length < 2) failures.push(`${where}: word form "${form.label}=${form.value}" is single-character noise`);
  }
  const pairs = entry.wordForms.map((form) => `${form.label}:${form.value.toLowerCase()}`);
  if (new Set(pairs).size !== pairs.length) failures.push(`${where}: duplicate word forms`);

  console.log(`${where} -> lemma=${entry.lemma} groups=${JSON.stringify(groups)} forms=${entry.wordForms.map((form) => `${form.label}=${form.value}`).join(' ')}`);
}

if (failures.length) {
  console.error(JSON.stringify({ ok: false, failures }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ ok: true, checked: EXPECTATIONS.length }, null, 2));
}
