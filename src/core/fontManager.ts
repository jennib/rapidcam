/**
 * Font manager: loads opentype.js fonts and provides a registry keyed by id.
 * Bundled fonts are loaded from /fonts/*.woff at startup (WOFF v1; WOFF2
 * requires a separate Brotli decoder not included here).
 * Users can also load any TTF/OTF/WOFF from a local file picker.
 */

import * as opentype from "opentype.js";
import type { Font } from "opentype.js";

export { Font };

export interface FontEntry {
  id: string;
  name: string;
  font: Font;
}

const FONTS = new Map<string, FontEntry>();

export const BUNDLED: { id: string; name: string; url: string }[] = [
  { id: "roboto-regular", name: "Roboto Regular", url: "/fonts/roboto-regular.woff" },
  { id: "roboto-bold",    name: "Roboto Bold",    url: "/fonts/roboto-bold.woff"    },
];

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

export async function loadFromUrl(id: string, name: string, url: string): Promise<void> {
  if (FONTS.has(id)) return;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Font fetch failed: ${url} (${res.status})`);
  const buf = await res.arrayBuffer();
  const font = await parseFont(buf);
  FONTS.set(id, { id, name, font });
}

export async function loadFromFile(file: File): Promise<{ id: string; name: string }> {
  const buf = await file.arrayBuffer();
  const font = await parseFont(buf);
  const id = `file-${Date.now()}`;
  const nameStr =
    (font.names.fullName as Record<string, string> | undefined)?.en ??
    file.name.replace(/\.[^.]+$/, "");
  FONTS.set(id, { id, name: nameStr, font });
  return { id, name: nameStr };
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
