import { appendPreparedFileBatch, FILE_IMPORT_BATCH_SIZE, FILE_IMPORT_PREPARATION_LIMIT, type ImportedFileBatch, type PreparedFileImport } from './userFileImport';

/** Prepare one selected volume through the same full parser on each platform. No library writes occur here. */
export async function prepareSelectedLibraryBook(options: {
  file: File; current: PreparedFileImport | null; offset: number; signal: AbortSignal;
  readBatch: (offset: number, limit: number) => Promise<ImportedFileBatch>;
  onBatch: (prepared: PreparedFileImport) => void;
}): Promise<PreparedFileImport> {
  let current = options.current, offset = options.offset;
  while ((current?.articles.length ?? 0) < FILE_IMPORT_PREPARATION_LIMIT) {
    options.signal.throwIfAborted();
    const batch = await options.readBatch(offset, Math.min(FILE_IMPORT_BATCH_SIZE, FILE_IMPORT_PREPARATION_LIMIT - (current?.articles.length ?? 0)));
    options.signal.throwIfAborted();
    current = appendPreparedFileBatch(current, options.file, batch); options.onBatch(current);
    if (current.nextOffset === null) return current;
    offset = current.nextOffset;
  }
  return current!;
}
