export type PixelRect = { x: number; y: number; width: number; height: number };
export type CropPixels = { width: number; height: number; data: Uint8ClampedArray };
type CropOptions = { ignorePageRules?: boolean; bounds?: PixelRect };

export function excludeImageCaption(page: { width: number; height: number }, estimate: PixelRect, caption?: PixelRect) {
  const fullPage = { x: 0, y: 0, ...page };
  if (!caption || Math.min(estimate.x + estimate.width, caption.x + caption.width) <= Math.max(estimate.x, caption.x)) {
    return { crop: estimate, bounds: fullPage };
  }
  // Use the caption's source location, independently of its display position.
  const above = caption.y + caption.height / 2 < estimate.y + estimate.height / 2;
  const top = above ? Math.min(page.height, Math.ceil(caption.y + caption.height) + 2) : 0;
  const bottom = above ? page.height : Math.max(0, Math.floor(caption.y) - 2);
  const y = Math.max(estimate.y, top);
  const height = Math.min(estimate.y + estimate.height, bottom) - y;
  // Do not erase an image when the available caption coordinates are inconsistent.
  if (height < Math.max(4, estimate.height * 0.1)) return { crop: estimate, bounds: fullPage };
  return { crop: { ...estimate, y, height }, bounds: { x: 0, y: top, width: page.width, height: bottom - top } };
}

export function resolveImageCrop(
  page: { width: number; height: number },
  estimate: PixelRect,
  readPixels: (region: PixelRect) => CropPixels,
  options: CropOptions = {},
): PixelRect {
  const initialX = Math.max(8, Math.min(page.width * 0.06, estimate.width * 0.4));
  const initialY = Math.max(8, Math.min(page.height * 0.06, estimate.height * 0.8));
  let crop = estimate;
  const bounds = options.bounds ?? { x: 0, y: 0, ...page };
  // Decorative marks can extend beyond a model's estimate by more than the
  // initial probe. Retry only when artwork reaches that probe's boundary.
  const attempts = options.ignorePageRules ? 3 : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const paddingX = initialX * 2 ** attempt;
    const paddingY = Math.min(initialY * 2 ** attempt, page.height * 0.12);
    const x = Math.max(bounds.x, Math.floor(estimate.x - paddingX));
    const y = Math.max(bounds.y, Math.floor(estimate.y - paddingY));
    const region = {
      x, y,
      width: Math.min(bounds.x + bounds.width, Math.ceil(estimate.x + estimate.width + paddingX)) - x,
      height: Math.min(bounds.y + bounds.height, Math.ceil(estimate.y + estimate.height + paddingY)) - y,
    };
    const corrected = expandImageCropToWhitespace(readPixels(region), {
      ...estimate, x: estimate.x - x, y: estimate.y - y,
    }, options);
    crop = { ...corrected, x: corrected.x + x, y: corrected.y + y };
    const needsMore = (corrected.x === 0 && x > bounds.x)
      || (corrected.y === 0 && y > bounds.y)
      || (corrected.x + corrected.width === region.width && x + region.width < bounds.x + bounds.width)
      || (corrected.y + corrected.height === region.height && y + region.height < bounds.y + bounds.height);
    if (!needsMore) break;
  }
  return crop;
}

