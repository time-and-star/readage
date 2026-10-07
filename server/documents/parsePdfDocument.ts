import { PDFParse } from 'pdf-parse';
import type { ArticleMedia, ArticleSourceDocument } from '../../src/types';
import { MAX_PDF_PAGES, savePdfSource } from './pdfSource';
import { saveDocumentImage } from './assets';

export interface PdfImportedPage {
  title: string;
  paragraphs: string[];
  wordCount: number;
  media?: ArticleMedia[];
  sourceDocument: ArticleSourceDocument;
}

/** A page boundary is reliable even for columns, illustrations and scans. */
export async function parsePdfDocument(buffer: Buffer, title: string, dataRoot?: string,
  options: { offset?: number; limit?: number; signal?: AbortSignal } = {}): Promise<PdfImportedPage[]> {
  options.signal?.throwIfAborted();
  const parser = new PDFParse({ data: buffer });
  try {
    const info = await parser.getInfo();
    options.signal?.throwIfAborted();
    if (info.total < 1 || info.total > MAX_PDF_PAGES) throw new Error(`PDF 页数须在 1–${MAX_PDF_PAGES} 页之间。`);
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 80;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= info.total
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 80) throw new Error(`PDF 共有 ${info.total} 页，请选择有效范围（每批最多 80 页）。`);
    const partial = Array.from({ length: Math.min(limit, info.total - offset) }, (_, index) => offset + index + 1);
    const text = await parser.getText({ partial, pageJoiner: '' });
    options.signal?.throwIfAborted();
    const src = await savePdfSource(buffer, dataRoot);
    options.signal?.throwIfAborted();
    const pages: PdfImportedPage[] = [];
    let imageBytes = 0;
    for (const page of text.pages) {
      options.signal?.throwIfAborted();
      const paragraphs = page.text.replace(/\r\n?/g, '\n').split(/\n{2,}/)
        .map(paragraph => paragraph.replace(/\s+/g, ' ').trim()).filter(Boolean);
      const media: ArticleMedia[] = [];
      // PDF.js exposes images by source page, without paragraph positions.
      // Keep them at the page's end rather than claiming an exact inline position.
      if (imageBytes < 64 * 1024 * 1024) {
        try {
          const images = await parser.getImage({ partial: [page.num], imageDataUrl: false, imageBuffer: true });
          options.signal?.throwIfAborted();
          const seen = new Set<string>();
          for (const image of (images.pages[0]?.images || []).slice(0, 32)) {
            options.signal?.throwIfAborted();
            if (imageBytes + image.data.length > 64 * 1024 * 1024) break;
            const imageSrc = await saveDocumentImage(Buffer.from(image.data), dataRoot);
            imageBytes += image.data.length;
            if (!imageSrc || seen.has(imageSrc)) continue;
            seen.add(imageSrc);
            media.push({ src: imageSrc, alt: `PDF 第 ${page.num} 页插图`, afterParagraphIndex: paragraphs.length - 1 });
          }
        } catch (error) {
          options.signal?.throwIfAborted();
          // An unsupported drawing must never discard successfully extracted text.
          console.warn(`[pdf-import] Page ${page.num} images unavailable:`, error instanceof Error ? error.message : error);
        }
      }
      pages.push({
        title: info.total === 1 ? title : `${title} · 第 ${page.num} 页`,
        paragraphs,
        wordCount: paragraphs.join(' ').split(/\s+/).filter(Boolean).length,
        ...(media.length ? { media } : {}),
        sourceDocument: { format: 'pdf', src, pageNumber: page.num, pageCount: info.total },
      });
    }
    return pages;
  } finally { await parser.destroy(); }
}
