/**
 * Render a small, self-contained SVG preview of a .rcam document's geometry —
 * used to turn the welcome-screen example/recent list into a visual gallery.
 *
 * Works directly off the serialized `RcamFile` (plain JSON), so it needs no
 * CADDocument, no constraint solve, and no font loading. Geometry is flipped to
 * Y-down (matching SVG) and the viewBox is fit to the geometry's bounding box —
 * not the stock canvas — so even a small part fills the thumbnail. Stroke width
 * scales with the viewBox so lines stay visible at any part size, and the SVG
 * inherits `currentColor` so the caller controls (and can hover-animate) colour.
 */

import type { RcamFile } from "../io/fileio";

const TAU = Math.PI * 2;

interface Pt { x: number; y: number; }

const n = (v: number): string => parseFloat(v.toFixed(3)).toString();
const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** SVG path for an arc (Y already flipped via `fy`); mirrors svgExport's sweep. */
function arcPath(cx: number, cy: number, r: number, sa: number, ea: number, fy: (y: number) => number): string {
  const span = ((ea - sa) % TAU + TAU) % TAU;
  const sx = cx + r * Math.cos(sa), sy = fy(cy + r * Math.sin(sa));
  const ex = cx + r * Math.cos(ea), ey = fy(cy + r * Math.sin(ea));
  const largeArc = span > Math.PI ? 1 : 0;
  return `M ${n(sx)} ${n(sy)} A ${n(r)} ${n(r)} 0 ${largeArc} 0 ${n(ex)} ${n(ey)}`;
}

/**
 * Build an inline SVG string previewing the document's geometry, or null when
 * there's nothing drawable (empty doc / only construction geometry).
 */
export function renderThumbnailSvg(file: RcamFile): string | null {
  const H = file.canvas?.height ?? 0;
  const fy = (y: number): number => H - y;

  const prims: string[] = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const acc = (x: number, y: number): void => {
    if (x < minX) minX = x; if (y < minY) minY = y;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y;
  };

  for (const e of (file.entities ?? []) as Record<string, unknown>[]) {
    if (!e || e.isConstruction) continue;
    switch (e.type) {
      case "line": {
        const a = e.a as Pt, b = e.b as Pt;
        if (!a || !b) break;
        acc(a.x, fy(a.y)); acc(b.x, fy(b.y));
        prims.push(`<line x1="${n(a.x)}" y1="${n(fy(a.y))}" x2="${n(b.x)}" y2="${n(fy(b.y))}"/>`);
        break;
      }
      case "circle": {
        const c = e.center as Pt, r = e.radius as number;
        if (!c || !(r > 0)) break;
        acc(c.x - r, fy(c.y) - r); acc(c.x + r, fy(c.y) + r);
        prims.push(`<circle cx="${n(c.x)}" cy="${n(fy(c.y))}" r="${n(r)}"/>`);
        break;
      }
      case "rectangle": {
        const p0 = e.p0 as Pt, p1 = e.p1 as Pt;
        if (!p0 || !p1) break;
        const x = Math.min(p0.x, p1.x), top = Math.max(p0.y, p1.y);
        const w = Math.abs(p1.x - p0.x), h = Math.abs(p1.y - p0.y);
        acc(x, fy(top)); acc(x + w, fy(top) + h);
        prims.push(`<rect x="${n(x)}" y="${n(fy(top))}" width="${n(w)}" height="${n(h)}"/>`);
        break;
      }
      case "polyline": {
        const pts = (e.points ?? []) as Pt[];
        if (pts.length < 2) break;
        for (const p of pts) acc(p.x, fy(p.y));
        const ps = pts.map((p) => `${n(p.x)},${n(fy(p.y))}`).join(" ");
        prims.push(e.closed ? `<polygon points="${ps}"/>` : `<polyline points="${ps}"/>`);
        break;
      }
      case "arc": {
        const c = e.center as Pt, r = e.radius as number;
        if (!c || !(r > 0)) break;
        const sa = (e.startAngle as number) ?? 0, ea = (e.endAngle as number) ?? 0;
        const span = ((ea - sa) % TAU + TAU) % TAU;
        for (let i = 0; i <= 16; i++) {
          const t = sa + span * (i / 16);
          acc(c.x + r * Math.cos(t), fy(c.y + r * Math.sin(t)));
        }
        prims.push(`<path d="${arcPath(c.x, c.y, r, sa, ea, fy)}"/>`);
        break;
      }
      case "bezier": {
        const p0 = e.p0 as Pt, p1 = e.p1 as Pt, p2 = e.p2 as Pt, p3 = e.p3 as Pt;
        if (!p0 || !p1 || !p2 || !p3) break;
        for (const p of [p0, p1, p2, p3]) acc(p.x, fy(p.y));
        prims.push(`<path d="M ${n(p0.x)} ${n(fy(p0.y))} C ${n(p1.x)} ${n(fy(p1.y))} ${n(p2.x)} ${n(fy(p2.y))} ${n(p3.x)} ${n(fy(p3.y))}"/>`);
        break;
      }
      case "text": {
        const pos = e.position as Pt;
        if (!pos) break;
        const size = (e.sizeMM as number) ?? 5;
        const txt = String(e.text ?? "");
        // Approximate text extent (no font metrics here) so it factors into bounds.
        const w = Math.max(1, txt.length * size * 0.6);
        acc(pos.x, fy(pos.y)); acc(pos.x + w, fy(pos.y) - size);
        const deg = n(-((e.angle as number) ?? 0) * 180 / Math.PI);
        const tf = deg !== "0" ? ` transform="rotate(${deg} ${n(pos.x)} ${n(fy(pos.y))})"` : "";
        prims.push(`<text x="${n(pos.x)}" y="${n(fy(pos.y))}" font-size="${n(size)}" fill="currentColor" stroke="none" font-family="sans-serif"${tf}>${esc(txt)}</text>`);
        break;
      }
    }
  }

  if (prims.length === 0 || !isFinite(minX)) return null;

  const bw = Math.max(maxX - minX, 0.001), bh = Math.max(maxY - minY, 0.001);
  const pad = Math.max(bw, bh) * 0.08 + 0.5;
  const vx = minX - pad, vy = minY - pad, vw = bw + pad * 2, vh = bh + pad * 2;
  // Stroke scales with the part so thin lines stay visible whatever the size.
  const strokeW = Math.max(vw, vh) * 0.012;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${n(vx)} ${n(vy)} ${n(vw)} ${n(vh)}" ` +
    `preserveAspectRatio="xMidYMid meet" fill="none" stroke="currentColor" ` +
    `stroke-width="${n(strokeW)}" stroke-linecap="round" stroke-linejoin="round">` +
    prims.join("") +
    `</svg>`
  );
}
