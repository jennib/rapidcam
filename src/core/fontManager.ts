/**
 * Font manager: loads opentype.js fonts and provides a registry keyed by id.
 * Bundled fonts are loaded from /fonts/*.woff at startup (WOFF v1; WOFF2
 * requires a separate Brotli decoder not included here).
 * Users can also load any TTF/OTF/WOFF from a local file picker.
 */

import * as opentype from "opentype.js";
import type { Font } from "opentype.js";

export { Font };

export type FontFormat = "ttf" | "otf" | "woff";

export interface FontEntry {
  id: string;
  name: string;
  font: Font;
  /** Raw font bytes, kept so the font can be embedded in a .rcam file. */
  data: ArrayBuffer;
  format: FontFormat;
  /** True for fonts shipped with the app (resolvable by id, never embedded). */
  bundled: boolean;
  /** Whether the font's license (OS/2 fsType) permits embedding it in a file. */
  embeddable: boolean;
}

const FONTS = new Map<string, FontEntry>();

export const BUNDLED: { id: string; name: string; url: string }[] = [
  { id: "roboto-regular", name: "Roboto Regular", url: "/fonts/roboto-regular.woff" },
  { id: "roboto-bold",    name: "Roboto Bold",    url: "/fonts/roboto-bold.woff"    },
];

const BUNDLED_IDS = new Set(BUNDLED.map(b => b.id));

/** Whether a font id refers to a bundled (always-available) font. */
export function isBundledFont(id: string): boolean {
  return BUNDLED_IDS.has(id);
}

/**
 * Whether a fontId can be resolved to glyphs: it's registered, or it's a bundled
 * font that ships with the app. Bundled ids count as resolvable even before their
 * async startup load finishes, so freshly loaded documents don't raise spurious
 * "missing font" warnings. A genuinely absent font (unembedded + non-bundled)
 * returns false — its text will render as a placeholder and produce no toolpath.
 */
export function isFontResolvable(id: string): boolean {
  return BUNDLED_IDS.has(id) || FONTS.has(id);
}

export function getFont(id: string): Font | null {
  return FONTS.get(id)?.font ?? null;
}

export function listFonts(): { id: string; name: string }[] {
  return [...FONTS.values()].map(e => ({ id: e.id, name: e.name }));
}

export function defaultFontId(): string {
  const first = FONTS.keys().next();
  return first.done ? "" : first.value;
}

async function parseFont(buf: ArrayBuffer): Promise<Font> {
  return opentype.parse(buf);
}

/** Detect the container format from the font's first bytes (magic number). */
function detectFormat(buf: ArrayBuffer): FontFormat {
  const tag = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
  // "wOFF"
  if (tag[0] === 0x77 && tag[1] === 0x4f && tag[2] === 0x46 && tag[3] === 0x46) return "woff";
  // "OTTO" = CFF/OpenType outlines
  if (tag[0] === 0x4f && tag[1] === 0x54 && tag[2] === 0x54 && tag[3] === 0x4f) return "otf";
  return "ttf";
}

/**
 * Whether an OS/2 `fsType` value permits embedding the font in a document.
 * Bit 1 (0x0002) is "Restricted License embedding" — the font must not be
 * embedded. The other levels (installable=0, preview&print=0x0004,
 * editable=0x0008) all permit it. A missing fsType (no OS/2 table) states no
 * restriction, so it's treated as embeddable. Exported for testing.
 */
export function fsTypeAllowsEmbedding(fsType: number | null | undefined): boolean {
  if (fsType == null) return true;
  return (fsType & 0x0002) === 0;
}

/** Read a parsed font's embedding permission from its OS/2 table. */
function fontEmbeddable(font: Font): boolean {
  const os2 = (font.tables as { os2?: { fsType?: number } } | undefined)?.os2;
  return fsTypeAllowsEmbedding(os2?.fsType);
}

/** Whether a loaded font's license permits embedding it into a .rcam file. */
export function isFontEmbeddable(id: string): boolean {
  return FONTS.get(id)?.embeddable ?? false;
}

/** FNV-1a 32-bit hash of the bytes, hex — stable content id for embedded fonts. */
function hashBytes(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export async function loadFromUrl(id: string, name: string, url: string): Promise<void> {
  if (FONTS.has(id)) return;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Font fetch failed: ${url} (${res.status})`);
  const buf = await res.arrayBuffer();
  const font = await parseFont(buf);
  FONTS.set(id, { id, name, font, data: buf, format: detectFormat(buf), bundled: BUNDLED_IDS.has(id), embeddable: fontEmbeddable(font) });
}

export async function loadFromFile(file: File): Promise<{ id: string; name: string; embeddable: boolean }> {
  const buf = await file.arrayBuffer();
  const font = await parseFont(buf);
  const nameStr =
    (font.names.fullName as Record<string, string> | undefined)?.en ??
    file.name.replace(/\.[^.]+$/, "");
  const embeddable = fontEmbeddable(font);
  // Content-addressed id: same font bytes always yield the same id, so a font
  // dedupes across sessions and round-trips stably through saved files.
  const id = `font-${hashBytes(buf)}`;
  if (!FONTS.has(id)) {
    FONTS.set(id, { id, name: nameStr, font, data: buf, format: detectFormat(buf), bundled: false, embeddable });
  }
  return { id, name: nameStr, embeddable };
}

/** An embedded font as it appears in a .rcam file. */
export interface EmbeddedFont {
  id: string;
  name: string;
  format: FontFormat;
  /** Base64-encoded font bytes. */
  data: string;
}

/** Collect the embeddable (non-bundled) fonts for the given ids, skipping any
 *  that aren't loaded, are bundled (resolve by id at runtime), or whose license
 *  forbids embedding (we must not redistribute those in a shared file). */
export function collectEmbeddedFonts(ids: Iterable<string>): EmbeddedFont[] {
  const out: EmbeddedFont[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const e = FONTS.get(id);
    if (!e || e.bundled) continue;
    if (!e.embeddable) {
      console.warn(`[fonts] not embedding "${e.name}" (${e.id}): its license (OS/2 fsType) forbids embedding.`);
      continue;
    }
    out.push({ id: e.id, name: e.name, format: e.format, data: bytesToBase64(e.data) });
  }
  return out;
}

/** Register an embedded font (from a loaded .rcam file) into the registry. */
export function registerEmbeddedFont(f: EmbeddedFont): void {
  if (FONTS.has(f.id)) return;
  const data = base64ToBytes(f.data);
  try {
    const font = opentype.parse(data);
    FONTS.set(f.id, { id: f.id, name: f.name, font, data, format: f.format, bundled: false, embeddable: fontEmbeddable(font) });
  } catch (e) {
    console.warn(`[fonts] Could not parse embedded font "${f.name}" (${f.id}):`, (e as Error).message);
  }
}

function bytesToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CHUNK = 0x8000; // avoid call-stack limits on large fonts
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function base64ToBytes(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

export async function initBundledFonts(onReady?: () => void): Promise<void> {
  await Promise.all(BUNDLED.map(async f => {
    try {
      await loadFromUrl(f.id, f.name, f.url);
      onReady?.();
    } catch (e) {
      console.info(`[fonts] Could not load ${f.name}:`, (e as Error).message);
    }
  }));
}