// The caller supplies a bounded neighborhood of the estimated crop, not the full book page.
export function expandImageCropToWhitespace(image: CropPixels, estimate: PixelRect, options: CropOptions = {}): PixelRect {
  const { width, height, data } = image;
  const samples: number[][] = [[], [], []];
  for (const x of [0, 1, width - 2, width - 1]) {
    for (const y of [0, 1, height - 2, height - 1]) {
      const offset = (Math.max(0, y) * width + Math.max(0, x)) * 4;
      for (let channel = 0; channel < 3; channel++) samples[channel].push(data[offset + channel]);
    }
  }
  const background = samples.map((values) => values.sort((a, b) => a - b)[Math.floor(values.length * 0.75)]);
  const ink = (x: number, y: number) => {
    const offset = (y * width + x) * 4;
    return data[offset + 3] > 128 && background.some((value, channel) => Math.abs(data[offset + channel] - value) > 32);
  };
  let left = Math.max(0, Math.floor(estimate.x));
  let top = Math.max(0, Math.floor(estimate.y));
  let right = Math.min(width, Math.ceil(estimate.x + estimate.width));
  let bottom = Math.min(height, Math.ceil(estimate.y + estimate.height));
  const ruleRows = new Set<number>();
  if (options.ignorePageRules) {
    // A page separator can cross the whole probe and prevent a logo edge from
    // ever reaching whitespace. Ignore only thin rules spanning the crop and
    // continuing to a probe boundary, not borders contained inside the artwork.
    let bandStart = -1;
    for (let y = 0; y <= height; y++) {
      let run = 0;
      if (y < height) {
        let fromLeft = 0;
        let fromRight = 0;
        while (fromLeft < width && ink(fromLeft, y)) fromLeft++;
        while (fromRight < width && ink(width - 1 - fromRight, y)) fromRight++;
        run = Math.max(fromLeft, fromRight);
      }
      if (run >= (right - left) * 0.95) {
        if (bandStart < 0) bandStart = y;
      } else if (bandStart >= 0) {
        if (y - bandStart <= Math.max(3, Math.ceil(estimate.height * 0.08))) {
          for (let row = bandStart; row < y; row++) ruleRows.add(row);
        }
        bandStart = -1;
      }
    }
    let firstInk = bottom;
    let lastInk = top - 1;
    for (let y = top; y < bottom; y++) {
      if (ruleRows.has(y)) continue;
      let count = 0;
      for (let x = left; x < right; x++) if (ink(x, y)) count++;
      if (count >= 2) { firstInk = Math.min(firstInk, y); lastInk = y; }
    }
    if (lastInk >= firstInk) {
      for (const row of ruleRows) {
        if (row + 3 < firstInk) top = Math.max(top, row + 2);
        if (row - 3 > lastInk) bottom = Math.min(bottom, row - 1);
      }
    }
  }
  const occupied = (edge: number, start: number, end: number, vertical: boolean) => {
    let count = 0;
    for (let index = start; index < end; index++) {
      if (ruleRows.has(vertical ? index : edge)) continue;
      if ((vertical ? ink(edge, index) : ink(index, edge)) && ++count >= 2) return true;
    }
    return false;
  };
  const extend = (edge: number, step: number, limit: number, start: number, end: number, vertical: boolean) => {
    // Logos need enough lookahead to bridge gaps between their letters.
    const blankLimit = options.ignorePageRules && vertical ? Math.max(3, Math.min(12, Math.round(estimate.height * 0.1))) : 3;
    let blank = 0;
    let lastInk = edge;
    let foundInk = false;
    for (let current = edge; current >= 0 && current < limit; current += step) {
      if (occupied(current, start, end, vertical)) { blank = 0; lastInk = current; foundInk = true; }
      else if (++blank === blankLimit) return foundInk ? Math.max(0, Math.min(limit - 1, lastInk + step * 2)) : edge;
    }
    // Signal that the probe cut through a mark so the caller can enlarge it.
    // Returning the original edge here silently restored the clipped estimate.
    if (options.ignorePageRules && foundInk) return step < 0 ? 0 : limit - 1;
    // Do not grow into arbitrary neighboring content when no separating whitespace exists.
    return edge;
  };
  for (let pass = 0; pass < 3; pass++) {
    left = Math.min(left, extend(left, -1, width, top, bottom, true));
    right = Math.max(right, extend(right - 1, 1, width, top, bottom, true) + 1);
    top = Math.min(top, extend(top, -1, height, left, right, false));
    bottom = Math.max(bottom, extend(bottom - 1, 1, height, left, right, false) + 1);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}
