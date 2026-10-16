import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { parseFullTextFeed, parseFullTextArticle, materializeFullTextArticle, discoverFullTextIssues, validateFeedUrl } from '../server/magazines/fullTextFeeds';
import { getSourceById } from '../server/magazines/config';
import { chaptersToArticles } from '../server/magazines/normalize';

const source = () => getSourceById('jstor_daily')!;
const prose = 'Learning about history helps people understand society and the world around them. '.repeat(10).trim();
function rss(body = `<p>${prose}</p>`, title = 'History &amp; culture') {
  return `<rss><channel><item><title>${title}</title><link>https://daily.jstor.org/story/#fragment</link><pubDate>Tue, 13 Oct 2026 12:00:00 GMT</pubDate><dc:creator>A. Writer</dc:creator><description>Summary only</description><content:encoded><![CDATA[${body}]]></content:encoded></item></channel></rss>`;
}

test('full RSS content preserves title, UTC date, author and stable identity through editorial changes', () => {
  const [entry] = parseFullTextFeed(rss(), source(), 4);
  assert.equal(entry.title, 'History & culture');
  assert.equal(entry.publishedAt, '2026-10-13T12:00:00.000Z');
  assert.equal(entry.author, 'A. Writer');
  assert.equal(entry.url, 'https://daily.jstor.org/story/');
  const [updated] = parseFullTextFeed(rss(`<p>${prose} Revised.</p>`, 'A new title'), source(), 4);
  assert.equal(updated.label, entry.label);
  assert.notEqual(updated.sha, entry.sha);
  const [redated] = parseFullTextFeed(rss().replace('13 Oct 2026', '14 Oct 2026'), source(), 1);
  assert.equal(redated.label, entry.label);
  assert.notEqual(redated.publishedAt, entry.publishedAt);
  const first = chaptersToArticles([parseFullTextArticle(entry, source())], source(), entry.label)[0];
  const next = chaptersToArticles([parseFullTextArticle(updated, source())], source(), updated.label)[0];
  assert.equal(next.id, first.id);
  assert.match(first.id, /:article-1$/);
});

test('Atom uses explicit full content, alternate URL and named author; summaries are rejected', () => {
  const s = getSourceById('conversation')!;
  const xml = `<feed><entry><title>Society</title><link rel="self" href="https://theconversation.com/us/articles.atom"/><link rel="alternate" href="https://theconversation.com/story-123"/><published>2026-10-13T12:00:00Z</published><author><name>A Researcher</name></author><content type="html"><![CDATA[<p>${prose}</p>]]></content></entry></feed>`;
  const [entry] = parseFullTextFeed(xml, s, 2);
  assert.equal(entry.url, 'https://theconversation.com/story-123');
  assert.equal(entry.author, 'A Researcher');
  assert.equal(parseFullTextArticle(entry, s).paragraphs[0], 'By A Researcher');
  const [summary] = parseFullTextFeed(rss().replace(/<content:encoded>[\s\S]*?<\/content:encoded>/, ''), source(), 1);
  assert.throws(() => parseFullTextArticle(summary, source()), /摘要/);
});

test('body traversal keeps sections, quotations, list items, emoji and figure captions in their proper places', () => {
  const body = `<nav>navigation</nav><figure><img src="https://daily.jstor.org/image.jpg" alt="Historic image"/><figcaption>Caption &amp; credit</figcaption></figure><p>${prose}</p><h2>A section</h2><blockquote><p>A quotation.</p></blockquote><ul><li><p>First item</p></li><li>Second item <img class="emoji" src="https://s.w.org/a.svg" alt="🌱"/></li></ul><div class="sharedaddy"><p>Share this</p></div><img width="1" src="https://www.google-analytics.com/tracker"/>`;
  const parsed = parseFullTextArticle(parseFullTextFeed(rss(body), source(), 1)[0], source());
  assert.deepEqual(parsed.paragraphs, ['By A. Writer', prose, 'A section', 'A quotation.', 'First item', 'Second item 🌱']);
  assert.deepEqual(parsed.images, [{ url: 'https://daily.jstor.org/image.jpg', alt: 'Historic image', caption: 'Caption & credit', afterParagraphIndex: 0 }]);
  assert.throws(() => parseFullTextArticle(parseFullTextFeed(rss(`<p>${prose}</p><img src="https://attacker.example/image.jpg"/>`), source(), 1)[0], source()), /图片地址/);
});

test('source URLs reject other publishers, credentials, unsafe protocols and XML declarations', () => {
  for (const url of ['http://daily.jstor.org/story', 'https://daily.jstor.org.attacker.example/story', 'https://u:p@daily.jstor.org/story', 'https://daily.jstor.org:444/story']) assert.throws(() => validateFeedUrl(url, source()));
  assert.throws(() => parseFullTextFeed('<!DOCTYPE rss><rss/>', source(), 1), /XML/);
  assert.throws(() => parseFullTextFeed('<rss><channel><item><link>https://attacker.example/</link></item></channel></rss>', source(), 1), /全文文章/);
});

