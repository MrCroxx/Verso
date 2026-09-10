"use client";

import { useEffect, useRef } from "react";
import { expandImageCropToWhitespace } from "../lib/image-crop";
import type { SourceRect } from "../lib/translation-layout";

export function SourceImageCrop({ source, rect, className, alt }: {
  source: HTMLImageElement | HTMLCanvasElement | null;
  rect: SourceRect;
  className: string;
  alt: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const figureRef = useRef<HTMLElement>(null);
  const width = source ? (source instanceof HTMLImageElement ? source.naturalWidth : source.width) : 0;
  const height = source ? (source instanceof HTMLImageElement ? source.naturalHeight : source.height) : 0;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    if (!source || !width || !height) {
      // Release crop buffers along with the lazy source page.
      canvas.width = 0;
      canvas.height = 0;
      return;
    }
    const estimated = { x: rect.x * width, y: rect.y * height, width: rect.width * width, height: rect.height * height };
    const paddingX = Math.max(8, Math.min(width * 0.06, estimated.width * 0.4));
    const paddingY = Math.max(8, Math.min(height * 0.06, estimated.height * 0.8));
    const x = Math.max(0, Math.floor(estimated.x - paddingX));
    const y = Math.max(0, Math.floor(estimated.y - paddingY));
    const probe = document.createElement("canvas");
    probe.width = Math.min(width - x, Math.ceil(estimated.x + estimated.width + paddingX) - x);
    probe.height = Math.min(height - y, Math.ceil(estimated.y + estimated.height + paddingY) - y);
    let crop = estimated;
    try {
      const context = probe.getContext("2d", { willReadFrequently: true });
      if (context) {
        context.drawImage(source, x, y, probe.width, probe.height, 0, 0, probe.width, probe.height);
        const corrected = expandImageCropToWhitespace(context.getImageData(0, 0, probe.width, probe.height), {
          ...estimated, x: estimated.x - x, y: estimated.y - y,
        });
        crop = { ...corrected, x: corrected.x + x, y: corrected.y + y };
      }
    } catch { /* Keep the estimated crop if pixel readback is unavailable. */ }
    finally { probe.width = 0; probe.height = 0; }
    if (figureRef.current) {
      figureRef.current.style.width = `${crop.width / width * 100}%`;
      figureRef.current.style.marginLeft = `${crop.x / width * 100}%`;
    }
    canvas.style.aspectRatio = `${crop.width} / ${crop.height}`;
    canvas.width = Math.max(1, Math.round(crop.width));
    canvas.height = Math.max(1, Math.round(crop.height));
    canvas.getContext("2d")?.drawImage(
      source, crop.x, crop.y, crop.width, crop.height,
      0, 0, canvas.width, canvas.height,
    );
  }, [source, rect, width, height]);

  return (
    <figure ref={figureRef} className={className} style={{ width: `${rect.width * 100}%`, marginLeft: `${rect.x * 100}%` }}>
      <canvas
        ref={ref}
        role="img"
        aria-label={alt}
      />
    </figure>
  );
}
