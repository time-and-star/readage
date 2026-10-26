import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bookIntroduction } from '../src/lib/bookIntroduction';
import { BOOK_PROFILES } from '../src/data/bookProfiles';
import { getPublicationProfile } from '../src/data/publicationProfiles';
import { MAGAZINE_SOURCES } from '../server/magazines/config';
import type { UserLibraryFile } from '../src/lib/userLibrary';

function file(title: string, resourceId?: string): UserLibraryFile {
  return { id: 'isolated-book', title, format: 'epub', articles: [{
    id: 'isolated-book-0', title: 'Chapter 1', description: 'A made-up first-chapter description must never become a whole-book synopsis.',
    date: '', status: 'In Progress', content: ['This is the actual imported passage. Its words remain unchanged in the preview, without making any claims about the rest of the book.'],
    ...(resourceId ? { distribution: { resourceId, title, version: 'isolated', serverUrl: 'https://example.org', totalCount: 3 } } : {}),
  }] };
}

test('catalog IDs identify a work even when the display title changes, without changing the file', () => {
  const profile = BOOK_PROFILES[0];
  const book = file('Renamed book', profile.resourceIds[0]);
  const before = structuredClone(book);
  assert.equal(bookIntroduction(book).introduction, profile.introduction);
  assert.deepEqual(book, before);
});

test('unknown resource IDs and title-only or wrong-author local files cannot inherit a famous work profile', () => {
  const profile = BOOK_PROFILES[0];
  for (const book of [file(`${profile.titles[0]} — ${profile.authors[0]}`, 'book:unknown'),
    file(profile.titles[0]), file(`${profile.titles[0]} — Someone Else`)]) {
    const result = bookIntroduction(book);
    assert.match(result.introduction, /尚未收录/);
    assert.notEqual(result.introduction, book.articles[0].description);
    assert.match(result.assessment, /暂无经过核对/);
    assert.equal(result.excerpt, book.articles[0].content[0]);
  }
});

test('local title and author must both match a known work, retaining sources and scope', () => {
  const profile = BOOK_PROFILES[0];
  const result = bookIntroduction(file(`${profile.titles[0]} — ${profile.authors[0]}`));
  assert.equal(result.introduction, profile.introduction);
  assert.deepEqual(result.sources, profile.sources);
  assert.match(result.notice, /具体版本/);
});

test('fallback distinguishes a partial import and a literal excerpt from a full-book introduction', () => {
  const book = file('Unverified book', 'book:unverified');
  const result = bookIntroduction(book);
  assert.match(result.assessment, /已导入1章.*共3章/);
  assert.match(result.introduction, /尚未收录/);
  book.articles[0].content = [];
  assert.equal(bookIntroduction(book).excerpt, undefined);
});

test('every configured publication has dated provenance, with no prototype-key fallback', () => {
  for (const source of MAGAZINE_SOURCES) {
    const profile = getPublicationProfile(source.id);
    assert.ok(profile?.introduction && profile.assessment && profile.verifiedAt);
    assert.ok(profile.sources.length > 0 && profile.sources.every(item => new URL(item.url).protocol === 'https:'));
  }
  assert.equal(getPublicationProfile('toString'), undefined);
  assert.equal(getPublicationProfile('unknown'), undefined);
});

test('imported magazines use their exact publication identity without inferring a single-issue review', () => {
  const book = file('The Economist 2026.10.17', 'economist:2026.10.17');
  book.articles[0].distribution!.kind = 'magazine';
  const result = bookIntroduction(book);
  assert.equal(result.name, '经济学人');
  assert.equal(result.introduction, getPublicationProfile('economist')!.introduction);
  assert.match(result.notice, /非本期内容提要/);
  for (const resourceId of ['unknown:2026.10.17', 'economist:', 'economist:../bad']) {
    book.articles[0].distribution!.resourceId = resourceId;
    assert.match(bookIntroduction(book).introduction, /尚未收录/);
  }
});
