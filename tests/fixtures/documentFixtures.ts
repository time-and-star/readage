import JSZip from 'jszip';

export const smallPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1cAAAAASUVORK5CYII=', 'base64');
export const wordNamespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

export async function docxFixture(body: string, options: { relationships?: string; styles?: string; prefix?: string; image?: Buffer } = {}): Promise<Buffer> {
  const prefix = options.prefix || 'w';
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>');
  zip.file('word/document.xml', `<${prefix}:document xmlns:${prefix}="${wordNamespace}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><${prefix}:body>${body}</${prefix}:body></${prefix}:document>`);
  zip.file('word/_rels/document.xml.rels', `<Relationships>${options.relationships || '<Relationship Id="photo" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/photo.png"/>'}</Relationships>`);
  if (options.styles) zip.file('word/styles.xml', options.styles);
  zip.file('word/media/photo.png', options.image || smallPng);
  return zip.generateAsync({ type: 'nodebuffer' });
}

/** A self-contained two-dimensional PDF fixture with real text and a coloured graphic. */
export function pdfFixture(pages: Array<{ lines?: string[]; graphic?: boolean; image?: boolean }> = [{ lines: ['Harbor study', 'Boats return safely at sunset.'], graphic: true }]): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, index) => `${4 + index * 2} 0 R`).join(' ')}] >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  pages.forEach((page, index) => {
    const text = (page.lines || []).map(line => `(${line.replace(/[\\()]/g, '\\$&')}) Tj 0 -28 Td`).join('\n');
    const commands = `${page.graphic ? 'q 0.8 0.4 0.1 rg 60 350 350 240 re f Q\n' : ''}${page.image ? 'q 240 0 0 240 60 350 cm /Photo Do Q\n' : ''}BT /F1 18 Tf 60 740 Td\n${text}\nET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> ${page.image ? `/XObject << /Photo ${4 + pages.length * 2} 0 R >>` : ''} >> /Contents ${5 + index * 2} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(commands)} >>\nstream\n${commands}\nendstream`);
  });
  if (pages.some(page => page.image)) {
    const rgb = Buffer.alloc(96 * 96 * 3);
    for (let i = 0; i < rgb.length; i += 3) { rgb[i] = 220; rgb[i + 1] = Math.floor(i / 288) * 2; rgb[i + 2] = 75; }
    objects.push(`<< /Type /XObject /Subtype /Image /Width 96 /Height 96 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${rgb.length} >>\nstream\n${rgb.toString('latin1')}\nendstream`);
  }
  let text = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(text, 'latin1'));
    text += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(text, 'latin1');
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(text, 'latin1');
}
