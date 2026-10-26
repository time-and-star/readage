import type { Article } from '../types';
import { getLibraryFileProgress, groupUserLibrary, type UserLibraryItem } from './userLibrary';

export type LibraryGrouping = 'none' | 'status' | 'language' | 'topic';
export const LIBRARY_GROUPINGS: ReadonlyArray<{ value: LibraryGrouping; label: string }> = [
  { value: 'none', label: '不分组' },
  { value: 'status', label: '按阅读状态' },
  { value: 'language', label: '按语言' },
  { value: 'topic', label: '按主题' },
];
export function isLibraryGrouping(value: unknown): value is LibraryGrouping {
  return LIBRARY_GROUPINGS.some(option => option.value === value);
}
export function normalizeLibraryGrouping(value: unknown): LibraryGrouping {
  return isLibraryGrouping(value) ? value : 'none';
}
export interface LibraryOrganizationGroup { key: string; label: string; items: UserLibraryItem[] }
export type LibraryReadingStatus = 'unread' | 'in_progress' | 'completed';
export function libraryItemReadingStatus(item: UserLibraryItem): LibraryReadingStatus {
  if (item.kind === 'file') {
    const progress = getLibraryFileProgress(item.file);
    return progress.completed ? 'completed' : progress.started ? 'in_progress' : 'unread';
  }
  return item.article.status === 'Completed' ? 'completed'
    : Number.isFinite(Date.parse(item.article.lastOpenedAt || '')) ? 'in_progress' : 'unread';
}
const statusLabels: Record<LibraryReadingStatus, string> = {
  unread: '尚未开始', in_progress: '在读', completed: '已读完',
};
function itemArticles(item: UserLibraryItem): readonly Article[] {
  return item.kind === 'file' ? item.file.articles : [item.article];
}
function itemGroup(item: UserLibraryItem, grouping: LibraryGrouping): { key: string; label: string } {
  if (grouping === 'status') {
    const status = libraryItemReadingStatus(item);
    return { key: status, label: statusLabels[status] };
  }
  if (grouping === 'language') {
    // Article's persisted contract treats a missing language as English.
    const languages = [...new Set(itemArticles(item).map(article =>
      (article.language?.trim() || 'en').toLowerCase().split(/[-_]/)[0]))];
    if (languages.length !== 1) return { key: 'multiple_languages', label: '多语言' };
    const language = languages[0];
    return { key: `language:${language}`, label: ({ en: '英语', fr: '法语', ja: '日语', zh: '中文' })[language] || language };
  }
  if (grouping === 'topic') {
    const topics = itemArticles(item).map(article => article.topic?.trim() || '');
    // A partial chapter annotation must not be presented as a whole-book classification.
    if (!topics.length || topics.some(topic => !topic)) return { key: 'unclassified', label: '未分类' };
    const normalized = [...new Set(topics.map(topic => topic.toLowerCase()))];
    return normalized.length === 1 ? { key: `topic:${normalized[0]}`, label: topics[0] }
      : { key: 'multiple_topics', label: '多主题' };
  }
  return { key: 'all', label: '全部书籍与文章' };
}

/** Group whole shelf entries, retaining shelf order and the original chapter order inside each file. */
export function groupLibraryItems(items: readonly UserLibraryItem[], grouping: LibraryGrouping): LibraryOrganizationGroup[] {
  const groups = new Map<string, LibraryOrganizationGroup>();
  for (const item of items) {
    const descriptor = itemGroup(item, normalizeLibraryGrouping(grouping));
    let group = groups.get(descriptor.key);
    if (!group) { group = { ...descriptor, items: [] }; groups.set(descriptor.key, group); }
    group.items.push(item);
  }
  if (grouping === 'status') {
    return ['in_progress', 'unread', 'completed'].flatMap(key => groups.has(key) ? [groups.get(key)!] : []);
  }
  return [...groups.values()];
}

/** The caller supplies the actual personal shelf, rather than recommendation candidates. */
export function getLibraryOrganization(articles: readonly Article[], grouping: LibraryGrouping = 'none') {
  const items = groupUserLibrary(articles);
  const statuses = items.map(libraryItemReadingStatus);
  return {
    grouping: normalizeLibraryGrouping(grouping),
    groups: groupLibraryItems(items, grouping),
    summary: {
      itemCount: items.length,
      fileCount: items.filter(item => item.kind === 'file').length,
      looseArticleCount: items.filter(item => item.kind === 'article').length,
      chapterCount: items.reduce((count, item) => count + (item.kind === 'file' ? item.file.articles.length : 0), 0),
      unreadCount: statuses.filter(status => status === 'unread').length,
      inProgressCount: statuses.filter(status => status === 'in_progress').length,
      completedCount: statuses.filter(status => status === 'completed').length,
    },
  };
}
