/**
 * SVG import — parses an SVG string and returns entities for the document.
 *
 * Coordinate system:
 *   SVG uses Y-down. The document uses Y-up mm.
 *   Scale and flip: x_cam = x_svg * scaleX, y_cam = H_mm − y_svg * scaleY.
 *   Relative SVG deltas flip Y sign: dy_cam = −dy_svg * scaleY.
 *
 * Supported elements: <path>, <line>, <rect>, <circle>, <polyline>, <polygon>
 * <g> is recursed into; a transform= attribute emits a warning (ignored).
 * <ellipse> emits a warning and is skipped.
 *
 * Supported path commands: M/m, L/l, H/h, V/v, C/c, S/s, Q/q, T/t, Z/z
 * A/a (arc): current position is updated but the segment is skipped (warning).
 */

import type { Vec2 } from "../core/vec2";
import {
  type Entity,
  ArcEntity,
  LineEntity,
  PolylineEntity,
  BezierEntity,
  CircleEntity,
  RectEntity,
} from "../model/entities";

// ---------------------------------------------------------------------------
// Unit / scale helpers
// ---------------------------------------------------------------------------

function unitToMm(value: number, unit: string): number {
  switch (unit.toLowerCase()) {
    case "mm":
      return value;
    case "cm":
      return value * 10;
    case "in":
      return value * 25.4;
    case "pt":
      return value * (25.4 / 72);
    case "pc":
      return value * (25.4 / 6);
    default:
      return value * (25.4 / 96); // unitless = px at 96 dpi
  }
}

