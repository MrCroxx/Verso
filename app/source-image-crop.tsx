"use client";

import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { excludeImageCaption, excludeImageText, resolveImageCrop } from "../lib/image-crop";
import type { LayoutBlock, SourceRect } from "../lib/translation-layout";

export function SourceImageCrop({ source, rect, className, alt, caption, captionRect, surroundingTextRects, captionSize = "sm", captionFontSize, captionPosition = "bottom", placement = "center", onHighlight }: {
  source: HTMLImageElement | HTMLCanvasElement | null;
  rect: SourceRect;
  className: string;
  alt: string;
  caption?: ReactNode;
  captionRect?: SourceRect;
  surroundingTextRects?: SourceRect[];
  captionSize?: LayoutBlock["size"];
  captionFontSize?: number;
  captionPosition?: "top" | "bottom";
  placement?: "center" | "source";
  onHighlight?: (rects: SourceRect[]) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const mediaRef = useRef<HTMLDivElement>(null);
  const corrected = useRef<{ source: typeof source; estimate: SourceRect; rect: SourceRect } | null>(null);
  const highlighting = useRef(false);
  const showHighlight = () => {
    highlighting.current = true;
    const value = corrected.current;
    onHighlight?.(value && value.source === source && value.estimate === rect ? [value.rect] : []);
  };
  const clearHighlight = () => { highlighting.current = false; onHighlight?.([]); };
  useEffect(() => () => { if (highlighting.current) onHighlight?.([]); }, [onHighlight]);
  const width = source ? (source instanceof HTMLImageElement ? source.naturalWidth : source.width) : 0;
  const height = source ? (source instanceof HTMLImageElement ? source.naturalHeight : source.height) : 0;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    if (!source || !width || !height) {
      // Release crop buffers along with the lazy source page.
      corrected.current = null;
      if (highlighting.current) onHighlight?.([]);
      canvas.width = 0;
      canvas.height = 0;
      return;
    }
    const captionCrop = excludeImageCaption({ width, height },
      { x: rect.x * width, y: rect.y * height, width: rect.width * width, height: rect.height * height },
      captionRect && { x: captionRect.x * width, y: captionRect.y * height, width: captionRect.width * width, height: captionRect.height * height });
    const { crop: estimated, bounds } = excludeImageText({ width, height }, captionCrop.crop,
      (surroundingTextRects ?? []).map((text) => ({ x: text.x * width, y: text.y * height,
        width: text.width * width, height: text.height * height })), captionCrop.bounds);
    const probe = document.createElement("canvas");
    let crop = estimated;
    try {
      const context = probe.getContext("2d", { willReadFrequently: true });
      if (context) {
        crop = resolveImageCrop({ width, height }, estimated, (region) => {
          probe.width = region.width;
          probe.height = region.height;
          context.drawImage(source, region.x, region.y, region.width, region.height, 0, 0, region.width, region.height);
          return context.getImageData(0, 0, region.width, region.height);
        }, { ignorePageRules: placement === "source", bounds });
      }
    } catch { /* Keep the estimated crop if pixel readback is unavailable. */ }
    finally { probe.width = 0; probe.height = 0; }
    if (mediaRef.current) {
      mediaRef.current.style.width = `${crop.width / width * 100}%`;
      mediaRef.current.style.marginLeft = placement === "source" ? `${crop.x / width * 100}%` : "";
    }
    canvas.style.aspectRatio = `${crop.width} / ${crop.height}`;
    canvas.width = Math.max(1, Math.round(crop.width));
    canvas.height = Math.max(1, Math.round(crop.height));
    canvas.getContext("2d")?.drawImage(
      source, crop.x, crop.y, crop.width, crop.height,
      0, 0, canvas.width, canvas.height,
    );
    const sourceRect = { x: crop.x / width, y: crop.y / height, width: crop.width / width, height: crop.height / height };
    corrected.current = { source, estimate: rect, rect: sourceRect };
    if (highlighting.current) onHighlight?.([sourceRect]);
  }, [source, rect, captionRect, surroundingTextRects, width, height, placement, onHighlight]);

  const captionElement = caption && (
    <figcaption className={`layout-block block-caption media-caption size-${captionSize}`}
      style={captionFontSize ? { "--source-font-size": `${captionFontSize}px` } as CSSProperties : undefined}>
      {caption}
    </figcaption>
  );

  return (
    <figure className={className} data-placement={placement}>
      {captionPosition === "top" && captionElement}
      <div ref={mediaRef} className="source-image-content" style={{
        width: `${rect.width * 100}%`,
        ...(placement === "source" && { marginLeft: `${rect.x * 100}%`, marginRight: 0 }),
      }}>
        <canvas ref={ref} role="img" aria-label={alt}
          className={onHighlight ? "mapped-source-image" : undefined}
          tabIndex={onHighlight && source && width > 0 && height > 0 ? 0 : undefined}
          onMouseEnter={showHighlight} onMouseLeave={clearHighlight} onFocus={showHighlight} onBlur={clearHighlight} />
      </div>
      {captionPosition === "bottom" && captionElement}
    </figure>
  );
}
