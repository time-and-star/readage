import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mergeLocalDataBackups } from '../src/lib/backupMerge';
import { validateLocalDataBackup, type LocalDataBackup } from '../src/lib/localDataBackup';
import { MEMORY_TABLES } from '../src/lib/localDatabaseProtocol';
import { initializeWordMemory, submitFsrsReview } from '../src/lib/memoryV2/fsrsIntegration';
import { LocalLearningDatabase } from '../server/localDatabase/store';
import { createFullBackup, prepareFullBackup } from '../server/localDatabase/bundle';
import { readingContentVersion } from '../src/lib/readingProgress';
import { replayVerificationEvidence } from '../src/lib/memoryV2/verificationMemory';

const p = 'english-ai:v2:';
function backup(settings: Record<string, unknown> = {}): LocalDataBackup {
  return { format: 'english-ai-local-backup', version: 1, exportedAt: '2026-10-17T00:00:00Z', memoryStorage: 'indexedDB',
    localStorage: Object.fromEntries(Object.entries(settings).map(([k, v]) => [p + k, JSON.stringify(v)])),
    indexedDb: { name: 'english-ai-memory-v2', version: 1, stores: Object.fromEntries(MEMORY_TABLES.map(table => [table, []])) } };
}
const article = (id: string, extra = {}) => ({ id, title: id, content: ['First paragraph.', 'Second paragraph.'], status: 'In Progress', ...extra });
const read = (b: LocalDataBackup, name: string) => JSON.parse(b.localStorage[p + name]);
const stateRows = (b: LocalDataBackup) => b.indexedDb!.stores.memoryState as any[];
function state(word = 'read') { const row = initializeWordMemory('default-user', word); row.nextReview = row.fsrsCard.due = '2026-10-01T00:00:00.000Z'; return row; }
function putState(b: LocalDataBackup, row: any) { stateRows(b).push({ key: `${row.userId}|${row.wordId}`, state: row }); }

test('both unique articles survive, completed status and exact media/captions/PDF page survive, inputs untouched', async () => {
  const a = backup({ articles: [article('a'), article('same')] });
  const media = [{ src: '/api/import/images/' + '1'.repeat(64) + '.png', caption: 'caption', afterParagraphIndex: 0 }];
  const b = backup({ articles: [article('b'), article('same', { status: 'Completed', completedAt: '2026-10-16T00:00:00Z', media,
    sourceDocument: { src: '/api/import/documents/' + '2'.repeat(64) + '.pdf', pageNumber: 2, pageCount: 5 }, paragraphTranslations: ['一', '二'] })] });
  const saved = structuredClone([a, b]);
  const merged = await mergeLocalDataBackups(a, b), rows = read(merged, 'articles');
  assert.deepEqual(rows.map((row: any) => row.id), ['a', 'same', 'b']);
  assert.equal(rows[1].status, 'Completed'); assert.deepEqual(rows[1].media, media);
  assert.equal(rows[1].sourceDocument.pageNumber, 2); assert.deepEqual(rows[1].paragraphTranslations, ['一', '二']);
  assert.deepEqual([a, b], saved);
});

test('same article identity with changed text is rejected before any persistence', async () => {
  const a = backup({ articles: [article('a')] }), b = backup({ articles: [article('a', { content: ['different'] })] });
  await assert.rejects(mergeLocalDataBackups(a, b), /正文或原文件不同/);
  assert.equal(read(a, 'articles')[0].content.length, 2);
});

test('paragraph union and newer bookmark preserve learning on both devices without jumping to furthest scroll', async () => {
  const row = { articleId: 'a', contentVersion: 'reading-v1:test', updatedAt: '2026-10-15T00:00:00Z' };
  const a = backup({ readingParagraphProgress: { a: { ...row, completedParagraphs: [0] } }, readingBookmarks: { a: { ...row, paragraphIndex: 5 } } });
  const b = backup({ readingParagraphProgress: { a: { ...row, completedParagraphs: [0, 1] } }, readingBookmarks: { a: { ...row, updatedAt: '2026-10-16T00:00:00Z', paragraphIndex: 1 } } });
  const merged = await mergeLocalDataBackups(a, b);
  assert.deepEqual(read(merged, 'readingParagraphProgress').a.completedParagraphs, [0, 1]);
  assert.equal(read(merged, 'readingBookmarks').a.paragraphIndex, 1);
  b.localStorage[p + 'readingParagraphProgress'] = JSON.stringify({ a: { ...row, contentVersion: 'reading-v1:changed', completedParagraphs: [1] } });
  await assert.rejects(mergeLocalDataBackups(a, b), /段落版本不同/);
});

