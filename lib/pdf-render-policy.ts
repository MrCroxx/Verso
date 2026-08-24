export type PdfRenderPolicy = {
  mobile: boolean;
  concurrency: number;
  maxCanvasWidth: number;
  maxCanvasPixels: number;
};

export function pdfRenderPolicy(
  viewportWidth: number,
  devicePixelRatio: number,
  coarsePointer: boolean,
): PdfRenderPolicy {
  const mobile = coarsePointer || viewportWidth <= 900;
  if (!mobile) {
    return {
      mobile: false,
      concurrency: 2,
      maxCanvasWidth: 1280,
      maxCanvasPixels: 4_000_000,
    };
  }

  const physicalViewportWidth = Math.max(1, viewportWidth) * Math.max(1, devicePixelRatio);
  return {
    mobile: true,
    concurrency: 1,
    maxCanvasWidth: Math.round(Math.min(1024, Math.max(896, physicalViewportWidth))),
    maxCanvasPixels: 2_000_000,
  };
}

export function pdfRenderScale(
  pageWidth: number,
  pageHeight: number,
  policy: PdfRenderPolicy,
) {
  if (!(pageWidth > 0) || !(pageHeight > 0)) return 1;
  const widthScale = policy.maxCanvasWidth / pageWidth;
  const areaScale = Math.sqrt(policy.maxCanvasPixels / (pageWidth * pageHeight));
  return Math.max(0.1, Math.min(2, widthScale, areaScale));
}
