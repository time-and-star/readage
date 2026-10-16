import assert from 'node:assert/strict';
import test from 'node:test';
import { buildArticleMetadataChange } from '../src/lib/articleMetadataPatch';
import { LOCAL_QUERY_KEY_LIMIT } from '../src/lib/localDatabaseProtocol';

const article = (id = 'a') => ({ id, title: 'Article', content: ['Original body'], media: [{ url: '/image.png' }],
  status: 'In Progress', lastOpenedAt: 'yesterday', importEnrichmentError: 'temporary' });

test('article opening/completion uses metadata patches and preserves body and illustrations', () => {
  const previous = [article(), article('b')];
  const next = [{ ...structuredClone(previous[0]), lastOpenedAt: 'today', status: 'Completed', importEnrichmentError: undefined }, previous[1]];
  assert.deepEqual(buildArticleMetadataChange(previous, next), {
    table: 'settings', key: 'english-ai:v2:articles', articleMetadata: [{ id: 'a',
      values: { status: 'Completed', lastOpenedAt: 'today' }, deletedFields: ['importEnrichmentError'] }],
  });
  assert.equal(buildArticleMetadataChange(previous, structuredClone(previous)), null);
});

test('body, language, identity, ordering and import changes always use full persistence', () => {
  const previous = [article(), article('b')];
  for (const next of [
    [{ ...previous[0], content: ['Edited body'] }, previous[1]],
    [{ ...previous[0], language: 'fr' }, previous[1]],
    [{ ...previous[0], media: [] }, previous[1]],
    [{ ...previous[0], id: 'new' }, previous[1]],
    [previous[1], previous[0]], previous.slice(1), [...previous, article('c')],
    [article(), article()],
  ]) assert.equal(buildArticleMetadataChange(previous, next), null);
  assert.equal(buildArticleMetadataChange(null, previous), null);
});

test('large metadata updates fall back to full history within the protocol limit', () => {
  const previous = Array.from({ length: LOCAL_QUERY_KEY_LIMIT + 1 }, (_, index) => article(String(index)));
  const next = previous.map(item => ({ ...item, status: 'Completed' }));
  assert.equal(buildArticleMetadataChange(previous, next), null);
  assert.equal(buildArticleMetadataChange(previous.slice(1), next.slice(1))!.articleMetadata.length, LOCAL_QUERY_KEY_LIMIT);
});
