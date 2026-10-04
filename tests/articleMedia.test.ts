import test from 'node:test';
import assert from 'node:assert/strict';
import { alignArticleMedia } from '../src/lib/articleMedia';

test('restored illustrations follow the saved paragraph without replacing edited prose', () => {
  const content = ['Title', 'Introduction', 'Body'];
  const source = { content, media: [
    { src: '/api/magazines/assets/photo.jpg', afterParagraphIndex: 1 },
    { src: '/api/magazines/assets/cover.jpg', afterParagraphIndex: -1 },
  ] };
  const savedContent = ['Title', 'Inserted note', 'Introduction', 'Body'];
  assert.deepEqual(alignArticleMedia(source, savedContent).map(image => image.afterParagraphIndex), [2, -1]);
  assert.deepEqual(savedContent, ['Title', 'Inserted note', 'Introduction', 'Body']);
  assert.deepEqual(alignArticleMedia(source, ['Changed text']).map(image => image.src), ['/api/magazines/assets/cover.jpg']);
});
