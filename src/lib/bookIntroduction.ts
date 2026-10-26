import { BOOK_PROFILES } from '../data/bookProfiles';
import { bookAppearance } from '../../website/book-presentation.js';
import type { UserLibraryFile } from './userLibrary';
import { getPublicationProfile } from '../data/publicationProfiles';
import { magazineSourceCaption } from './magazinePresentation';

const normalized = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();

export function bookIntroduction(file: UserLibraryFile) {
  const edition = file.articles[0]?.distribution;
  const title = edition?.title || file.title;
  const appearance = bookAppearance({ id: edition?.resourceId || file.id, title, kind: edition?.kind });
  const original = appearance.originalTitle || title;
  const separator = original.lastIndexOf(' — ');
  const work = separator > 0 ? original.slice(0, separator) : '';
  const author = separator > 0 ? original.slice(separator + 3) : '';
  const magazineId = edition?.kind === 'magazine'
    ? edition.resourceId.match(/^([a-z][a-z0-9_]*):([a-zA-Z0-9][a-zA-Z0-9._-]{0,79})$/)?.[1] : undefined;
  const magazine = magazineId ? getPublicationProfile(magazineId) : undefined;
  if (magazine) return {
    name: magazineSourceCaption({ id: magazineId!, displayName: title }).name,
    originalName: title,
    ...magazine,
    notice: '关于刊物整体，非本期内容提要。',
  };
  // A supplied resource ID is authoritative; a changed/unknown ID must not fall
  // through to a similarly named work. Local files need both title and author.
  const profile = edition?.kind === 'magazine' ? undefined : edition?.resourceId
    ? BOOK_PROFILES.find(item => item.resourceIds.includes(edition.resourceId))
    : BOOK_PROFILES.find(item => work && author && item.titles.some(value => normalized(value) === normalized(work))
      && item.authors.some(value => normalized(value) === normalized(author)));

  if (profile) return {
    name: appearance.name,
    originalName: appearance.originalTitle || undefined,
    introduction: profile.introduction,
    assessment: profile.assessment,
    sources: profile.sources,
    verifiedAt: profile.verifiedAt,
    notice: '介绍针对作品整体；当前文件的具体版本与完整性以实际导入内容为准。',
  };

  // Show verifiable local content without relabelling a first-chapter fragment
  // or an import-generated Article.description as a whole-book synopsis.
  const paragraph = file.articles.flatMap(article => article.content)
    .find(text => text.trim().length >= 60 && !/project gutenberg|copyright|all rights reserved|目录|table of contents/i.test(text));
  const excerpt = paragraph ? Array.from(paragraph.trim()).slice(0, 220).join('') : '';
  const unit = file.format === 'epub' ? '章' : file.format === 'pdf' ? '页' : '篇';
  const total = edition?.totalCount;
  const imported = `当前文件已导入${file.articles.length}${unit}${total ? `，目录记录共${total}${unit}` : ''}。`;
  return {
    name: appearance.name,
    originalName: appearance.originalTitle || undefined,
    introduction: '尚未收录这本书的可靠简介。',
    excerpt: excerpt ? `${excerpt}${Array.from(paragraph!.trim()).length > 220 ? '…' : ''}` : undefined,
    assessment: `${imported}暂无经过核对的作品评价。`,
    notice: '原文摘录来自当前导入文件。',
  };
}
