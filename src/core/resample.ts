/**
 * Area ("box") resampling — the one filter used wherever a raster is reduced.
 *
 * Every source pixel is assigned to exactly one output cell and averaged in: no
 * pixel is skipped and none is counted twice. That property is the entire point.
 * A filter that *samples* — bilinear, nearest — reads a fixed handful of
 * neighbours no matter how big the reduction is, so shrinking 6× ignores roughly
 * nine pixels in every ten and aliases whatever it does happen to land on. The
 * high-frequency detail it destroys is precisely what a relief carve or an
 * engrave exists to reproduce.
 *
 * This lives in core/ and is shared by both places a raster shrinks — the
 * import-time decode ({@link ../core/imageManager}) and the CAM dot-grid
 * resample (`cam/rasterEngrave.resampleGrid`) — so the two cannot drift into
 * disagreeing about what "downscaled" means.
 *
 * Accumulation is tile-at-a-time because the decode path cannot afford, and on
 * Safari cannot even allocate, a full-size canvas for a large photo. Tiles may
 * arrive in any order and in any shape: each source pixel lands in its own cell
 * independently of every other, so the partition into tiles cannot change the
 * result.
 */

/** A rectangle of the SOURCE image, in source pixels. */
export interface TileRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Inclusive value bounds applied per source pixel as it is accumulated. */
export interface ValueClamp {
  min: number;
  max: number;
}

/**
 * Running totals for a box resample. Callers divide {@link sum} by {@link cnt}
 * themselves, because the two consumers want different things from an empty
 * cell — the CAM path falls back to nearest-neighbour (it may be *up*sampling),
 * the decode path can only be downsampling and treats it as unreachable.
 */
export interface BoxAccumulator {
  readonly srcW: number;
  readonly srcH: number;
  readonly outW: number;
  readonly outH: number;
  /** Running total per output cell, row-major. */
  readonly sum: Float64Array;
  /** How many source pixels have landed in each output cell, row-major. */
  readonly cnt: Uint32Array;
}

export function newBoxAccumulator(
  srcW: number,
  srcH: number,
  outW: number,
  outH: number,
): BoxAccumulator {
  return {
    srcW,
    srcH,
    outW,
    outH,
    sum: new Float64Array(outW * outH),
    cnt: new Uint32Array(outW * outH),
  };
}

/**
 * The output cell a source column (or row) index falls into.
 *
 * Floor of the proportional position, clamped to the last cell so that the final
 * source pixel — where `p * outN / srcN` lands exactly on `outN` — folds into the
 * last cell rather than off the end.
 */
export function boxCell(p: number, srcN: number, outN: number): number {
  const c = Math.floor((p * outN) / srcN);
  return c < 0 ? 0 : c > outN - 1 ? outN - 1 : c;
}

/**
 * Add one tile of source pixels to the accumulator. `tile` holds the rectangle's
 * pixels row-major (row 0 = the rect's top row), so `tile[ty * rect.w + tx]` is
 * source pixel `(rect.x + tx, rect.y + ty)`.
 *
 * `clamp` is applied per pixel before summing, matching the CAM path's historical
 * `clamp01`: comparison-based, so a NaN passes through untouched rather than
 * being silently turned into a number.
 */
export function boxAccumulate(
  acc: BoxAccumulator,
  tile: ArrayLike<number>,
  rect: TileRect,
  clamp?: ValueClamp,
): void {
  const { srcW, srcH, outW, outH, sum, cnt } = acc;
  const { x: rx, y: ry, w: rw, h: rh } = rect;
  if (rw <= 0 || rh <= 0) return;
  const min = clamp ? clamp.min : Number.NEGATIVE_INFINITY;
  const max = clamp ? clamp.max : Number.POSITIVE_INFINITY;
  // The column mapping is the same for every row, and the inner loop runs once
  // per source pixel — tens of millions for a large photo — so hoisting it out
  // is the difference between a snappy import and a visible stall.
  const colCell = new Int32Array(rw);
  for (let tx = 0; tx < rw; tx++) colCell[tx] = boxCell(rx + tx, srcW, outW);
  for (let ty = 0; ty < rh; ty++) {
    const rowBase = boxCell(ry + ty, srcH, outH) * outW;
    const tileBase = ty * rw;
    for (let tx = 0; tx < rw; tx++) {
      let v = tile[tileBase + tx];
      if (v < min) v = min;
      else if (v > max) v = max;
      const i = rowBase + colCell[tx];
      sum[i] += v;
      cnt[i]++;
    }
  }
}

/**
 * Mean per output cell, rounded to a byte. `empty` fills any cell no source
 * pixel reached — unreachable while downsampling, since the cell mapping is onto
 * whenever `outN <= srcN`, but a caller that upsamples would see it.
 */
export function boxMeanBytes(acc: BoxAccumulator, empty = 255): Uint8Array {
  const { sum, cnt, outW, outH } = acc;
  const out = new Uint8Array(outW * outH);
  for (let i = 0; i < out.length; i++) out[i] = cnt[i] > 0 ? Math.round(sum[i] / cnt[i]) : empty;
  return out;
}

/**
 * Box-downsample a row-major greyscale buffer in one call — the whole-image
 * convenience over {@link boxAccumulate}, for callers that already hold every
 * pixel in memory.
 */
export function boxDownsampleGrey(
  src: ArrayLike<number>,
  srcW: number,
  srcH: number,
  outW: number,
  outH: number,
): Uint8Array {
  const acc = newBoxAccumulator(srcW, srcH, outW, outH);
  boxAccumulate(acc, src, { x: 0, y: 0, w: srcW, h: srcH });
  return boxMeanBytes(acc);
}
