import { validateLibraryCatalog, type LibraryItem } from './contentLibraryProtocol';

export const MAGAZINE_LIBRARY_ORIGIN = 'https://readage.xyz';
export const DISTRIBUTED_MAGAZINE_IDS = ['economist', 'new_yorker', 'atlantic', 'wired'] as const;
export const MAGAZINE_LIBRARY_MAX_BYTES = 64 * 1024 * 1024;
export interface DistributedMagazineIssue {
  issueLabel: string;
  item?: LibraryItem;
  error?: string;
}

/** Keep the existing magazine issue identity even when the server's ID includes te_/tny_. */
export function distributedMagazineIssueLabel(id: string, sourceId: string): string | null {
  if (!id.startsWith(`${sourceId}:`)) return null;
  const suffix = id.slice(sourceId.length + 1);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(suffix)) return null;
  const date = suffix.match(/\d{4}[._-]\d{2}[._-]\d{2}/)?.[0];
  const label = date ? date.replace(/[._-]/g, '.') : suffix.replace(/^(te|tny|ta|wired|the)[_-]?/i, '');
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(label) ? label : null;
}

/** Validate the selected source, leaving unrelated books and publishers outside this update. */
export function selectDistributedMagazineIssues(value: unknown, sourceId: string, limit: number): DistributedMagazineIssue[] {
  if (!(DISTRIBUTED_MAGAZINE_IDS as readonly string[]).includes(sourceId)) throw new Error('官网期刊来源无效。');
  const catalog = value as { schemaVersion?: number; items?: unknown[] } | null;
  if (!catalog || catalog.schemaVersion !== 1 || !Array.isArray(catalog.items) || catalog.items.length > 2000) throw new Error('官网期刊目录无效，请稍后重试。');
  const byIssue = new Map<string, DistributedMagazineIssue>();
  for (const raw of catalog.items) {
    const item = raw as LibraryItem | null;
    if (!item || item.kind !== 'magazine' || typeof item.id !== 'string') continue;
    const issueLabel = distributedMagazineIssueLabel(item.id, sourceId);
    if (!issueLabel) continue;
    let candidate: DistributedMagazineIssue;
    try {
      validateLibraryCatalog({ schemaVersion: 1, updatedAt: null,
        sync: { running: false, lastAttemptAt: null, lastSuccessAt: null, error: null }, items: [item] });
      if (item.language !== 'en' || !/\.(epub|pdf)$/i.test(item.filename) || item.bytes > MAGAZINE_LIBRARY_MAX_BYTES) throw new Error('格式或大小无效');
      candidate = { issueLabel, item };
    } catch { candidate = { issueLabel, error: '官网期刊文件信息无效，请稍后重试。' }; }
    const previous = byIssue.get(issueLabel);
    // Prefer a usable EPUB if historical directory names normalize to the same issue.
    if (!previous || !previous.item || candidate.item && /\.epub$/i.test(candidate.item.filename)
      && !/\.epub$/i.test(previous.item.filename)) byIssue.set(issueLabel, candidate);
  }
  return [...byIssue.values()].sort((a, b) => b.issueLabel.localeCompare(a.issueLabel)).slice(0, limit);
}
