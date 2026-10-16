import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import { PDFParse } from 'pdf-parse';
import { getDataRoot, writeFileAtomic } from '../magazines/store';

export const MAX_PDF_PAGES = 2000;
const PDF_NAME = /^[a-f\d]{64}\.pdf$/;
const pendingPages = new Map<string, Promise<string>>();

export async function savePdfSource(buffer: Buffer, dataRoot = getDataRoot()): Promise<string> {
  if (buffer.length > 64 * 1024 * 1024 || buffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new Error('PDF 文件不完整或超过 64MB。');
  }
  const name = `${createHash('sha256').update(buffer).digest('hex')}.pdf`;
  const file = path.join(dataRoot, 'documents', name);
  try { await fs.access(file); } catch { await writeFileAtomic(file, buffer); }
  return `/api/import/documents/${name}`;
}

export async function resolvePdfSource(name: string, dataRoot = getDataRoot()): Promise<string | null> {
  if (!PDF_NAME.test(name)) return null;
  const file = path.join(dataRoot, 'documents', name);
  try {
    const stat = await fs.stat(file);
    return stat.isFile() && stat.size <= 64 * 1024 * 1024 ? file : null;
  } catch { return null; }
}

/** Preserve the exact source page; render one bounded page on demand, with a durable cache. */
export async function renderPdfSourcePage(name: string, pageNumber: number, dataRoot = getDataRoot()): Promise<string> {
  if (!PDF_NAME.test(name) || !Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > MAX_PDF_PAGES) {
    throw new Error('原页不存在。');
  }
  const sourceFile = await resolvePdfSource(name, dataRoot);
  if (!sourceFile) throw new Error('原文件不存在。');
  const file = path.join(dataRoot, 'document_pages', name.slice(0, -4), `${pageNumber}.png`);
  try { await fs.access(file); return file; } catch { /* First view renders the retained source. */ }
  const pending = pendingPages.get(file);
  if (pending) return pending;
  if (pendingPages.size >= 2) throw new Error('原页正在处理，请稍后重试。');
  const operation = (async () => {
    const parser = new PDFParse({ data: await fs.readFile(sourceFile) });
    try {
      const info = await parser.getInfo({ partial: [pageNumber], parsePageInfo: true });
      const page = info.pages[0];
      if (info.total > MAX_PDF_PAGES || pageNumber > info.total || !page
        || !Number.isFinite(page.width) || !Number.isFinite(page.height) || page.width <= 0 || page.height <= 0) {
        throw new Error('原页不存在或尺寸不受支持。');
      }
      const scale = Math.min(1100 / page.width, 1800 / page.height, 3);
      const rendered = await parser.getScreenshot({ partial: [pageNumber], scale, imageDataUrl: false, imageBuffer: true });
      const bytes = rendered.pages[0]?.data;
      if (!bytes?.length || bytes.length > 12 * 1024 * 1024) throw new Error('无法生成原页。');
      await writeFileAtomic(file, Buffer.from(bytes));
      return file;
    } finally { await parser.destroy(); }
  })();
  pendingPages.set(file, operation);
  try { return await operation; } finally { pendingPages.delete(file); }
}
