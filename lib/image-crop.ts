export type PixelRect = { x: number; y: number; width: number; height: number };
export type CropPixels = { width: number; height: number; data: Uint8ClampedArray };

// The caller supplies a bounded neighborhood of the estimated crop, not the full book page.
export function expandImageCropToWhitespace(image: CropPixels, estimate: PixelRect): PixelRect {
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
  const occupied = (edge: number, start: number, end: number, vertical: boolean) => {
    let count = 0;
    for (let index = start; index < end; index++) {
      if ((vertical ? ink(edge, index) : ink(index, edge)) && ++count >= 2) return true;
    }
    return false;
  };
  const extend = (edge: number, step: number, limit: number, start: number, end: number, vertical: boolean) => {
    // A narrow lookahead bridges antialiasing and one-pixel gaps within artwork.
    let blank = 0;
    let lastInk = edge;
    let foundInk = false;
    for (let current = edge; current >= 0 && current < limit; current += step) {
      if (occupied(current, start, end, vertical)) { blank = 0; lastInk = current; foundInk = true; }
      else if (++blank === 3) return foundInk ? Math.max(0, Math.min(limit - 1, lastInk + step * 2)) : edge;
    }
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
