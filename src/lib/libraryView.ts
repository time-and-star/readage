import type { MagazineIssue } from '../types';

export interface LibraryView {
  tab: 'mine' | 'magazines';
  levelFilter: string;
  topicQuery: string;
  activeImportBatchId: string | null;
  activeSourceId: string | null;
  selectedIssue: MagazineIssue | null;
  scrollY: number;
  catalogPages: number;
}
export const defaultLibraryView: LibraryView = {
  tab: 'magazines', levelFilter: 'All', topicQuery: '', activeImportBatchId: null,
  activeSourceId: null, selectedIssue: null, scrollY: 0, catalogPages: 1,
};
export function normalizeLibraryView(value: unknown): LibraryView {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...defaultLibraryView };
  const row = value as Partial<LibraryView>;
  const id = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length < 1000 ? value : null;
  const issue = row.selectedIssue;
  const selectedIssue = issue && id(issue.id) && id(issue.sourceId) && typeof issue.title === 'string'
    && ['epub', 'pdf', 'html'].includes(issue.format) && ['ready', 'partial', 'parsing', 'failed'].includes(issue.status)
    ? issue : null;
  return {
    tab: row.tab === 'mine' ? 'mine' : 'magazines',
    levelFilter: ['All', 'A1', 'A2', 'B1', 'B2', 'C1', 'C2'].includes(row.levelFilter ?? '') ? row.levelFilter! : 'All',
    topicQuery: typeof row.topicQuery === 'string' ? row.topicQuery.slice(0, 500) : '',
    activeImportBatchId: row.tab === 'mine' ? id(row.activeImportBatchId) : null,
    activeSourceId: row.tab === 'mine' ? null : selectedIssue?.sourceId ?? id(row.activeSourceId),
    selectedIssue: row.tab === 'mine' ? null : selectedIssue,
    scrollY: typeof row.scrollY === 'number' && Number.isFinite(row.scrollY) ? Math.max(0, row.scrollY) : 0,
    catalogPages: Number.isInteger(row.catalogPages) && row.catalogPages! >= 1 && row.catalogPages! <= 100 ? row.catalogPages! : 1,
  };
}