test('nested quotations and list paragraphs retain text before and after their child paragraphs', () => {
  const body = `<p>${prose}</p><ul><li>Before <em>detail</em><p>Inner paragraph</p>After detail</li></ul><blockquote>Opening<p>Quote</p>Closing</blockquote><h4>A small heading</h4><dl><dt>A term</dt><dd>A definition</dd></dl>`;
  assert.deepEqual(parseFullTextArticle(parseFullTextFeed(rss(body), source(), 1)[0], source()).paragraphs,
    ['By A. Writer', prose, 'Before detail', 'Inner paragraph', 'After detail', 'Opening', 'Quote', 'Closing', 'A small heading', 'A term', 'A definition']);
});

test('images are persisted locally and failed images reject the whole article instead of delivering incomplete content', async () => {
  const entry = parseFullTextFeed(rss(`<p>${prose}</p><figure><img src="https://daily.jstor.org/image.jpg"/><figcaption>Credit</figcaption></figure>`), source(), 1)[0];
  const bytes = Buffer.from([255,216,255,0,0,0,0,0,0,0,0,0]);
  const result = await materializeFullTextArticle(entry, source(), {
    fetchImpl: async url => { assert.equal(String(url), 'https://daily.jstor.org/image.jpg'); return new Response(bytes); },
    saveImage: async buffer => { assert.deepEqual(buffer, bytes); return '/api/magazines/assets/fixture.jpg'; },
  });
  assert.equal(result.media?.[0].src, '/api/magazines/assets/fixture.jpg');
  assert.equal(result.media?.[0].afterParagraphIndex, 1);
  await assert.rejects(materializeFullTextArticle(entry, source(), { fetchImpl: async () => new Response('', { status: 503 }) }), /503/);
  await assert.rejects(materializeFullTextArticle(entry, source(), { fetchImpl: async () => new Response(bytes), saveImage: async () => null }), /图片格式/);
});

test('discovery only reads the official feed and deduplicates links, with a bounded response', async () => {
  const candidates = await discoverFullTextIssues(source(), 4, async url => {
    assert.equal(String(url), source().sourceUrl);
    return new Response(rss().replace('</channel>', rss().match(/<item>[\s\S]*<\/item>/)![0] + '</channel>'));
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].feedEntry?.title, 'History & culture');
  await assert.rejects(discoverFullTextIssues(source(), 1, async () => new Response('', { headers: { 'content-length': String(5 * 1024 * 1024) } })), /下载上限/);
});

test('RSS image enclosures retain a missing lead image, metadata and its position; image updates change the content hash', () => {
  const build = (url = 'https://daily.jstor.org/hero.png?w=800#preview') => rss().replace('</item>',
    `<enclosure type="image/png" url="${url}"/><media:content medium="image" url="https://daily.jstor.org/other.png"><media:title>Historic &amp; image</media:title><media:description><![CDATA[Archive <em>credit</em>]]></media:description></media:content></item>`);
  const [entry] = parseFullTextFeed(build(), source(), 1);
  assert.deepEqual(entry.leadImage, { url: 'https://daily.jstor.org/hero.png?w=800', alt: 'Historic & image', caption: 'Archive credit' });
  assert.deepEqual(parseFullTextArticle(entry, source()).images,
    [{ ...entry.leadImage, afterParagraphIndex: 0 }]);
  const { leadImage } = entry;
  assert.equal(entry.sha, createHash('sha256').update([entry.title, entry.publishedAt, entry.author, entry.html,
    leadImage!.url, leadImage!.alt, leadImage!.caption].join('\n')).digest('hex'));
  const [changed] = parseFullTextFeed(build('https://daily.jstor.org/new-hero.png'), source(), 1);
  assert.equal(changed.label, entry.label);
  assert.notEqual(changed.sha, entry.sha);
  const [noAuthor] = parseFullTextFeed(build().replace('<dc:creator>A. Writer</dc:creator>', ''), source(), 1);
  assert.equal(parseFullTextArticle(noAuthor, source()).images[0].afterParagraphIndex, -1);
});

