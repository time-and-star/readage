import React, { memo, useLayoutEffect, useRef, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import type { GalleryWindowItem } from '../lib/galleryWindow';
import { buildGalleryArtDirection, galleryImageInsets } from '../lib/galleryArtDirection';
import { readGlassImageAnalysis } from '../lib/glassImageAnalysis';
import { StainedGlass } from './StainedGlass';
import { nativeAssetUrl } from '../lib/platform/nativeFiles';

interface GalleryStoryProps {
  item: GalleryWindowItem;
  eager: boolean;
  disabled: boolean;
  opening: boolean;
  onOpen: () => void;
  onFocus: () => void;
  onImageReady: () => void;
  onImageError: () => void;
}

export const GalleryStory = memo(function GalleryStory({ item, eager, disabled, opening,
  onOpen, onFocus, onImageReady, onImageError }: GalleryStoryProps) {
  const identity = `${item.articleId}:${item.image.src}`;
  const imageRef = useRef<HTMLImageElement>(null);
  const [direction, setDirection] = useState(() => buildGalleryArtDirection(identity, 0, 0, null, .5, item.sequence));
  const directImage = (image: HTMLImageElement) => {
    if (!image.naturalWidth || !image.naturalHeight) return;
    const analysis = readGlassImageAnalysis(image, item.image.src);
    setDirection(buildGalleryArtDirection(identity, image.naturalWidth, image.naturalHeight,
      analysis?.palette, analysis?.score, item.sequence));
    onImageReady();
  };
  useLayoutEffect(() => {
    const image = imageRef.current;
    if (image?.complete) directImage(image);
  }, [identity]);
  const insets = galleryImageInsets(direction.form);
  const style = {
    '--art-ratio': direction.aspect,
    '--frame-base': direction.colours.frame,
    '--frame-light': direction.colours.light,
    '--frame-shade': direction.colours.shade,
    '--frame-edge': direction.colours.edge,
    '--mat-colour': direction.colours.mat,
    '--image-paper': direction.colours.paper,
    '--label-accent': direction.colours.accent,
    '--image-top': `${insets.top * 100}%`,
    '--image-right': `${insets.right * 100}%`,
    '--image-bottom': `${insets.bottom * 100}%`,
    '--image-left': `${insets.left * 100}%`,
    '--exhibit-offset': `${[18, 82, 36, 108, 50, 12, 68][(item.sequence - 1) % 7]}px`,
  } as React.CSSProperties;
  return <button type="button" data-gallery-card data-gallery-sequence={item.sequence}
    data-gallery-form={direction.form} data-gallery-material={direction.material}
    data-gallery-orientation={direction.landscape ? 'landscape' : 'portrait'}
    className="reading-gallery__story" style={style} aria-label={`阅读 ${item.title}`} disabled={disabled}
    onFocus={onFocus} onClick={onOpen}>
    <div className="reading-gallery__mount">
      <div className="reading-gallery__artwork">
        <div className="reading-gallery__mat">
          <div className="reading-gallery__image">
            <img ref={imageRef} src={nativeAssetUrl(item.image.src)} alt={item.image.alt || item.title}
              loading={eager ? 'eager' : 'lazy'} decoding="async" draggable={false}
              onLoad={event => directImage(event.currentTarget)} onError={onImageError} />
            <StainedGlass identity={identity} imageSrc={item.image.src} form={direction.form} />
          </div>
        </div>
        <span className="reading-gallery__glass" aria-hidden="true" />
      </div>
      <span className="reading-gallery__image-link">{opening ? '打开中…' : '进入故事'} <ArrowRight size={14} /></span>
    </div>
    <div className="reading-gallery__label">
      <span className="reading-gallery__catalog-number" aria-hidden="true">{String(item.sequence).padStart(2, '0')}</span>
      <div>
        <p className="reading-gallery__source">{item.sourceName}</p>
        <h3>{item.title}</h3>
        <p className="reading-gallery__date">{item.issueLabel.replaceAll('.', ' / ')}</p>
      </div>
    </div>
  </button>;
});
