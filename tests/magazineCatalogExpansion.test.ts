import assert from 'node:assert/strict';
import test from 'node:test';
import { getSourceById, MAGAZINE_SOURCES } from '../server/magazines/config';
import { mergeConfiguredSourceSummaries } from '../server/magazines/store';
import type { MagazineSourceSummary } from '../src/types';
import fs from 'node:fs';
import { DISTRIBUTED_MAGAZINE_IDS, MAGAZINE_LIBRARY_ORIGIN } from '../src/lib/magazineDistribution';

const articleSourceIds = ['conversation', 'jstor_daily', 'science_news_explores', 'mit_press_reader'];

test('Android source names, topics, levels, formats and addresses match the Node catalog', () => {
  const java = fs.readFileSync(new URL('../android/app/src/main/java/cn/readage/app/NativeMagazineStore.java', import.meta.url), 'utf8');
  const block = java.match(/String\[\]\[\] SOURCES\s*=\s*\{([\s\S]*?)\n\s*\};/)?.[1];
  assert.ok(block, 'native catalog definition is inspectable');
  const origin = java.match(/LIBRARY_ORIGIN\s*=\s*("[^"]+")/)?.[1];
  const catalogPath = java.match(/LIBRARY_CATALOG\s*=\s*LIBRARY_ORIGIN\s*\+\s*("[^"]+")/)?.[1];
  assert.ok(origin && catalogPath, 'native official catalog address is inspectable');
  const catalog = JSON.stringify(JSON.parse(origin) + JSON.parse(catalogPath));
  const rows = [...block.matchAll(/\{([^{}]+)\}/g)].map(match => JSON.parse(`[${match[1].replace(/\bLIBRARY_CATALOG\b/g, catalog)}]`) as string[]);
  assert.deepEqual(rows, MAGAZINE_SOURCES.map(source => [source.id, source.displayName,
    (DISTRIBUTED_MAGAZINE_IDS as readonly string[]).includes(source.id) ? `${MAGAZINE_LIBRARY_ORIGIN}/api/library/catalog` : source.sourceUrl || source.repoDir,
    source.levelHint, source.topic, source.sourceKind]));
});

test('new public article sources use complete official feeds with bounded image hosts', () => {
  const expected = [
    ['conversation', 'https://theconversation.com/us/articles.atom', 'B2', 'images.theconversation.com'],
    ['jstor_daily', 'https://daily.jstor.org/feed/', 'C1', 'daily.jstor.org'],
    ['science_news_explores', 'https://www.snexplores.org/feed', 'B1', 'www.snexplores.org'],
    ['mit_press_reader', 'https://thereader.mitpress.mit.edu/feed/', 'C1', 'thereader.mitpress.mit.edu'],
  ];
  for (const [id, feed, level, imageHost] of expected) {
    const source = getSourceById(id);
    assert.ok(source, `${id} is selectable without replacing an existing source`);
    assert.equal(source.provider, 'rss_fulltext');
    assert.equal(source.sourceKind, 'web_articles');
    assert.equal(source.sourceUrl, feed);
    assert.equal(source.levelHint, level);
    assert.deepEqual(source.imageHosts, [imageHost]);
    assert.equal(new URL(source.sourceUrl!).protocol, 'https:');
    assert.ok(source.imageHosts!.every(host => /^[a-z0-9.-]+$/.test(host)));
  }
  const imageHosts = MAGAZINE_SOURCES.flatMap(source => source.imageHosts || []);
  for (const trackingHost of ['counter.theconversation.com', 'www.google-analytics.com', 's.w.org']) {
    assert.ok(!imageHosts.includes(trackingHost), `${trackingHost} is not an article illustration source`);
  }
});

test('existing periodicals and graded news retain their source identity and delivery kind', () => {
  for (const id of ['economist', 'new_yorker', 'atlantic', 'wired']) {
    const source = getSourceById(id);
    assert.ok(source?.repoDir);
    assert.equal(source.sourceKind, 'issue');
    assert.equal(source.provider || 'github', 'github');
  }
  for (const id of ['news_in_levels_a2', 'news_in_levels_b1']) {
    assert.equal(getSourceById(id)?.sourceKind, 'graded_news');
    assert.equal(getSourceById(id)?.provider, 'news_in_levels');
  }
  assert.equal(new Set(MAGAZINE_SOURCES.map(source => source.id)).size, MAGAZINE_SOURCES.length);
});

test('an older six-source index gains article sources without losing cached counts or mutating stored data', () => {
  const legacy: MagazineSourceSummary[] = [
    { id: 'economist', displayName: 'Old Economist name', issueCount: 12 },
    { id: 'new_yorker', displayName: 'Old New Yorker name', issueCount: 7 },
    { id: 'atlantic', displayName: 'Old Atlantic name', issueCount: 6 },
    { id: 'wired', displayName: 'Old Wired name', issueCount: 4 },
    { id: 'news_in_levels_a2', displayName: 'Old Level 1 name', issueCount: 9 },
    { id: 'news_in_levels_b1', displayName: 'Old Level 2 name', issueCount: 5 },
  ];
  const snapshot = structuredClone(legacy);
  const merged = mergeConfiguredSourceSummaries(legacy);
  for (const stored of legacy) {
    const source = merged.find(item => item.id === stored.id);
    assert.equal(source?.issueCount, stored.issueCount);
    assert.equal(source?.displayName, getSourceById(stored.id)?.displayName);
    assert.equal(source?.sourceKind, getSourceById(stored.id)?.sourceKind);
  }
  for (const id of articleSourceIds) {
    assert.equal(merged.find(source => source.id === id)?.issueCount, 0);
    assert.equal(merged.find(source => source.id === id)?.sourceKind, 'web_articles');
  }
  assert.deepEqual(legacy, snapshot);
  assert.deepEqual(mergeConfiguredSourceSummaries(merged), merged, 'reloading the index is idempotent');
});

test('source metadata updates preserve downloaded website article counts and keep private image policy out of summaries', () => {
  const merged = mergeConfiguredSourceSummaries([
    { id: 'conversation', displayName: 'Old label', issueCount: 3, sourceKind: 'issue' },
  ]);
  const conversation = merged.find(source => source.id === 'conversation');
  assert.equal(conversation?.displayName, 'The Conversation');
  assert.equal(conversation?.sourceKind, 'web_articles');
  assert.equal(conversation?.issueCount, 3);
  assert.ok(!Object.hasOwn(conversation!, 'imageHosts'));
  assert.ok(!Object.hasOwn(conversation!, 'sourceUrl'));
});
