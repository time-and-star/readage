import { ARTICLE_METADATA_FIELDS, LOCAL_QUERY_KEY_LIMIT, type LocalArticleMetadataChange } from './localDatabaseProtocol';

const metadataFields = new Set<string>(ARTICLE_METADATA_FIELDS);

/** Use a small update only when article order, identities and every body field are unchanged. */
export function buildArticleMetadataChange(previous: unknown, next: unknown): LocalArticleMetadataChange | null {
  if (!Array.isArray(previous) || !Array.isArray(next) || previous.length !== next.length) return null;
  const articleMetadata: LocalArticleMetadataChange['articleMetadata'] = [];
  const ids = new Set<string>();
  for (let index = 0; index < previous.length; index++) {
    const before = previous[index], after = next[index];
    if (!before || !after || typeof before !== 'object' || typeof after !== 'object'
      || typeof before.id !== 'string' || !before.id || before.id !== after.id || ids.has(before.id)) return null;
    ids.add(before.id);
    if (before === after) continue;
    const values: Record<string, unknown> = {};
    const deletedFields: string[] = [];
    for (const field of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (Object.is(before[field], after[field]) || JSON.stringify(before[field]) === JSON.stringify(after[field])) continue;
      if (!metadataFields.has(field)) return null;
      if (after[field] === undefined) deletedFields.push(field);
      else values[field] = after[field];
    }
    if (Object.keys(values).length || deletedFields.length) {
      articleMetadata.push({ id: before.id, values, deletedFields });
      if (articleMetadata.length > LOCAL_QUERY_KEY_LIMIT) return null;
    }
  }
  return articleMetadata.length ? { table: 'settings', key: 'english-ai:v2:articles', articleMetadata } : null;
}