function parseDim(s: string): { value: number; unit: string } | null {
  const m = s.trim().match(/^([0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?)\s*(mm|cm|in|px|pt|pc)?$/i);
  if (!m) return null;
  return { value: parseFloat(m[1]), unit: (m[2] ?? "").toLowerCase() };
}

interface SvgScale {
  scaleX: number; // SVG user units → mm
  scaleY: number;
  H: number; // physical document height in mm (used for Y-flip)
}

function computeScale(svgEl: Element): SvgScale {
  const vbAttr = svgEl.getAttribute("viewBox") ?? "";
  const vbParts = vbAttr
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const hasVb = vbParts.length >= 4 && vbParts.every(Number.isFinite);
  const vbW = hasVb ? vbParts[2] : null;
  const vbH = hasVb ? vbParts[3] : null;

  const wDim = parseDim(svgEl.getAttribute("width") ?? "");
  const hDim = parseDim(svgEl.getAttribute("height") ?? "");
  const wMm = wDim ? unitToMm(wDim.value, wDim.unit) : null;
  const hMm = hDim ? unitToMm(hDim.value, hDim.unit) : null;

  // Derive scale from (physical_mm / viewBox_dimension).
  // If either is missing, fall back to 1 unit = 1 mm and warn.
  let scaleX = 1,
    scaleY = 1;
  if (wMm !== null && vbW) {
    scaleX = wMm / vbW;
  } else if (wMm !== null) {
    scaleX = 1; // no viewBox — treat vbW = wMm
  } else {
    console.warn("[svgImport] No width/viewBox found — assuming 1 SVG unit = 1 mm");
  }

  if (hMm !== null && vbH) {
    scaleY = hMm / vbH;
  } else {
    scaleY = scaleX; // assume square pixels
  }

  const H = hMm ?? (vbH ? vbH * scaleY : 100);
  return { scaleX, scaleY, H };
}

// ---------------------------------------------------------------------------
// Coordinate transforms
// ---------------------------------------------------------------------------

function absXY(x: number, y: number, sc: SvgScale): Vec2 {
  return { x: x * sc.scaleX, y: sc.H - y * sc.scaleY };
}

/** World (Y-up mm) → SVG user units (Y-down); the inverse of {@link absXY}. */
function toSvgXY(p: Vec2, sc: SvgScale): Vec2 {
  return { x: p.x / (sc.scaleX || 1), y: (sc.H - p.y) / (sc.scaleY || 1) };
}

/**
 * One SVG elliptical-arc segment, in world coordinates.
 *
 * A true circle becomes an ArcEntity; anything this model cannot hold — an
 * ellipse, or a circle squashed by a non-uniform viewBox — comes back as points
 * for the caller to fold into its polyline run. Returning null means the
 * segment is degenerate and the spec calls for a straight line.
 *
 * The maths is SVG 1.1 appendix F.6.5 (endpoint → centre parameterisation),
 * done in SVG space and then mapped out, because that is the space rx/ry and
 * the rotation are expressed in. The Y-flip on the way out reverses the sweep,
 * which is why the sign work below is worth doing rather than eyeballing.
 */
function svgArcToWorld(
  fromWorld: Vec2,
  toWorld: Vec2,
  rxIn: number,
  ryIn: number,
  xRotDeg: number,
  largeArc: boolean,
  sweep: boolean,
  sc: SvgScale,
):
  | { kind: "arc"; center: Vec2; radius: number; startAngle: number; endAngle: number }
  | { kind: "points"; points: Vec2[] }
  | null {
  const p1 = toSvgXY(fromWorld, sc);
  const p2 = toSvgXY(toWorld, sc);
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx < 1e-12 || ry < 1e-12) return null;
  if (Math.hypot(p2.x - p1.x, p2.y - p1.y) < 1e-12) return null;

  const phi = ((xRotDeg % 360) * Math.PI) / 180;
  const cosP = Math.cos(phi);
  const sinP = Math.sin(phi);
  const dx = (p1.x - p2.x) / 2;
  const dy = (p1.y - p2.y) / 2;
  const x1p = cosP * dx + sinP * dy;
  const y1p = -sinP * dx + cosP * dy;

  // Radii too small to span the endpoints are scaled up, per the spec.
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }

  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const coef = (largeArc === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
  const cxp = (coef * (rx * y1p)) / ry;
  const cyp = (coef * -(ry * x1p)) / rx;
  const cx = cosP * cxp - sinP * cyp + (p1.x + p2.x) / 2;
  const cy = sinP * cxp + cosP * cyp + (p1.y + p2.y) / 2;

  const ang = (ux: number, uy: number, vx: number, vy: number): number => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    const a = Math.acos(Math.max(-1, Math.min(1, len === 0 ? 1 : dot / len)));
    return ux * vy - uy * vx < 0 ? -a : a;
  };
  const ux = (x1p - cxp) / rx;
  const uy = (y1p - cyp) / ry;
  const vx = (-x1p - cxp) / rx;
  const vy = (-y1p - cyp) / ry;
  const theta1 = ang(1, 0, ux, uy);
  let delta = ang(ux, uy, vx, vy) % (Math.PI * 2);
  if (!sweep && delta > 0) delta -= Math.PI * 2;
  if (sweep && delta < 0) delta += Math.PI * 2;

  const uniform = Math.abs(Math.abs(sc.scaleX) - Math.abs(sc.scaleY)) < 1e-9;
  const circular = Math.abs(rx - ry) < 1e-9 * Math.max(rx, ry, 1);
  if (uniform && circular) {
    // A circle in SVG space is a circle in world space. Flipping Y negates
    // every angle, so a clockwise SVG sweep is a counter-clockwise world one.
    const start = -theta1;
    const end = -(theta1 + delta); // = start + the world sweep, un-normalised
    // ArcEntity is stored CCW from start to end and is undirected as geometry,
    // so a clockwise world sweep is the same arc with its ends swapped. Because
    // `end` is `start` plus the signed sweep (never renormalised), min/max is
    // exactly that swap — and never silently selects the other arc.
    return {
      kind: "arc",
      center: absXY(cx, cy, sc),
      radius: rx * Math.abs(sc.scaleX),
      startAngle: Math.min(start, end),
      endAngle: Math.max(start, end),
    };
  }

  const steps = Math.max(8, Math.ceil((Math.abs(delta) / (Math.PI * 2)) * 64));
  const points: Vec2[] = [];
  for (let k = 1; k <= steps; k++) {
    const t = theta1 + (delta * k) / steps;
    const ct = Math.cos(t);
    const st = Math.sin(t);
    points.push(absXY(cx + rx * ct * cosP - ry * st * sinP, cy + rx * ct * sinP + ry * st * cosP, sc));
  }
  return { kind: "points", points };
}

// Apply an absolute SVG X onto a known CAM point (used for H command).
function absX(x: number, sc: SvgScale): number {
  return x * sc.scaleX;
}
// Apply an absolute SVG Y onto a known CAM point (used for V command).
function absY(y: number, sc: SvgScale): number {
  return sc.H - y * sc.scaleY;
}

// ---------------------------------------------------------------------------
// Path tokenizer
// ---------------------------------------------------------------------------

