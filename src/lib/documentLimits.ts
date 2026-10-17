/** Keep original illustrated EPUB resources; other document budgets remain unchanged. */
export const EPUB_DOCUMENT_MAX_BYTES = 128 * 1024 * 1024;
export const DEFAULT_DOCUMENT_MAX_BYTES = 64 * 1024 * 1024;
export const documentMaxBytes = (filename: string) => /\.epub$/i.test(filename) ? EPUB_DOCUMENT_MAX_BYTES : DEFAULT_DOCUMENT_MAX_BYTES;
export const documentSizeError = (filename: string) => `文件超过 ${documentMaxBytes(filename) / 1024 / 1024}MB，请选择较小的文件。`;
