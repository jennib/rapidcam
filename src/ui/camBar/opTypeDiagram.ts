/**
 * A small cross-section per toolpath type, shown beside the type's caption in
 * the Add-Toolpath dialog.
 *
 * Same bargain as {@link ../toolDiagram}: the drawing is schematic, and the one
 * thing it is faithful about is whatever distinguishes this toolpath from its
 * neighbours. A profile and a pocket differ in *what is left standing*; a
 * V-carve and an engrave in the *shape of the groove*; relief roughing and its
 * finish pass in *whether the surface is stepped*. Those are what these draw.
 * Nothing is to scale, and no diagram implies a depth, a stepover or a tool size
 * the generator would actually choose.
 *
 * Blue is material the toolpath REMOVES, so "what does this cut" is one glance
 * rather than a sentence. Colour comes from CSS variables with literal
 * fallbacks, so the strip reads in both themes and in a happy-dom test with no
 * stylesheet attached.
 */

import type { OpCombo } from "../camBarHelpers";

const SVGNS = "http://www.w3.org/2000/svg";
const W = 120;
const H = 64;

/** Material that survives the cut. */
const STOCK =
  "fill:var(--panel-2,#33373d);stroke:var(--text,#c8ccd2);stroke-width:1.25;stroke-linejoin:round";
/** Material the toolpath removes. */
const CUT =
  "fill:var(--accent,#2d6cdf);fill-opacity:0.32;stroke:var(--accent,#5a9bff);stroke-width:1.1;stroke-linejoin:round";
/** The tool, where showing it is the point (drill, chamfer). */
const TOOL = "fill:none;stroke:var(--accent,#5a9bff);stroke-width:1.4;stroke-linecap:round";
/** Dashed: something referred to but not cut by THIS op. */
const HINT =
  "fill:none;stroke:var(--text,#c8ccd2);stroke-width:1;stroke-dasharray:3 3;opacity:0.55";

type Attrs = Record<string, string | number>;
function node<K extends keyof SVGElementTagNameMap>(
  name: K,
  attrs: Attrs = {},
  style = "",
): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVGNS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (style) e.setAttribute("style", style);
  return e;
}

/** The blank in section — the baseline every diagram is drawn against. */
function slab(svg: SVGSVGElement): void {
  svg.appendChild(node("rect", { x: 8, y: 24, width: W - 16, height: 30, rx: 1 }, STOCK));
}

const DRAW: Record<OpCombo, (svg: SVGSVGElement) => void> = {
  // A trench OUTSIDE the part: the shape survives at full size, waste either side.
  "profile-outside": (svg) => {
    slab(svg);
    svg.appendChild(node("rect", { x: 8, y: 24, width: 18, height: 30 }, CUT));
    svg.appendChild(node("rect", { x: W - 26, y: 24, width: 18, height: 30 }, CUT));
    svg.appendChild(node("path", { d: `M26 22 v-8 M${W - 26} 22 v-8 M26 18 H${W - 26}` }, HINT));
  },
  // The mirror image: the trench is inside the line, so the HOLE keeps its size.
  "profile-inside": (svg) => {
    slab(svg);
    svg.appendChild(node("rect", { x: 44, y: 24, width: 32, height: 30 }, CUT));
    svg.appendChild(node("path", { d: "M44 22 v-8 M76 22 v-8 M44 18 H76" }, HINT));
  },
  // Everything between the walls is gone, to a flat floor — not just a trench.
  pocket: (svg) => {
    slab(svg);
    svg.appendChild(node("rect", { x: 24, y: 24, width: W - 48, height: 20 }, CUT));
  },
  // A bevel taken off the top corners by a slanted tool.
  chamfer: (svg) => {
    slab(svg);
    svg.appendChild(node("path", { d: "M8 24 h16 L8 38 z" }, CUT));
    svg.appendChild(node("path", { d: `M${W - 8} 24 h-16 L${W - 8} 38 z` }, CUT));
    svg.appendChild(node("path", { d: "M52 6 L60 22 L68 6" }, TOOL));
  },
  // A V groove WIDE where the shape is wide, coming to a point where it narrows
  // — the property that separates a v-carve from an engrave.
  vcarve: (svg) => {
    slab(svg);
    svg.appendChild(node("path", { d: "M22 24 L38 50 L54 24 z" }, CUT));
    svg.appendChild(node("path", { d: "M66 24 L75 38 L84 24 z" }, CUT));
    svg.appendChild(node("path", { d: "M94 24 L99 31 L104 24 z" }, CUT));
  },
  // One groove of constant depth, following a line.
  engrave: (svg) => {
    slab(svg);
    svg.appendChild(node("rect", { x: 20, y: 24, width: W - 40, height: 7, rx: 1 }, CUT));
  },
  // The same staircase as relief roughing: the job clears the steps, and the
  // dashed line is the smooth surface the finish pass then cuts.
  relief: (svg) => {
    slab(svg);
    for (const [x, d] of [
      [16, 8],
      [40, 15],
      [64, 21],
      [88, 13],
    ] as const)
      svg.appendChild(node("rect", { x, y: 24, width: 16, height: d }, CUT));
    svg.appendChild(node("path", { d: "M16 30 Q 46 54 70 45 T 104 33" }, HINT));
  },
  // Holes straight down, and the tool over one of them.
  drill: (svg) => {
    slab(svg);
    for (const x of [28, 56, 84])
      svg.appendChild(node("rect", { x: x - 5, y: 24, width: 10, height: 24, rx: 1 }, CUT));
    svg.appendChild(node("path", { d: "M56 6 v12 M52 12 l4 6 M60 12 l-4 6" }, TOOL));
  },
  // A thin skim off the whole top face — full width, unlike every other type.
  face: (svg) => {
    slab(svg);
    svg.appendChild(node("rect", { x: 8, y: 24, width: W - 16, height: 7 }, CUT));
    svg.appendChild(node("path", { d: "M14 16 H106" }, HINT));
  },
  // A shallow line that does NOT go through — the fold-line case.
  score: (svg) => {
    slab(svg);
    svg.appendChild(node("path", { d: "M60 24 L55 35 L65 35 z" }, CUT));
    svg.appendChild(node("path", { d: "M60 6 v12" }, TOOL));
  },
};

/**
 * Build the diagram for `combo`. The caller sets the display size; this only
 * fixes the aspect ratio.
 */
export function opTypeDiagram(combo: OpCombo): SVGSVGElement {
  const svg = node("svg", {
    viewBox: `0 0 ${W} ${H}`,
    width: "100%",
    height: "100%",
    role: "presentation",
    focusable: "false",
  });
  svg.style.display = "block";
  DRAW[combo](svg);
  return svg;
}