test('events, days, discussion messages deduplicate; device preferences and tokens stay local', async () => {
  const a = backup({ events: [{ id: 'shared' }, { id: 'computer' }], learningDays: ['2026-10-15'],
    sessions: { a: { chatMessages: [{ id: 'shared', text: 'x' }], clickCount: 3 } }, readingPreference: { fontSize: 18 }, token: 'computer' });
  const b = backup({ events: [{ id: 'shared' }, { id: 'phone' }], learningDays: ['2026-10-15', '2026-10-16'],
    sessions: { a: { chatMessages: [{ id: 'shared', text: 'x' }, { id: 'new', text: 'y' }], clickCount: 4 } }, readingPreference: { fontSize: 24 }, token: 'phone' });
  const merged = await mergeLocalDataBackups(a, b);
  assert.equal(read(merged, 'events').length, 3); assert.equal(read(merged, 'learningDays').length, 2);
  assert.equal(read(merged, 'sessions').a.chatMessages.length, 2); assert.equal(read(merged, 'sessions').a.clickCount, 4);
  assert.deepEqual(read(merged, 'readingPreference'), { fontSize: 18 }); assert.equal(read(merged, 'token'), 'computer');
});

test('independent recall histories replay in date order and do not pick maximum proficiency', async () => {
  const base = state();
  const left = submitFsrsReview(base, 3, new Date('2026-10-15T10:00:00Z'));
  left.fsrsReviews[0].source = 'flashcard'; left.fsrsReviews[0].verificationAttemptIds = ['computer'];
  const right = submitFsrsReview(base, 1, new Date('2026-10-16T10:00:00Z'));
  right.fsrsReviews[0].source = 'flashcard'; right.fsrsReviews[0].verificationAttemptIds = ['phone'];
  const a = backup(), b = backup(); putState(a, left); putState(b, right);
  const merged = await mergeLocalDataBackups(a, b), row = stateRows(merged)[0].state;
  assert.equal(row.fsrsReviews.length, 2); assert.deepEqual(row.fsrsReviews.map((r: any) => r.rating), [3, 1]);
  assert.equal(row.fsrsCard.reps, 2); assert.equal(row.nextReview, submitFsrsReview(left, 1, new Date('2026-10-16T10:00:00Z')).nextReview);
  const twice = await mergeLocalDataBackups(merged, b);
  assert.equal(stateRows(twice)[0].state.fsrsCard.reps, 2);
  assert.equal(stateRows(twice)[0].state.fsrsReviews.length, 2);
});

test('unchanged backup merge is idempotent, unique words retained', async () => {
  const a = backup({ articles: [article('a')] }), b = backup({ articles: [article('a'), article('b')] });
  putState(a, state()); putState(b, state('book'));
  const merged = await mergeLocalDataBackups(a, b);
  assert.deepEqual(await mergeLocalDataBackups(merged, b), merged);
  assert.equal(stateRows(merged).length, 2);
});

test('same encounter deduplicates while independent raw events recover article and daily totals', async () => {
  const event = { userId: 'default-user', wordId: 'read', articleId: 'a', occurrenceId: '0', eventType: 'click',
    occurredAt: '2026-10-15T10:00:00Z', localDate: '2026-10-15' };
  const a = backup(), b = backup();
  a.indexedDb!.stores.rawEvents = [{ key: 'default-user|read|2026-10-15', events: [event] }];
  b.indexedDb!.stores.rawEvents = [{ key: 'default-user|read|2026-10-15', events: [event, { ...event, occurrenceId: '1' }] }];
  const merged = await mergeLocalDataBackups(a, b);
  assert.equal((merged.indexedDb!.stores.rawEvents[0] as any).events.length, 2);
  assert.equal((merged.indexedDb!.stores.dailyEvidence[0] as any).evidence.clickedOccurrenceCount, 2);
  assert.deepEqual(await mergeLocalDataBackups(merged, b), merged);
});

test('legacy localStorage memory is converted and merged with SQLite-shaped memory', async () => {
  const a = backup(), b = backup(); putState(a, state()); b.memoryStorage = 'localStorage'; b.indexedDb = null;
  b.localStorage[p + 'memory:state:default-user:book'] = JSON.stringify(state('book'));
  const merged = await mergeLocalDataBackups(a, b);
  assert.equal(stateRows(merged).length, 2);
  assert.ok(!Object.keys(merged.localStorage).some(key => key.startsWith(p + 'memory:')));
  validateLocalDataBackup(merged);
});

test('verification attempts and word enrollment merge while pause/resume follows dated preference', async () => {
  const a = backup(), b = backup();
  const pref = { userId: 'default-user', version: 1, importedWordIds: ['read'], excludedWordIds: [], pausedWordIds: ['read'], aliasBaselines: [], dailyNewWordLimit: 10, updatedAt: '2026-10-15T00:00:00Z' };
  a.indexedDb!.stores.meta = [{ key: 'flashcard-study-preferences:default-user', value: pref }];
  b.indexedDb!.stores.meta = [{ key: 'flashcard-study-preferences:default-user', value: { ...pref, pausedWordIds: [], importedWordIds: ['read', 'book'], updatedAt: '2026-10-16T00:00:00Z' } }];
  const merged = await mergeLocalDataBackups(a, b), value = (merged.indexedDb!.stores.meta[0] as any).value;
  assert.deepEqual(value.pausedWordIds, []); assert.deepEqual(value.importedWordIds, ['read', 'book']);
});

