/**
 * Central canvas palette. The values below are compile-time defaults; at runtime
 * `syncColorsFromTheme()` overwrites the entries that mirror a CSS custom property
 * with the resolved token value, making the CSS theme the single source of truth
 * (see themeTokens.ts). The literals here double as safe fallbacks for non-browser
 * contexts (unit tests, headless render) where CSS vars can't be read.
 */
import { readToken } from "./themeTokens";

export const COLORS = {
  background: "#1e1f24",
  gridMinor: "#2a2c33",
  gridMajor: "#363942",
  axisX: "#7a4a4a", // reddish for X=0
  axisY: "#4a7a55", // greenish for Y=0
  gridLabel: "#8b909c",

  workArea: "#202832",
  workAreaBorder: "#4a6075",
  // The material blank when it's positioned inside a larger work area (doc.stockRect):
  // a lighter fill + brighter border so the stock reads as distinct from the work area.
  stock: "#2c3644",
  stockBorder: "#6f8fb0",
  // Geometry on a fixture (workholding) layer — a hazard amber, drawn dashed, so a
  // clamp reads as a keep-out and never as a cut path.
  fixture: "#d98634",

  entity: "#cdd2da",
  entityConstruction: "#8b909c",
  entityHover: "#ffffff",
  entitySelected: "#f97316",
  entityConflict: "#e05a5a",
  entityPatternStale: "#c8982a",

  preview: "#4aa3ff",
  previewPoint: "#ffd24a",

  snapMarker: "#ffd24a",
  selectionRect: "rgba(74,163,255,0.12)",
  selectionRectBorder: "#4aa3ff",

  selectedPoint: "#f97316",
  selectedPointRing: "#ffffff",

  constraintBadgeBg: "#3a3320",
  constraintBadgeBorder: "#caa24a",
  constraintGlyph: "#ffd98a",

  dimension: "#4ccdc9",
  dimensionText: "#d6f7f5",
  dimensionTextRef: "#9fb6b5",

  toolpathHighlight: "#f59e42",
  regionFill: "rgba(245,158,66,0.22)",
  regionFillHover: "rgba(245,158,66,0.42)",

  // Flat laser toolpath preview (cut paths drawn over the 2D canvas).
  laserCut: "#ff4d4d",
  laserCutGlow: "rgba(255,77,77,0.35)",
};

/**
 * Canvas-palette keys that are exact duplicates of a CSS custom property.
 * These are kept in sync from the CSS theme at runtime; the defaults above must
 * equal the token's value so behavior is identical before the first sync.
 */
export const TOKEN_MIRRORS: Partial<Record<keyof typeof COLORS, string>> = {
  background: "--bg",
  gridLabel: "--text-dim",
  entityConstruction: "--text-dim",
  preview: "--accent",
  selectionRectBorder: "--accent",
  toolpathHighlight: "--tp-color",
};

/**
 * Copy resolved CSS token values into COLORS. Call once after the stylesheet is
 * applied (app boot). No-op for tokens that don't resolve (keeps the default).
 */
export function syncColorsFromTheme(): void {
  const palette = COLORS as Record<string, string>;
  for (const [key, cssVar] of Object.entries(TOKEN_MIRRORS)) {
    const v = readToken(cssVar);
    if (v) palette[key] = v;
  }
}
