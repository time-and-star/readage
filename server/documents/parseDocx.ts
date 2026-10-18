import JSZip from 'jszip';
import { parseDocument } from 'htmlparser2';
import type { ParsedChapter, EpubParseOptions } from '../magazines/parseEpub';
import { saveArticleImage } from '../magazines/assets';

type XmlNode = { name?: string; data?: string; attribs?: Record<string, string>; children?: XmlNode[] };
const MAX_XML_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_MEDIA_BYTES = 64 * 1024 * 1024;

function* descendants(root: XmlNode, skip?: string): Generator<XmlNode> {
  const pending = [...(root.children || [])].reverse();
  while (pending.length) {
    const node = pending.pop()!;
    if (node.name === skip) continue;
    yield node;
    pending.push(...(node.children || []).slice().reverse());
  }
}

function localName(node: XmlNode): string { return (node.name || '').split(':').pop() || ''; }
function attribute(node: XmlNode | undefined, name: string): string | undefined {
  return Object.entries(node?.attribs || {}).find(([key]) => key.split(':').pop() === name)?.[1];
}

async function readXml(zip: JSZip, name: string): Promise<XmlNode | null> {
  const file = zip.file(name);
  if (!file) return null;
  const declaredSize = (file as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
  if (declaredSize && declaredSize > MAX_XML_BYTES) throw new Error('Word 文档结构超过解析上限。');
  const buffer = await file.async('nodebuffer');
  if (buffer.length > MAX_XML_BYTES) throw new Error('Word 文档结构超过解析上限。');
  const xml = buffer.toString('utf8');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Word 文档包含不支持的 XML 声明。');
  return parseDocument(xml, { xmlMode: true, decodeEntities: true }) as XmlNode;
}

function resolveImagePath(target: string): string | null {
  let decoded: string;
  try { decoded = decodeURIComponent(target); } catch { return null; }
  if (/^[\/\\]|[\\:\u0000]/.test(decoded)) return null;
  const segments = ['word'];
  for (const segment of decoded.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (!segments.length) return null;
      segments.pop();
    } else segments.push(segment);
  }
  return segments.join('/');
}

function paragraphText(paragraph: XmlNode, prefix: string): string {
  const parts: string[] = [];
  for (const node of descendants(paragraph, `${prefix}del`)) {
    if (node.name === `${prefix}t`) {
      parts.push([...(node.children || [])].map(child => child.data || '').join(''));
    } else if (node.name === `${prefix}tab` || node.name === `${prefix}br`) parts.push(' ');
  }
  return parts.join('').replace(/\s+/g, ' ').trim();
}

