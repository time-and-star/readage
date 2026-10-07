import React, { memo, useEffect, useRef } from 'react';
import { buildStainedGlassPattern, type StainedGlassPattern } from '../lib/stainedGlass';
import { drawStainedGlass } from '../lib/stainedGlassArtwork';
import { mapGlassDensityToWindow, readGlassImageAnalysis } from '../lib/glassImageAnalysis';
import { galleryImageInsets, type GalleryForm } from '../lib/galleryArtDirection';

interface StainedGlassProps {
  identity: string;
  imageSrc: string;
  form?: GalleryForm;
}

export const StainedGlass = memo(function StainedGlass({ identity, imageSrc, form = 'portrait' }: StainedGlassProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = canvas?.parentElement;
    const image = container?.querySelector('img');
    if (!canvas || !container || !image) return;
    canvas.width = 1; canvas.height = 1;
    delete canvas.dataset.glassReady;
    delete canvas.dataset.glassPanes;
    delete canvas.dataset.glassComplexity;
    let nearby = false;
    let disposed = false;
    let frame: number | null = null;
    let pattern: StainedGlassPattern | null = null;
    let patternLayout = '';
    const paint = () => {
      frame = null;
      if (disposed || !nearby || !image.complete || !image.naturalWidth) return;
      const style = getComputedStyle(image);
      const containerStyle = getComputedStyle(container);
      const position = style.objectPosition.split(' ').map(value => {
        if (value === 'left' || value === 'top') return 0;
        if (value === 'right' || value === 'bottom') return 1;
        return value.endsWith('%') ? parseFloat(value) / 100 : .5;
      });
      const analysis = readGlassImageAnalysis(image, imageSrc);
      const insets = galleryImageInsets(form);
      // Use the CSS aspect ratio, so the same photo keeps its pattern on phones and desktops.
      const aspectParts = containerStyle.aspectRatio.split('/').map(Number);
      const aspect = aspectParts.length === 2 && aspectParts.every(value => value > 0)
        ? aspectParts[0] / aspectParts[1] : container.clientWidth / container.clientHeight;
      const canonicalHeight = Math.round(300 / aspect);
      const layout = `${canonicalHeight}:${style.objectFit}:${position.join(':')}:${form}`;
      if (!pattern || patternLayout !== layout) {
        pattern = buildStainedGlassPattern(identity, analysis ? {
          paneCount: analysis.paneCount,
          density: mapGlassDensityToWindow(analysis.density, image.naturalWidth, image.naturalHeight,
            300, canonicalHeight, style.objectFit, position[0] ?? .5, position[1] ?? .5, insets),
        } : undefined);
        patternLayout = layout;
      }
      drawStainedGlass(canvas, image, pattern, {
        width: container.clientWidth, height: container.clientHeight,
        pixelRatio: Math.min(2, window.devicePixelRatio || 1), fit: style.objectFit,
        positionX: position[0] ?? .5, positionY: position[1] ?? .5,
        background: containerStyle.backgroundColor,
        insets,
        compact: window.matchMedia('(max-width: 639px)').matches,
      });
      canvas.dataset.glassReady = 'true';
      canvas.dataset.glassPanes = String(pattern.panes.length);
      if (analysis) canvas.dataset.glassComplexity = analysis.score.toFixed(3);
    };
    const requestPaint = () => {
      if (nearby && frame === null) frame = requestAnimationFrame(paint);
    };
    const observer = new IntersectionObserver(entries => {
      nearby = entries.some(entry => entry.isIntersecting);
      if (nearby) requestPaint();
      else {
        // Retain the light geometry, but release offscreen decoded canvas pixels.
        canvas.width = 1; canvas.height = 1;
        delete canvas.dataset.glassReady;
      }
    }, { root: container.closest('.reading-gallery__track'), rootMargin: '0px 320px' });
    observer.observe(container);
    const resize = new ResizeObserver(requestPaint);
    resize.observe(container);
    image.addEventListener('load', requestPaint);
    return () => {
      disposed = true;
      observer.disconnect(); resize.disconnect();
      image.removeEventListener('load', requestPaint);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [identity, imageSrc, form]);
  return <canvas ref={canvasRef} width={1} height={1} className="reading-gallery__stained-glass" aria-hidden="true" />;
});
