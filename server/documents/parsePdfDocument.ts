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
export async function parsePdfDocument(buffer: Buffer, title: string, dataRoot?: string): Promise<PdfImportedPage[]> {
  const parser = new PDFParse({ data: buffer });
  try {
    const info = await parser.getInfo();
    if (info.total < 1 || info.total > MAX_PDF_PAGES) throw new Error(`PDF 页数须在 1–${MAX_PDF_PAGES} 页之间。`);
    // At most 80 reading entries are returned; the source viewer can still visit every page.
    const text = await parser.getText({ first: 80, pageJoiner: '' });
    const src = await savePdfSource(buffer, dataRoot);
    const pages: PdfImportedPage[] = [];
    let imageBytes = 0;
    for (const page of text.pages) {
      const paragraphs = page.text.replace(/\r\n?/g, '\n').split(/\n{2,}/)
        .map(paragraph => paragraph.replace(/\s+/g, ' ').trim()).filter(Boolean);
      const media: ArticleMedia[] = [];
      // PDF.js exposes images by source page, without paragraph positions.
      // Keep them at the page's end rather than claiming an exact inline position.
      if (imageBytes < 64 * 1024 * 1024) {
        try {
          const images = await parser.getImage({ partial: [page.num], imageDataUrl: false, imageBuffer: true });
          const seen = new Set<string>();
          for (const image of (images.pages[0]?.images || []).slice(0, 32)) {
            if (imageBytes + image.data.length > 64 * 1024 * 1024) break;
            const imageSrc = await saveDocumentImage(Buffer.from(image.data), dataRoot);
            imageBytes += image.data.length;
            if (!imageSrc || seen.has(imageSrc)) continue;
            seen.add(imageSrc);
            media.push({ src: imageSrc, alt: `PDF 第 ${page.num} 页插图`, afterParagraphIndex: paragraphs.length - 1 });
          }
        } catch (error) {
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