/** OOXML is read as data; relationships never fetch external resources or execute embedded objects. */
export async function parseDocxBuffer(
  buffer: Buffer,
  fallbackTitle: string,
  options: EpubParseOptions = {},
): Promise<ParsedChapter[]> {
  options.signal?.throwIfAborted();
  const zip = await JSZip.loadAsync(buffer);
  options.signal?.throwIfAborted();
  const document = await readXml(zip, 'word/document.xml');
  options.signal?.throwIfAborted();
  const root = document && [...descendants(document)].find(node => localName(node) === 'document');
  if (!root) throw new Error('缺少 Word 正文。请使用 DOCX 文件。');
  const prefix = root.name!.includes(':') ? `${root.name!.split(':')[0]}:` : '';
  const namespace = root.attribs?.[prefix ? `xmlns:${prefix.slice(0, -1)}` : 'xmlns'];
  if (namespace !== 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
    && namespace !== 'http://purl.oclc.org/ooxml/wordprocessingml/main') {
    throw new Error('Word 文档格式不完整。');
  }
  const body = [...descendants(root)].find(node => node.name === `${prefix}body`);
  if (!body) throw new Error('缺少 Word 正文。');
  const relationshipXml = await readXml(zip, 'word/_rels/document.xml.rels');
  options.signal?.throwIfAborted();
  const relationships = new Map<string, string>();
  if (relationshipXml) for (const node of descendants(relationshipXml)) {
    if (localName(node) !== 'Relationship' || attribute(node, 'TargetMode')?.toLowerCase() === 'external') continue;
    const id = attribute(node, 'Id');
    const target = attribute(node, 'Target');
    if (id && target && /\/image$/.test(attribute(node, 'Type') || '')) relationships.set(id, target);
  }
  const styleXml = await readXml(zip, 'word/styles.xml');
  options.signal?.throwIfAborted();
  const styles = new Map<string, { name: string; outline?: string; basedOn?: string }>();
  if (styleXml) for (const node of descendants(styleXml)) {
    if (localName(node) !== 'style') continue;
    const name = [...descendants(node)].find(child => localName(child) === 'name');
    const id = attribute(node, 'styleId');
    const outline = [...descendants(node)].find(child => localName(child) === 'outlineLvl');
    const basedOn = [...descendants(node)].find(child => localName(child) === 'basedOn');
    if (id) styles.set(id, { name: attribute(name, 'val') || id, outline: attribute(outline, 'val'), basedOn: attribute(basedOn, 'val') });
  }
  const styleProperties = (id: string) => {
    const seen = new Set<string>();
    let outline: string | undefined, title = false, caption = false;
    while (id && !seen.has(id)) {
      seen.add(id);
      const style = styles.get(id);
      const name = style?.name || id;
      title ||= /^(title|标题)$/i.test(id) || /^(title|标题)$/i.test(name);
      caption ||= /^(caption|题注)$/i.test(id) || /^(caption|题注)$/i.test(name);
      // A derived style's explicit body outline (9) overrides an inherited heading.
      outline ??= style?.outline;
      if (outline === undefined && (/^heading\s*1$/i.test(id) || /^(heading\s*1|标题\s*1)$/i.test(name))) outline = '0';
      id = style?.basedOn || '';
    }
    return { outline, title, caption };
  };

  const chapters: ParsedChapter[] = [];
  let current: ParsedChapter = { title: fallbackTitle, paragraphs: [], wordCount: 0, media: [] };
  let mediaBytes = 0;
  const savedImages = new Map<string, string | null>();
  const saveImage = options.saveImage || saveArticleImage;
  const publish = () => {
    current.wordCount = current.paragraphs.join(' ').split(/\s+/).filter(Boolean).length;
    if (current.wordCount) chapters.push(current);
  };
  const pending = [...(body.children || [])].reverse();
  while (pending.length) {
    options.signal?.throwIfAborted();
    const paragraph = pending.pop()!;
    if (paragraph.name === `${prefix}del`) continue;
    if (paragraph.name !== `${prefix}p`) {
      pending.push(...(paragraph.children || []).slice().reverse());
      continue;
    }
    const text = paragraphText(paragraph, prefix);
    const nodes = [...descendants(paragraph, `${prefix}del`)];
    const styleId = attribute(nodes.find(node => node.name === `${prefix}pStyle`), 'val') || '';
    const style = styleProperties(styleId);
    const isTitle = style.title;
    const outline = attribute(nodes.find(node => node.name === `${prefix}outlineLvl`), 'val') ?? style.outline;
    const isChapter = outline === '0';
    if (text && (isTitle || isChapter)) {
      if (isChapter && current.paragraphs.some(item => item !== current.title)) {
        publish();
        current = { title: text.slice(0, 200), paragraphs: [], wordCount: 0, media: [] };
      } else current.title = text.slice(0, 200);
    }
    if (text) current.paragraphs.push(text);
    if (text && style.caption) {
      const image = current.media?.[current.media.length - 1];
      if (image && image.afterParagraphIndex === current.paragraphs.length - 2) image.caption = text;
    }
    const description = nodes.find(node => localName(node) === 'docPr');
    for (const node of nodes) {
      options.signal?.throwIfAborted();
      const imageId = localName(node) === 'blip' ? attribute(node, 'embed')
        : localName(node) === 'imagedata' ? attribute(node, 'id') : undefined;
      const target = imageId && relationships.get(imageId);
      const imagePath = target && resolveImagePath(target);
      if (!imagePath) continue;
      let src = savedImages.get(imagePath);
      if (!savedImages.has(imagePath)) {
        const file = zip.file(imagePath);
        const originalName = (file as unknown as { unsafeOriginalName?: string } | null)?.unsafeOriginalName;
        const declaredSize = (file as unknown as { _data?: { uncompressedSize?: number } } | null)?._data?.uncompressedSize;
        if (!file || (originalName && originalName !== file.name) || (declaredSize && declaredSize > MAX_IMAGE_BYTES)) continue;
        const image = await file.async('nodebuffer');
        options.signal?.throwIfAborted();
        if (image.length > MAX_IMAGE_BYTES) continue;
        mediaBytes += image.length;
        if (mediaBytes > MAX_MEDIA_BYTES) throw new Error('Word 插图总大小超过 64MB。');
        src = await saveImage(image);
        options.signal?.throwIfAborted();
        savedImages.set(imagePath, src);
      }
      if (src) current.media!.push({
        src,
        alt: attribute(description, 'descr') || attribute(description, 'title'),
        afterParagraphIndex: current.paragraphs.length - 1,
      });
    }
  }
  publish();
  return chapters;
}