// Produces an array of command letters (strings) and numeric arguments.
// Handles "10-5" → [10, -5] and "1e3" scientific notation.
function tokenizePath(d: string): Array<string | number> {
  const re = /([MmZzLlHhVvCcSsQqTtAa])|([+-]?(?:[0-9]*\.)?[0-9]+(?:[eE][+-]?[0-9]+)?)/g;
  const out: Array<string | number> = [];
  let m = re.exec(d);
  while (m !== null) {
    out.push(m[1] !== undefined ? m[1] : parseFloat(m[2]));
    m = re.exec(d);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Path parser
// ---------------------------------------------------------------------------

export function parsePath(d: string, sc: SvgScale): Entity[] {
  const entities: Entity[] = [];
  const tokens = tokenizePath(d);
  let i = 0;

  // Sub-path state
  let cur: Vec2 = { x: 0, y: 0 }; // current pen (CAM coords)
  let subStart: Vec2 = { x: 0, y: 0 }; // last M position (for Z)
  let lastCubicCtrl: Vec2 | null = null; // last cubic p2 (for S)
  let lastQuadCtrl: Vec2 | null = null; // last quadratic q1 (for T)
  let polyPts: Vec2[] = []; // pending line points

  function flushPoly(closed: boolean): void {
    if (polyPts.length < 2) {
      polyPts = [];
      return;
    }
    if (polyPts.length === 2 && !closed) {
      entities.push(new LineEntity({ ...polyPts[0] }, { ...polyPts[1] }));
    } else {
      entities.push(new PolylineEntity([...polyPts], closed));
    }
    polyPts = [];
  }

  // Ensure polyline starts at cur if not already tracking points.
  function ensurePoly(): void {
    if (polyPts.length === 0) polyPts.push({ ...cur });
  }

  // Consume up to `count` numbers from token stream.
  function take(count: number): number[] {
    const out: number[] = [];
    while (out.length < count && i < tokens.length && typeof tokens[i] === "number") {
      out.push(tokens[i++] as number);
    }
    return out;
  }

  while (i < tokens.length) {
    if (typeof tokens[i] !== "string") {
      i++;
      continue;
    } // shouldn't happen; skip stray numbers

    const letter = tokens[i++] as string;
    const rel = letter !== letter.toUpperCase() && letter.toLowerCase() !== "z";
    const cmd = letter.toUpperCase();

    // After an M, implicit repetitions become L (SVG spec §9.3.3).
    let effectiveCmd = cmd;

    // Process one segment per iteration; repeat while next token is a number.
    do {
      switch (effectiveCmd) {
        case "M": {
          const ns = take(2);
          if (ns.length < 2) break;
          flushPoly(false);
          cur = rel
            ? { x: cur.x + ns[0] * sc.scaleX, y: cur.y - ns[1] * sc.scaleY }
            : absXY(ns[0], ns[1], sc);
          subStart = { ...cur };
          lastCubicCtrl = null;
          lastQuadCtrl = null;
          effectiveCmd = "L"; // subsequent pairs are implicit L
          break;
        }
        case "L": {
          const ns = take(2);
          if (ns.length < 2) break;
          ensurePoly();
          cur = rel
            ? { x: cur.x + ns[0] * sc.scaleX, y: cur.y - ns[1] * sc.scaleY }
            : absXY(ns[0], ns[1], sc);
          polyPts.push({ ...cur });
          lastCubicCtrl = null;
          lastQuadCtrl = null;
          break;
        }
        case "H": {
          const ns = take(1);
          if (ns.length < 1) break;
          ensurePoly();
          cur = { x: rel ? cur.x + ns[0] * sc.scaleX : absX(ns[0], sc), y: cur.y };
          polyPts.push({ ...cur });
          lastCubicCtrl = null;
          lastQuadCtrl = null;
          break;
        }
        case "V": {
          const ns = take(1);
          if (ns.length < 1) break;
          ensurePoly();
          cur = { x: cur.x, y: rel ? cur.y - ns[0] * sc.scaleY : absY(ns[0], sc) };
          polyPts.push({ ...cur });
          lastCubicCtrl = null;
          lastQuadCtrl = null;
          break;
        }
        case "C": {
          const ns = take(6);
          if (ns.length < 6) break;
          flushPoly(false);
          const p0 = { ...cur };
          const p1 = rel
            ? { x: cur.x + ns[0] * sc.scaleX, y: cur.y - ns[1] * sc.scaleY }
            : absXY(ns[0], ns[1], sc);
          const p2 = rel
            ? { x: cur.x + ns[2] * sc.scaleX, y: cur.y - ns[3] * sc.scaleY }
            : absXY(ns[2], ns[3], sc);
          const p3 = rel
            ? { x: cur.x + ns[4] * sc.scaleX, y: cur.y - ns[5] * sc.scaleY }
            : absXY(ns[4], ns[5], sc);
          entities.push(new BezierEntity(p0, p1, p2, p3));
          lastCubicCtrl = { ...p2 };
          lastQuadCtrl = null;
          cur = { ...p3 };
          break;
        }
        case "S": {
          const ns = take(4);
          if (ns.length < 4) break;
          flushPoly(false);
          const p0 = { ...cur };
          // Reflect the last cubic control point around cur, or use cur if none.
          const p1 = lastCubicCtrl
            ? { x: 2 * cur.x - lastCubicCtrl.x, y: 2 * cur.y - lastCubicCtrl.y }
            : { ...cur };
          const p2 = rel
            ? { x: cur.x + ns[0] * sc.scaleX, y: cur.y - ns[1] * sc.scaleY }
            : absXY(ns[0], ns[1], sc);
          const p3 = rel
            ? { x: cur.x + ns[2] * sc.scaleX, y: cur.y - ns[3] * sc.scaleY }
            : absXY(ns[2], ns[3], sc);
          entities.push(new BezierEntity(p0, p1, p2, p3));
          lastCubicCtrl = { ...p2 };
          lastQuadCtrl = null;
          cur = { ...p3 };
          break;
        }
        case "Q": {
          const ns = take(4);
          if (ns.length < 4) break;
          flushPoly(false);
          const p0 = { ...cur };
          const q1 = rel
            ? { x: cur.x + ns[0] * sc.scaleX, y: cur.y - ns[1] * sc.scaleY }
            : absXY(ns[0], ns[1], sc);
          const p3 = rel
            ? { x: cur.x + ns[2] * sc.scaleX, y: cur.y - ns[3] * sc.scaleY }
            : absXY(ns[2], ns[3], sc);
          // Degree elevation: Q(p0, q1, p3) → cubic C(p0, p1c, p2c, p3).
          const p1c = { x: p0.x + (2 / 3) * (q1.x - p0.x), y: p0.y + (2 / 3) * (q1.y - p0.y) };
          const p2c = { x: p3.x + (2 / 3) * (q1.x - p3.x), y: p3.y + (2 / 3) * (q1.y - p3.y) };
          entities.push(new BezierEntity(p0, p1c, p2c, p3));
          lastQuadCtrl = { ...q1 };
          lastCubicCtrl = null;
          cur = { ...p3 };
          break;
        }
        case "T": {
          // Smooth quadratic: reflect last quad ctrl point, then degree-elevate.
          const ns = take(2);
          if (ns.length < 2) break;
          flushPoly(false);
          const p0 = { ...cur };
          const q1: Vec2 = lastQuadCtrl
            ? { x: 2 * cur.x - lastQuadCtrl.x, y: 2 * cur.y - lastQuadCtrl.y }
            : { ...cur };
          const p3 = rel
            ? { x: cur.x + ns[0] * sc.scaleX, y: cur.y - ns[1] * sc.scaleY }
            : absXY(ns[0], ns[1], sc);
          const p1c = { x: p0.x + (2 / 3) * (q1.x - p0.x), y: p0.y + (2 / 3) * (q1.y - p0.y) };
          const p2c = { x: p3.x + (2 / 3) * (q1.x - p3.x), y: p3.y + (2 / 3) * (q1.y - p3.y) };
          entities.push(new BezierEntity(p0, p1c, p2c, p3));
          lastQuadCtrl = { ...q1 };
          lastCubicCtrl = null;
          cur = { ...p3 };
          break;
        }
        case "A": {
          // Elliptical arc. Used to be dropped on the floor — the segment was
          // skipped and the path silently closed straight across it, which is
          // how a rounded rectangle exported by this app came back square.
          const ns = take(7);
          if (ns.length < 7) break;
          const from = { ...cur };
          const to = rel
            ? { x: cur.x + ns[5] * sc.scaleX, y: cur.y - ns[6] * sc.scaleY }
            : absXY(ns[5], ns[6], sc);
          const arc = svgArcToWorld(from, to, ns[0], ns[1], ns[2], ns[3] !== 0, ns[4] !== 0, sc);
          if (arc?.kind === "arc") {
            flushPoly(false);
            entities.push(new ArcEntity(arc.center, arc.radius, arc.startAngle, arc.endAngle));
          } else {
            // Either an ellipse — nothing in this model can hold one, so it
            // joins the polyline run rather than vanishing — or a degenerate
            // arc, which the spec says to treat as a straight line.
            // Seeded from `from`, NOT from cur: cur is the far end by now, and
            // starting the run there would drop the segment it is meant to keep.
            if (polyPts.length === 0) polyPts.push({ ...from });
            if (arc) for (const p of arc.points) polyPts.push(p);
            else polyPts.push({ ...to });
          }
          cur = to;
          lastCubicCtrl = null;
          lastQuadCtrl = null;
          break;
        }
        case "Z": {
          if (polyPts.length > 0) {
            polyPts.push({ ...subStart });
            flushPoly(true);
          }
          cur = { ...subStart };
          lastCubicCtrl = null;
          lastQuadCtrl = null;
          break;
        }
      }
    } while (typeof tokens[i] === "number" && effectiveCmd !== "Z");
  }

  flushPoly(false); // flush any trailing open polyline
  return entities;
}

// ---------------------------------------------------------------------------
// Simple element helpers
// ---------------------------------------------------------------------------

function parsePointsList(attr: string, sc: SvgScale): Vec2[] {
  const nums = attr
    .trim()
    .split(/[\s,]+/)
    .map(Number)
    .filter(Number.isFinite);
  const out: Vec2[] = [];
  for (let j = 0; j + 1 < nums.length; j += 2) {
    out.push(absXY(nums[j], nums[j + 1], sc));
  }
  return out;
}

function fa(el: Element, name: string): number {
  return parseFloat(el.getAttribute(name) ?? "0") || 0;
}

function processElement(el: Element, sc: SvgScale, out: Entity[]): void {
  for (const child of Array.from(el.children)) {
    // Strip namespace prefix (e.g. "svg:path" → "path")
    const tag = child.tagName.toLowerCase().replace(/^[^:]+:/, "");

    switch (tag) {
      case "g":
        if (child.hasAttribute("transform")) {
          console.warn(
            `[svgImport] <g transform="${child.getAttribute("transform")}"> — ` +
              "transforms are not supported; coordinates will be wrong",
          );
        }
        processElement(child, sc, out);
        break;

      case "path": {
        const d = child.getAttribute("d") ?? "";
        // Push one at a time (not `out.push(...parsePath())`): a very long path
        // spread as function arguments would overflow the call stack.
        if (d) for (const e of parsePath(d, sc)) out.push(e);
        break;
      }

      case "line":
        out.push(
          new LineEntity(
            absXY(fa(child, "x1"), fa(child, "y1"), sc),
            absXY(fa(child, "x2"), fa(child, "y2"), sc),
          ),
        );
        break;

      case "circle": {
        const r = fa(child, "r") * sc.scaleX;
        if (r > 0) {
          out.push(new CircleEntity(absXY(fa(child, "cx"), fa(child, "cy"), sc), r));
        }
        break;
      }

      case "rect": {
        if (fa(child, "rx") || fa(child, "ry")) {
          console.warn(
            "[svgImport] Rounded rect (rx/ry) — corner radii ignored, importing as plain rect",
          );
        }
        const rx = fa(child, "x"),
          ry = fa(child, "y");
        const rw = fa(child, "width"),
          rh = fa(child, "height");
        if (rw > 0 && rh > 0) {
          // SVG rect: top-left = (rx, ry), bottom-right = (rx+rw, ry+rh) in Y-down.
          // After Y-flip: minPt (Y-up) = absXY of the bottom-right Y, maxPt = absXY of the top-left Y.
          out.push(
            new RectEntity(
              absXY(rx, ry + rh, sc), // Y-up bottom-left  = SVG bottom
              absXY(rx + rw, ry, sc), // Y-up top-right    = SVG top
            ),
          );
        }
        break;
      }

      case "ellipse":
        console.warn("[svgImport] <ellipse> is not supported — skipped");
        break;

      case "polyline":
      case "polygon": {
        const pts = parsePointsList(child.getAttribute("points") ?? "", sc);
        if (pts.length >= 2) {
          out.push(new PolylineEntity(pts, tag === "polygon"));
        }
        break;
      }

      // Silently skip: defs, title, desc, metadata, use, symbol, gradients, etc.
    }
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Parse an SVG string and return the equivalent document entities.
 * The caller is responsible for adding them to the CADDocument.
 */
export function importSvg(svgText: string): Entity[] {
  const domDoc = new DOMParser().parseFromString(svgText, "image/svg+xml");

  // DOMParser sets the root to <parsererror> on failure.
  const root = domDoc.documentElement;
  if (
    root.tagName === "parsererror" ||
    root.tagName.toLowerCase().replace(/^[^:]+:/, "") !== "svg"
  ) {
    console.warn("[svgImport] Failed to parse SVG — not a valid SVG document");
    return [];
  }

  const sc = computeScale(root);
  const entities: Entity[] = [];
  processElement(root, sc, entities);
  return entities;
}