test('Atom image enclosures and Media RSS groups select images, reject video as an image and fall back to the article title', () => {
  const atom = `<feed><entry><title>History story</title><link href="https://daily.jstor.org/story/"/><link rel="enclosure" type="image/jpeg" href="/hero.jpg#part"/><content type="html"><![CDATA[<p>${prose}</p>]]></content></entry></feed>`;
  assert.deepEqual(parseFullTextFeed(atom, source(), 1)[0].leadImage,
    { url: 'https://daily.jstor.org/hero.jpg', alt: 'History story', caption: '' });
  const group = rss().replace('</item>', '<media:group><media:content type="video/mp4" url="https://daily.jstor.org/movie.mp4"/><media:content medium="image" url="https://daily.jstor.org/hero.jpg"><media:title>Group picture</media:title><media:description>Group caption</media:description></media:content><media:thumbnail url="https://daily.jstor.org/thumb.jpg"/></media:group></item>');
  assert.deepEqual(parseFullTextFeed(group, source(), 1)[0].leadImage,
    { url: 'https://daily.jstor.org/hero.jpg', alt: 'Group picture', caption: 'Group caption' });
  const thumbnail = rss().replace('</item>', '<enclosure type="audio/mpeg" url="https://daily.jstor.org/audio.mp3"/><media:content medium="video" url="https://daily.jstor.org/movie.mp4"/><media:thumbnail url="https://daily.jstor.org/thumb.jpg"/></item>');
  assert.deepEqual(parseFullTextFeed(thumbnail, source(), 1)[0].leadImage,
    { url: 'https://daily.jstor.org/thumb.jpg', alt: 'History & culture', caption: '' });
});

test('lead images already present in HTML retain their original captions and positions across queries and WordPress resize variants', () => {
  for (const [bodyUrl, leadUrl] of [
    ['https://daily.jstor.org/hero.jpg?w=700', 'https://daily.jstor.org/hero.jpg?w=800'],
    ['https://daily.jstor.org/hero-700x420.jpg', 'https://daily.jstor.org/hero.jpg'],
  ]) {
    const xml = rss(`<p>${prose}</p><figure><img src="${bodyUrl}" alt="Original alt"/><figcaption>Original caption</figcaption></figure>`)
      .replace('</item>', `<enclosure type="image/jpeg" url="${leadUrl}"/></item>`);
    const parsed = parseFullTextArticle(parseFullTextFeed(xml, source(), 1)[0], source());
    assert.deepEqual(parsed.images, [{ url: bodyUrl, alt: 'Original alt', caption: 'Original caption', afterParagraphIndex: 1 }]);
  }
});

test('unsafe or unavailable lead images fail this article rather than silently dropping the attachment', async () => {
  const xml = rss().replace('</item>', '<enclosure type="image/jpeg" url="https://attacker.example/hero.jpg"/></item>');
  const [unsafe] = parseFullTextFeed(xml, source(), 1);
  assert.throws(() => parseFullTextArticle(unsafe, source()), /图片地址/);
  const [missing] = parseFullTextFeed(xml.replace('url="https://attacker.example/hero.jpg"', ''), source(), 1);
  assert.equal(missing.leadImage?.url, '');
  assert.throws(() => parseFullTextArticle(missing, source()), /图片缺少/);
  const [entry] = parseFullTextFeed(xml.replace('attacker.example', 'daily.jstor.org'), source(), 1);
  await assert.rejects(materializeFullTextArticle(entry, source(), {
    fetchImpl: async () => new Response('', { status: 503 }),
  }), /503/);
});

test('JSTOR related-story cards are excluded without removing following prose or article-tease topic content', () => {
  const body = `<p>${prose}</p><div class="daily-explore story-list more-to-explore bg-color-gray"><h3>More to Explore</h3><img src="https://daily.jstor.org/related.jpg"/><p>Unrelated story</p></div><p>Real article continuation</p><div class="article-tease"><p>A topic collection entry</p><img src="https://daily.jstor.org/topic.jpg"/></div>`;
  const parsed = parseFullTextArticle(parseFullTextFeed(rss(body), source(), 1)[0], source());
  assert.deepEqual(parsed.paragraphs, ['By A. Writer', prose, 'Real article continuation', 'A topic collection entry']);
  assert.deepEqual(parsed.images.map(image => image.url), ['https://daily.jstor.org/topic.jpg']);
});

test('JSTOR topic collection wrappers retain all 57 images and text without the related-story marker', () => {
  const photos = Array.from({ length: 57 }, (_, index) => `<div class="article-tease"><p>Topic entry ${index + 1}</p><img src="https://daily.jstor.org/topic-${index + 1}.jpg"/></div>`).join('');
  const parsed = parseFullTextArticle(parseFullTextFeed(rss(`<p>${prose}</p><div class="daily-explore story-list bg-color-none">${photos}</div><div class="more-to-explore"><p>This ordinary class alone must not remove prose</p></div>`), source(), 1)[0], source());
  assert.equal(parsed.images.length, 57);
  assert.equal(parsed.paragraphs.length, 60);
  assert.equal(parsed.paragraphs[2], 'Topic entry 1');
  assert.equal(parsed.paragraphs[58], 'Topic entry 57');
  assert.equal(parsed.paragraphs.at(-1), 'This ordinary class alone must not remove prose');
});
