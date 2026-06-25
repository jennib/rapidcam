/** Central canvas palette so renderer styling stays consistent with the CSS theme. */

export const COLORS = {
  background: "#1e1f24",
  gridMinor: "#2a2c33",
  gridMajor: "#363942",
  axisX: "#7a4a4a", // reddish for X=0
  axisY: "#4a7a55", // greenish for Y=0
  gridLabel: "#8b909c",

  workArea: "#202832",
  workAreaBorder: "#4a6075",

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
} as const;