test('ZIP phone-to-computer transfer stages verified assets, atomic merge retains recovery and survives reopen', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'readage-merge-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const from = path.join(root, 'phone'), to = path.join(root, 'computer');
  const bytes = Buffer.from('%PDF-1.7\nfixture\n%%EOF'), hash = createHash('sha256').update(bytes).digest('hex');
  await fs.mkdir(path.join(from, 'documents'), { recursive: true }); await fs.writeFile(path.join(from, 'documents', hash + '.pdf'), bytes);
  const phone = backup({ articles: [article('phone', { sourceDocument: { format: 'pdf', src: `/api/import/documents/${hash}.pdf`, pageNumber: 1, pageCount: 1 } })] });
  const computer = backup({ articles: [article('computer')] });
  const zip = await createFullBackup(phone, from), imported = await prepareFullBackup(await zip.generateAsync({ type: 'nodebuffer' }), to);
  const file = path.join(root, 'learning.sqlite'); let db = new LocalLearningDatabase(file);
  try {
    const { profile } = db.bootstrap(computer), before = db.snapshot(profile.id);
    const merged = await mergeLocalDataBackups(before, imported);
    db.restore(profile.id, profile.revision, merged);
    assert.deepEqual(read(db.previousSnapshot(profile.id), 'articles'), read(computer, 'articles'));
    assert.equal(read(db.snapshot(profile.id), 'articles').length, 2);
    assert.deepEqual(await fs.readFile(path.join(to, 'documents', hash + '.pdf')), bytes);
    assert.throws(() => db.restore(profile.id, profile.revision, merged));
    db.close(); db = new LocalLearningDatabase(file);
    assert.equal(read(db.snapshot(profile.id), 'articles').length, 2);
    zip.file('learning.json', '{}');
    await assert.rejects(prepareFullBackup(await zip.generateAsync({ type: 'nodebuffer' }), to), /完整性核对/);
    assert.equal(read(db.snapshot(profile.id), 'articles').length, 2);
  } finally { db.close(); }
});

test('reading the remaining paragraphs on another device completes the article after merge', async () => {
  const row = article('a'), contentVersion = readingContentVersion(row);
  const a = backup({ articles: [row], readingParagraphProgress: { a: { articleId: 'a', contentVersion, completedParagraphs: [0], updatedAt: '2026-10-15T00:00:00Z' } } });
  const b = backup({ articles: [row], readingParagraphProgress: { a: { articleId: 'a', contentVersion, completedParagraphs: [1], updatedAt: '2026-10-16T00:00:00Z' } } });
  assert.equal(read(await mergeLocalDataBackups(a, b), 'articles')[0].status, 'Completed');
});

test('newer audited flashcard correction overrides the stale rating exactly once', async () => {
  const original: any = { userId: 'default-user', wordId: 'read', articleId: 'a', attemptId: 'attempt', questionId: 'question',
    purpose: 'flashcard_review', rating: 3, outcome: 'recognized', occurredAt: '2026-10-15T10:00:00.000Z', localDate: '2026-10-15', timezone: 'UTC' };
  const corrected = { ...original, rating: 1, outcome: 'incorrect', originalFlashcardRating: 3,
    flashcardRevisions: [{ correctionId: 'correction', revision: 1, previousRating: 3, rating: 1, correctedAt: '2026-10-16T10:00:00.000Z' }] };
  const a = backup(), b = backup();
  putState(a, replayVerificationEvidence(state(), [original], 'UTC'));
  putState(b, replayVerificationEvidence(state(), [corrected], 'UTC'));
  for (const [target, attempt] of [[a, original], [b, corrected]] as const) target.indexedDb!.stores.meta = [{ key: 'reading-verification:default-user', value: { version: 1, userId: 'default-user', attempts: [attempt] } }];
  const merged = await mergeLocalDataBackups(a, b), row = stateRows(merged)[0].state;
  assert.equal(row.fsrsReviews.length, 1); assert.equal(row.fsrsReviews[0].rating, 1);
  assert.equal(row.fsrsReviews[0].flashcardRevisions.length, 1);
  const twice = await mergeLocalDataBackups(merged, a);
  assert.equal(stateRows(twice)[0].state.fsrsReviews[0].rating, 1);
  assert.equal(stateRows(twice)[0].state.fsrsCard.reps, 1);
  const divergent = structuredClone(b);
  (divergent.indexedDb!.stores.meta[0] as any).value.attempts[0].flashcardRevisions[0].correctionId = 'other-branch';
  await assert.rejects(mergeLocalDataBackups(merged, divergent), /冲突/);
});
