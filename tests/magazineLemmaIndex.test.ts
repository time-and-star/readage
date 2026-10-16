import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { expandLemmaIndexToCandidates, fetchMagazineArticleById, type MagazineLemmaIndex } from '../src/lib/magazineLemmaIndex';

describe('magazine lemma index candidate expansion', () => {
  it('preserves indexed word count for cold-start length scoring', () => {
    const index: MagazineLemmaIndex = {
      version: 1,
      fingerprint: 'test',
      builtAt: '2026-07-25T00:00:00.000Z',
      articleCount: 1,
      vocab: ['policy', 'trade'],
      articles: [{
        id: 'mag:one',
        title: 'Trade policy',
        level: 'B2',
        wordCount: 320,
        lemmaIndices: [0, 1],
      }],
    };

    const [candidate] = expandLemmaIndexToCandidates(index);
    assert.equal(candidate?.article.estimatedWordCount, 320);
  });

  it('excludes publication directories retained in an old cached index', () => {
    const index: MagazineLemmaIndex = {
      version: 5, fingerprint: 'old-directory-index', builtAt: '2026-10-09T00:00:00.000Z',
      articleCount: 4, vocab: ['target', 'policy'],
      articles: [
        { id: 'directory', title: ' MAGAZINE  ARTICLES ', level: 'B2', wordCount: 657, lemmaIndices: [0, 1] },
        { id: 'contents', title: 'Table of contents', level: 'B1', wordCount: 200, lemmaIndices: [0] },
        { id: 'story', title: 'How magazines cover science', level: 'B2', wordCount: 450, lemmaIndices: [0, 1] },
        { id: 'seen', title: 'Trade policy', level: 'B1', wordCount: 220, lemmaIndices: [1] },
      ],
    };

    const candidates = expandLemmaIndexToCandidates(index, new Set(['seen']));

    assert.deepEqual(candidates.map(candidate => candidate.article.id), ['story']);
    assert.deepEqual(candidates[0].lemmas, ['target', 'policy']);
  });
});

it('article opening can defer media migration while the reader still requests complete illustrations', async () => {
  const requests: string[] = [];
  const signal = new AbortController().signal;
  const fetchImpl: typeof fetch = async (input, options) => {
    requests.push(String(input));
    assert.equal(options?.signal, signal);
    return new Response(JSON.stringify({ ok: true, article: { id: 'mag:test', content: ['Original text'] } }));
  };
  await fetchMagazineArticleById('mag:test', { fetchImpl, signal, deferMedia: true });
  await fetchMagazineArticleById('mag:test', { fetchImpl, signal });
  assert.deepEqual(requests, ['/api/magazines/articles/mag%3Atest?media=defer', '/api/magazines/articles/mag%3Atest']);
});
