/**
 * A small, labelled cross-section diagram of a cutting tool, for the tool
 * library editor — so the dimension fields (especially a V-bit's `diameter` vs
 * `tipDiameter` vs `vAngle`) are unambiguous.
 *
 * Honest about what it shows: the ANGLE is drawn faithfully (a 30° V-bit looks
 * visibly steeper than a 90° one — a fat-fingered `vAngle` of 6 instead of 60
 * draws an obviously-wrong needle), which is the part that catches input errors.
 * DIAMETERS are labelled with their real values but NOT drawn to scale — a
 * 0.5mm tip flat on a 25mm bit would otherwise be a single invisible pixel.
 */
import type { ToolDef } from "../cam/types";

const SVGNS = "http://www.w3.org/2000/svg";
const VB_W = 240;
const VB_H = 200;
const CX = VB_W / 2;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const deg2rad = (d: number) => (d * Math.PI) / 180;

const OUTLINE = "fill:var(--panel-2,#2a2a2a);stroke:var(--text,#ddd);stroke-width:1.5;stroke-linejoin:round;stroke-linecap:round";
const DIM = "stroke:var(--accent,#2d6cdf);stroke-width:1;fill:none";
const LBL = "fill:var(--text,#ddd);font:600 11px var(--mono,monospace)";
const LBL_A = "fill:var(--accent,#5a9bff);font:600 11px var(--mono,monospace)";

type Attrs = Record<string, string | number>;
function node<K extends keyof SVGElementTagNameMap>(name: K, attrs: Attrs = {}, style = ""): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVGNS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (style) e.setAttribute("style", style);
  return e;
}

function label(parent: SVGElement, x: number, y: number, str: string, anchor: "start" | "middle" | "end" = "middle", style = LBL): void {
  const t = node("text", { x, y, "text-anchor": anchor, "dominant-baseline": "middle" }, style);
  t.textContent = str;
  parent.appendChild(t);
}

/** Horizontal dimension line with end ticks and a centred label above it. */
function dimH(parent: SVGElement, x1: number, x2: number, y: number, str: string): void {
  parent.appendChild(node("line", { x1, y1: y, x2, y2: y }, DIM));
  parent.appendChild(node("line", { x1, y1: y - 4, x2: x1, y2: y + 4 }, DIM));
  parent.appendChild(node("line", { x1: x2, y1: y - 4, x2, y2: y + 4 }, DIM));
  label(parent, (x1 + x2) / 2, y - 9, str, "middle", LBL_A);
}

function drawVBit(svg: SVGElement, t: ToolDef): void {
  const vAngle = clamp(t.vAngle ?? 60, 2, 178);
  const half = deg2rad(vAngle / 2);
  const topY = 58;
  const depth = 96;
  // Angle-faithful: width follows the angle (narrow angle → deep narrow V).
  const halfW = clamp(depth * Math.tan(half), 7, 86);
  const apexY = topY + depth;
  const lx = CX - halfW, rx = CX + halfW;

  // Tip flat: exaggerated (real values are sub-mm) but only present when > 0.
  const tipMM = t.tipDiameter ?? 0;
  const tipHalf = tipMM > 0 ? clamp(tipMM * 10, 2, halfW * 0.7) : 0;
  const ltx = CX - tipHalf, rtx = CX + tipHalf;

  // Shank above the flutes.
  const shankHalf = Math.min(halfW, 20);
  svg.appendChild(node("rect", { x: CX - shankHalf, y: 22, width: shankHalf * 2, height: topY - 22 }, OUTLINE));

  // Flute body: flank → tip flat → flank.
  const d = `M ${lx} ${topY} L ${ltx} ${apexY} L ${rtx} ${apexY} L ${rx} ${topY} Z`;
  svg.appendChild(node("path", { d }, OUTLINE));

  // Cutting-diameter dimension across the top of the flutes.
  dimH(svg, lx, rx, topY - 12, `⌀ ${t.diameter} mm`);

  // Included-angle arc + label near the apex.
  const r = 30;
  const ax1 = CX - r * Math.sin(half), ay1 = apexY - r * Math.cos(half);
  const ax2 = CX + r * Math.sin(half), ay2 = apexY - r * Math.cos(half);
  svg.appendChild(node("path", { d: `M ${ax1} ${ay1} A ${r} ${r} 0 0 1 ${ax2} ${ay2}` }, DIM));
  label(svg, CX, apexY - r - 9, `${vAngle}°`, "middle", LBL_A);

  // Tip annotation.
  if (tipMM > 0) {
    svg.appendChild(node("line", { x1: rtx, y1: apexY, x2: rtx + 26, y2: apexY + 10 }, DIM));
    label(svg, rtx + 29, apexY + 11, `tip ⌀ ${tipMM}`, "start", LBL);
  } else {
    label(svg, CX, apexY + 14, "(sharp tip)", "middle", LBL);
  }
}

