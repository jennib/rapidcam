/**
 * Image manager: a registry of raster images used by image entities, keyed by a
 * content-hash id (`img-XXXXXXXX`). Mirrors the font manager — load from a file
 * picker, embed into a .rcam file, register an embedded one back on load.
 *
 * What's stored is a **downscaled greyscale** buffer, not the original colour
 * bytes. A laser engraves greyscale, so colour carries no machining information;
 * greyscale also lets file-load stay synchronous (no async image decode — the
 * decode happens only at import time, which is browser-only anyway) and keeps the
 * embedded payload small (one byte per pixel, capped resolution). The canvas
 * renders the greyscale and the path generator consumes it directly.
 */

import type { RasterGrid } from "../cam/rasterEngrave";

/** Longest-edge pixel cap applied on import. Engrave resolution is bounded by the
 *  dot pitch, so a photo larger than this carries no usable extra detail — and it
 *  keeps the embedded buffer (and the .rcam file) from ballooning. */
export const MAX_IMAGE_EDGE = 1000;

export interface ImageEntry {
  id: string;
  name: string;
  /** Pixel dims of the stored (possibly downscaled) greyscale buffer. */
  width: number;
  height: number;
  /** Greyscale, row-major, row 0 = top. 0 = black, 255 = white. length = w*h. */
  gray: Uint8Array;
  /** Cached 0..1 float view for the path generator (built lazily). */
  grayF?: Float32Array;
  /** Cached canvas for drawing (built lazily, browser only). */
  canvas?: HTMLCanvasElement;
}

const IMAGES = new Map<string, ImageEntry>();

export function getImageEntry(id: string): ImageEntry | null {
  return IMAGES.get(id) ?? null;
}

/** Whether an image id resolves to loaded pixels (else it engraves nothing). */
export function isImageResolvable(id: string): boolean {
  return IMAGES.has(id);
}

/** The greyscale grid (values 0..1, row 0 = top) for the path generator, or null. */
export function getImageGrid(id: string): RasterGrid | null {
  const e = IMAGES.get(id);
  if (!e) return null;
  if (!e.grayF) {
    const f = new Float32Array(e.gray.length);
    for (let i = 0; i < e.gray.length; i++) f[i] = e.gray[i] / 255;
    e.grayF = f;
  }
  return { width: e.width, height: e.height, data: e.grayF };
}

/**
 * A canvas of the greyscale image, for drawing on the 2D view. Built and cached
 * on first use; browser only. Returns null if the id isn't loaded.
 */
export function getImageCanvas(id: string): HTMLCanvasElement | null {
  const e = IMAGES.get(id);
  if (!e) return null;
  if (!e.canvas) {
    const cv = document.createElement("canvas");
    cv.width = e.width;
    cv.height = e.height;
    const ctx = cv.getContext("2d")!;
    const img = ctx.createImageData(e.width, e.height);
    for (let i = 0; i < e.width * e.height; i++) {
      const g = e.gray[i];
      img.data[i * 4] = g;
      img.data[i * 4 + 1] = g;
      img.data[i * 4 + 2] = g;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    e.canvas = cv;
  }
  return e.canvas;
}

/** FNV-1a 32-bit hash of the bytes, hex — stable content id for an image. */
function hashBytes(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Rec.601 luma of an RGBA ImageData → a row-major greyscale Uint8 (row 0 = top). */
function toGreyscale(rgba: Uint8ClampedArray, w: number, h: number): Uint8Array {
  const gray = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = rgba[i * 4],
      g = rgba[i * 4 + 1],
      b = rgba[i * 4 + 2],
      a = rgba[i * 4 + 3];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    // Treat transparency as white (no burn) so a cut-out PNG engraves only its subject.
    gray[i] = Math.round(a === 255 ? lum : lum * (a / 255) + 255 * (1 - a / 255));
  }
  return gray;
}

/** Register a greyscale buffer, returning its content id (deduped). */
function register(name: string, width: number, height: number, gray: Uint8Array): string {
  const id = `img-${hashBytes(gray)}`;
  if (!IMAGES.has(id)) IMAGES.set(id, { id, name, width, height, gray });
  return id;
}

/** Public register — used after an import-time tone/contrast adjustment. */
export function registerGrey(
  name: string,
  width: number,
  height: number,
  gray: Uint8Array,
): string {
  return register(name, width, height, gray);
}

/** Raw greyscale, decoded and downscaled but not registered — the input to an
 *  import-time adjustment (brightness/contrast) before the final buffer is baked. */
export interface DecodedImage {
  name: string;
  width: number;
  height: number;
  gray: Uint8Array;
}

/** Tone adjustment applied to a greyscale buffer at import. Both in [-100, 100],
 *  0 = no change. Baked into the stored buffer, so it feeds laser power and mill
 *  relief depth identically — nothing downstream needs to know about it. */
export interface ToneAdjust {
  brightness: number;
  contrast: number;
}

/**
 * Apply brightness/contrast to a greyscale buffer via a 256-entry LUT. Contrast
 * uses the classic pivot-at-128 factor; brightness is an additive offset. Returns
 * a new buffer (the input is left untouched so a preview can re-derive from it).
 * A no-op adjustment returns a copy unchanged.
 */
export function adjustGrey(gray: Uint8Array, adj: ToneAdjust): Uint8Array {
  const b = (Math.max(-100, Math.min(100, adj.brightness)) / 100) * 127;
  const c = (Math.max(-100, Math.min(100, adj.contrast)) / 100) * 255;
  const f = (259 * (c + 255)) / (255 * (259 - c));
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) {
    const nv = f * (v - 128) + 128 + b;
    lut[v] = nv < 0 ? 0 : nv > 255 ? 255 : Math.round(nv);
  }
  const out = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) out[i] = lut[gray[i]];
  return out;
}

/** Decode + downscale a picked file to raw greyscale without registering it, so
 *  the caller can offer an import-time adjustment before baking the final buffer. */
export async function decodeImageFile(file: File): Promise<DecodedImage> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  const rgba = ctx.getImageData(0, 0, w, h).data;
  return {
    name: file.name.replace(/\.[^.]+$/, ""),
    width: w,
    height: h,
    gray: toGreyscale(rgba, w, h),
  };
}

/** An embedded image as it appears in a .rcam file (base64 greyscale buffer). */
export interface EmbeddedImage {
  id: string;
  name: string;
  width: number;
  height: number;
  /** Base64-encoded greyscale bytes (row-major, row 0 = top). */
  data: string;
}

/** Collect the embedded form of the given image ids, skipping any not loaded. */
export function collectEmbeddedImages(ids: Iterable<string>): EmbeddedImage[] {
  const out: EmbeddedImage[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const e = IMAGES.get(id);
    if (!e) continue;
    out.push({
      id: e.id,
      name: e.name,
      width: e.width,
      height: e.height,
      data: bytesToBase64(e.gray),
    });
  }
  return out;
}

/** Register an embedded image (from a loaded .rcam file) into the registry. Sync. */
export function registerEmbeddedImage(img: EmbeddedImage): void {
  if (IMAGES.has(img.id)) return;
  const gray = base64ToBytes(img.data);
  if (gray.length < img.width * img.height) {
    console.warn(`[images] embedded image "${img.name}" (${img.id}) has too few bytes — skipped.`);
    return;
  }
  IMAGES.set(img.id, { id: img.id, name: img.name, width: img.width, height: img.height, gray });
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK)
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
