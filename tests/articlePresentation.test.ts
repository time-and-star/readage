import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyArticleParagraph,
  getArticleInlineParts,
  isDuplicateArticleTitle,
} from '../src/lib/articlePresentation';

test('classifies an imported article title and byline for editorial layout', () => {
  assert.equal(
    classifyArticleParagraph(
      'ROBERT RAUSCHENBERG’S PENCHANT FOR INVENTION AND SPECTACLE',
      'Robert Rauschenberg\'s Penchant for Invention and Spectacle'
    ),
    'title'
  );
  assert.equal(
    classifyArticleParagraph('by Amy Weiss-Meyer', 'An article title'),
    'author'
  );
  assert.equal(
    classifyArticleParagraph('Byline: Elizabeth Kolbert', 'An article title'),
    'author'
  );
  assert.equal(
    classifyArticleParagraph('Author Jane Doe', 'An article title'),
    'author'
  );
  assert.equal(
    classifyArticleParagraph('The author argues for slower change.', 'An article title'),
    'body'
  );
});

test('separates safe article hyperlinks from surrounding prose', () => {
  assert.deepEqual(
    getArticleInlineParts('Read [the source](https://example.com/story), then visit https://openai.com/.'),
    [
      { type: 'text', value: 'Read ' },
      { type: 'link', value: 'the source', href: 'https://example.com/story' },
      { type: 'text', value: ', then visit ' },
      { type: 'link', value: 'https://openai.com/', href: 'https://openai.com/' },
      { type: 'text', value: '.' },
    ],
  );
});

test('classifies webpage navigation and separator lines as import furniture', () => {
  assert.equal(
    classifyArticleParagraph('| Next | Section menu | Main menu | Previous |', 'An article title'),
    'furniture'
  );
  assert.equal(classifyArticleParagraph('------------------------------', 'An article title'), 'furniture');
  assert.equal(
    classifyArticleParagraph('Read: The disturbing history of the Bracero Program', 'An article title'),
    'furniture'
  );
  assert.equal(
    classifyArticleParagraph(
      'This article was downloaded by calibre from https://www.theatlantic.com/magazine/2026/04/example/1/',
      'An article title'
    ),
    'furniture'
  );
  assert.equal(
    classifyArticleParagraph('This poem appears in the August 2026 print edition.', 'A poem'),
    'furniture'
  );
});

test('keeps normal article paragraphs in the reading flow', () => {
  assert.equal(
    classifyArticleParagraph('In 2007, the artists put a new twist on a famous sculpture.', 'An article title'),
    'body'
  );
});

test('matches duplicate headings across capitalization, Unicode quotes, dashes and spacing', () => {
  for (const paragraph of [
    'AI HELPS WOMEN IN KENYA – LEVEL 2',
    '“AI helps women in Kenya—level 2”',
    '«AI helps women in Kenya - level 2»',
    ' AI helps women\n in Kenya – level 2 ',
  ]) {
    assert.equal(isDuplicateArticleTitle(paragraph, 'AI helps women in Kenya – level 2'), true);
    assert.equal(classifyArticleParagraph(paragraph, 'AI helps women in Kenya – level 2'), 'title');
  }
});

test('preserves ordinary sentences and section headings that are not duplicate titles', () => {
  const title = 'When America walks away';
  for (const paragraph of [
    'When America walks away.',
    'When America walks away, the region will change.',
    'Leaders | The Middle East',
    'For decades America has enjoyed hegemony over the Middle East.',
  ]) {
    assert.equal(isDuplicateArticleTitle(paragraph, title), false);
    assert.equal(classifyArticleParagraph(paragraph, title), 'body');
  }
  assert.equal(isDuplicateArticleTitle(' ', ''), false);
  assert.equal(isDuplicateArticleTitle('If we dont change', "If we don't change"), false);
});