function drawEndMill(svg: SVGElement, t: ToolDef): void {
  const topY = 50, bottomY = 150, halfW = 42;
  const shankHalf = Math.min(halfW, 24);
  svg.appendChild(node("rect", { x: CX - shankHalf, y: 22, width: shankHalf * 2, height: topY - 22 }, OUTLINE));
  svg.appendChild(node("rect", { x: CX - halfW, y: topY, width: halfW * 2, height: bottomY - topY }, OUTLINE));
  dimH(svg, CX - halfW, CX + halfW, topY - 12, `⌀ ${t.diameter} mm`);
  label(svg, CX, bottomY + 14, "flat bottom", "middle", LBL);
}

function drawBallNose(svg: SVGElement, t: ToolDef): void {
  const topY = 46, bodyBottom = 118, halfW = 42;
  const shankHalf = Math.min(halfW, 24);
  svg.appendChild(node("rect", { x: CX - shankHalf, y: 22, width: shankHalf * 2, height: topY - 22 }, OUTLINE));
  // Body with a semicircular tip (radius = halfW).
  const d = `M ${CX - halfW} ${topY} L ${CX - halfW} ${bodyBottom} A ${halfW} ${halfW} 0 0 0 ${CX + halfW} ${bodyBottom} L ${CX + halfW} ${topY} Z`;
  svg.appendChild(node("path", { d }, OUTLINE));
  dimH(svg, CX - halfW, CX + halfW, topY - 12, `⌀ ${t.diameter} mm`);
  label(svg, CX, bodyBottom + halfW + 12, `r = ${(t.diameter / 2)} (⌀/2)`, "middle", LBL);
}

function drawDrill(svg: SVGElement, t: ToolDef): void {
  const topY = 44, bodyBottom = 120, halfW = 38;
  const tipAngle = clamp(t.tipAngle ?? 118, 30, 178);
  const half = deg2rad(tipAngle / 2);
  // Point depth follows the tip angle (converges from the body width to a point).
  const pointDepth = clamp(halfW / Math.tan(half), 8, 70);
  const apexY = bodyBottom + pointDepth;
  const shankHalf = Math.min(halfW, 22);
  svg.appendChild(node("rect", { x: CX - shankHalf, y: 20, width: shankHalf * 2, height: topY - 20 }, OUTLINE));
  const d = `M ${CX - halfW} ${topY} L ${CX - halfW} ${bodyBottom} L ${CX} ${apexY} L ${CX + halfW} ${bodyBottom} L ${CX + halfW} ${topY} Z`;
  svg.appendChild(node("path", { d }, OUTLINE));
  dimH(svg, CX - halfW, CX + halfW, topY - 12, `⌀ ${t.diameter} mm`);
  label(svg, CX, apexY - pointDepth / 2, `${tipAngle}°`, "middle", LBL_A);
  label(svg, CX, apexY + 13, "point", "middle", LBL);
}

/** Build a fresh diagram SVG for the given tool. */
export function buildToolDiagram(t: ToolDef): SVGSVGElement {
  const svg = node("svg", { viewBox: `0 0 ${VB_W} ${VB_H}`, width: "100%", height: "168", preserveAspectRatio: "xMidYMid meet" });
  switch (t.toolType) {
    case "v-bit": drawVBit(svg, t); break;
    case "ball-nose": drawBallNose(svg, t); break;
    case "drill": drawDrill(svg, t); break;
    default: drawEndMill(svg, t); break;
  }
  return svg;
}
