import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { bookAppearance, localizedBookTitle } from '../website/book-presentation.js';
import { validateLibraryCatalog } from '../src/lib/contentLibraryProtocol';
const manifest = JSON.parse(await readFile(new URL('../website/book-titles.zh-CN.json', import.meta.url), 'utf8'));
const entries: Array<{ id: string; sha256: string; zhCN: string; originalTitle: string; authorZhCN: string; authorOriginal: string }> = manifest.entries;

test('all 506 hand-written book titles retain English originals, volumes and stable catalogue identities', () => {
  assert.equal(entries.length, 506); assert.equal(new Set(entries.map(e => e.id)).size, 506);
  const catalog = validateLibraryCatalog({ schemaVersion: 1, updatedAt: null,
    sync: { running: false, lastAttemptAt: null, lastSuccessAt: null, error: null },
    items: entries.map(e => ({ id: e.id, kind: 'book', language: 'en', title: localizedBookTitle(e),
      filename: `${e.sha256}.epub`, sha256: e.sha256, bytes: 1, updatedAt: '2026-10-17T00:00:00Z', downloadPath: `/api/library/files/${e.sha256}` })) });
  for (const item of catalog.items) {
    const entry = entries.find(e => e.id === item.id)!;
    const appearance = bookAppearance(item);
    assert.equal(appearance.name, entry.zhCN); assert.equal(appearance.author, entry.authorZhCN);
    assert.ok(appearance.originalTitle.startsWith(entry.originalTitle.split(' — ')[0]));
    assert.ok(!appearance.originalTitle.endsWith(' — Unknown'));
    assert.equal(appearance.theme, bookAppearance({ ...item, title: entry.originalTitle }).theme);
  }
});

test('author metadata stays separate from the book title; pen names and five missing credits are resolved', () => {
  assert.equal(new Set(entries.map(e => e.authorZhCN)).size, 198);
  const find = (name: string) => entries.find(e => e.zhCN === name)!;
  const pride = bookAppearance({ id: find('傲慢与偏见').id, title: localizedBookTitle(find('傲慢与偏见')) });
  assert.equal(pride.name, '傲慢与偏见'); assert.equal(pride.author, '简·奥斯汀');
  assert.equal(pride.originalTitle, 'Pride and Prejudice — Jane Austen');
  for (const [name, author] of [['动物庄园', '乔治·奥威尔'], ['一九八四', '乔治·奥威尔'], ['天使，望故乡', '托马斯·沃尔夫'], ['再见，吾爱', '雷蒙德·钱德勒'], ['我的早年生活', '温斯顿·丘吉尔']]) {
    assert.equal(find(name).authorZhCN, author); assert.ok(!localizedBookTitle(find(name)).endsWith(' — Unknown'));
  }
  assert.equal(find('缅甸岁月').authorZhCN, find('动物庄园').authorZhCN);
  assert.equal(find('巴黎伦敦落魄记').authorZhCN, find('一九八四').authorZhCN);
  const legacy = bookAppearance({ id: 'book:legacy', title: '旧书名｜Original Title' });
  assert.equal(legacy.name, '旧书名'); assert.equal(legacy.author, '');
});

test('familiar works use established book titles and do not substitute a different work by the same author', () => {
  const title = (original: string) => entries.find(e => e.originalTitle.startsWith(original))?.zhCN;
  assert.equal(title('Pride and Prejudice —'), '傲慢与偏见');
  assert.equal(title('Gone with the Wind —'), '飘');
  assert.equal(title('An Inquiry into the Nature and Causes of the Wealth of Nations —'), '国富论');
  assert.equal(title('The Story of My Life /'), '我的生活（海伦·凯勒自传）');
  assert.equal(title('History of the Decline and Fall of the Roman Empire — Volume 6'), '罗马帝国衰亡史（第六卷）');
});

test('English-only covers and magazine dates keep their existing presentation', () => {
  const english = bookAppearance({ id: 'book:other', title: 'A Book — An Author' });
  assert.equal(english.name, 'A Book — An Author'); assert.equal(english.originalTitle, '');
  const magazine = bookAppearance({ id: 'economist:2026.10.17', kind: 'magazine', title: 'The Economist · 2026.10.17' });
  assert.equal(magazine.name, 'The Economist'); assert.equal(magazine.edition, '2026.10.17');
  assert.equal(magazine.theme, 'clay'); assert.equal(magazine.originalTitle, '');
});
