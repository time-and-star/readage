import React, { useEffect, useState } from 'react';
import type { ArticleMedia } from '../types';
import { getApiAuthHeaders } from '../lib/apiAuth';
import { IS_ANDROID, IS_OFFLINE_APP } from '../lib/platform/runtime';
import { nativeAssetUrl } from '../lib/platform/nativeFiles';

/** Captions can span a heading and a separate copyright paragraph in the source. */
export function captionIsInParagraphs(caption: string, paragraphs: readonly string[]): boolean {
  const normalize = (text: string) => text.normalize('NFKC').replace(/\s+/g, ' ').trim();
  const expected = normalize(caption);
  if (!expected) return false;
  const text = paragraphs.map(normalize);
  return text.some((_, start) => {
    let joined = '';
    for (let index = start; index < text.length; index++) {
      joined = [joined, text[index]].filter(Boolean).join(' ');
      if (joined === expected) return true;
      if (!expected.startsWith(joined)) return false;
    }
    return false;
  });
}

const ArticleImage: React.FC<{ src: string; alt: string }> = ({ src, alt }) => {
  const privateImage = !IS_ANDROID && src.startsWith('/api/import/images/');
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!privateImage) return;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    let current = true;
    setUrl(null);
    setFailed(false);
    const load = async () => {
      // Credentials are only sent to this exact local raster endpoint.
      if (!/^\/api\/import\/images\/[a-f\d]{64}\.(?:png|jpg|gif|webp)$/.test(src)) throw new Error('Invalid image URL');
      const response = await fetch(src, { headers: getApiAuthHeaders(), signal: controller.signal });
      if (!response.ok) throw new Error('Image unavailable');
      const blob = await response.blob();
      if (!current) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    };
    void load().catch(() => { if (current && !controller.signal.aborted) setFailed(true); });
    return () => { current = false; controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [src, privateImage]);
  if (privateImage && !url) return <span className="font-sans text-xs text-[#85786B]">{failed ? '插图暂时不可用，可查看原页。' : '正在加载插图…'}</span>;
  if (IS_OFFLINE_APP && /^(?:https?:)?\/\//i.test(src)) return <span className="font-sans text-xs text-[#85786B]">此插图尚未保存到本机。</span>;
  return <img src={privateImage ? url! : IS_ANDROID ? nativeAssetUrl(src) : src} alt={alt} loading="lazy" decoding="async" />;
};

export const ArticleMediaFigures: React.FC<{
  media: ArticleMedia[];
  afterParagraphIndex: number;
  paragraphs?: string[];
}> = ({ media, afterParagraphIndex, paragraphs = [] }) => {
  return media.filter(item => item.afterParagraphIndex === afterParagraphIndex).map((item, index) => (
    <figure key={`${item.src}:${index}`} className="reading-figure">
      <ArticleImage src={item.src} alt={item.alt || item.caption || '文章插图'} />
      {item.caption && !captionIsInParagraphs(item.caption, paragraphs) && <figcaption>{item.caption}</figcaption>}
    </figure>
  ));
};
