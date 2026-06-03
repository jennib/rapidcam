/**
 * Dimension tool.
 *   - click point A, click point B, move to place, click → linear dimension.
 *     The sub-type is chosen by where you place it (drag up/down = horizontal,
 *     sideways = vertical, diagonal = aligned) — like SolidWorks "smart" dims.
 *   - click a circle, move to place, click → radius dimension (Tab toggles ⌀).
 * New dimensions are driving; double-click one (any tool) to edit its value.
 */

import { Vec2, dist } from "../core/vec2";
import { distToSegment } from "../core/geom";
import { Unit } from "../core/units";
import { Entity, RectEntity } from "../model/entities";
import { Geo, PointRef } from "../model/constraints";
import {
  Dimension,
  DimensionType,
  makeDimension,
  dimensionLayout,
  dimensionMeasure,
  dimensionOffsetFromCursor,
  chooseLinearType,
} from "../model/dimensions";
import { Tool, ToolContext, ToolPointerEvent, ToolOverlay } from "./tool";
import { ICONS } from "./icons";

type Phase = "first" | "second" | "placeLinear" | "placeCircle";
const POINT_PICK_PX = 8;

interface Pick {
  ref: PointRef;
  pos: Vec2;
}

export class DimensionTool implements Tool {
  readonly id = "dimension";
  readonly label = "Dimension (D)";
  readonly icon = ICONS.dimension;

  private phase: Phase = "first";
  private p1: Pick | null = null;
  private p2: Pick | null = null;
  private circleId: string | null = null;
  private circleKind: DimensionType = "radius";
  private cursor: Vec2 = { x: 0, y: 0 };
  private dragDim: Dimension | null = null;

  // committed-on-move placement state
  private curType: DimensionType = "distance";
  private curOffset = 0;
  private preview: ToolOverlay = { previews: [], selectionRect: null };

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
    if (e.button !== 0) return;
    const tol = ctx.view.toWorldLen(POINT_PICK_PX);

    switch (this.phase) {
      case "first": {
        // Grab an existing dimension to reposition it (offset only — no re-solve).
        const existing = ctx.doc.dimensionAt(e.worldRaw, ctx.view.toWorldLen(8));
        if (existing) {
          ctx.pushHistory();
          this.dragDim = existing;
          return;
        }
        // Pick a DOF point (line endpoints, circle center, rect bl/tr corners),
        // falling back to the two virtual rect corners (br, tl) not in dofPoints.
        const pick =
          ctx.doc.pickPoint(e.worldRaw, tol) ??
          pickVirtualRectCorner(ctx.doc.entities, e.worldRaw, tol);
        if (pick) {
          this.p1 = pick;
          this.phase = "second";
          break;
        }
        const hit = ctx.doc.hitTest(e.worldRaw, tol);
        if (hit && hit.type === "circle") {
          this.circleId = hit.id;
          this.circleKind = "radius";
          this.phase = "placeCircle";
        } else if (hit && hit.type === "rectangle") {
          // Clicking an edge directly sets both endpoints and skips the second pick.
          const edge = pickRectEdge(hit as RectEntity, e.worldRaw);
          if (edge) {
            this.p1 = edge.p1;
            this.p2 = edge.p2;
            this.phase = "placeLinear";
          }
        } else if (hit) {
          // Line / polyline body click: snap to nearest endpoint or vertex.
          const entityPick = pickNearestEntityPoint(hit, e.worldRaw);
          if (entityPick) {
            this.p1 = entityPick;
            this.phase = "second";
          }
        }
        break;
      }
      case "second": {
        const pick =
          ctx.doc.pickPoint(e.worldRaw, tol) ??
          pickVirtualRectCorner(ctx.doc.entities, e.worldRaw, tol);
        if (pick && !samePos(pick.pos, this.p1!.pos)) {
          this.p2 = pick;
          this.phase = "placeLinear";
          break;
        }
        // Entity body click: snap to nearest point on the hit entity.
        const hit = ctx.doc.hitTest(e.worldRaw, tol);
        if (hit) {
          const entityPick = pickNearestEntityPoint(hit, e.worldRaw);
          if (entityPick && !samePos(entityPick.pos, this.p1!.pos)) {
            this.p2 = entityPick;
            this.phase = "placeLinear";
          }
        }
        break;
      }
      case "placeLinear":
        this.commitLinear(ctx);
        break;
      case "placeCircle":
        this.commitCircle(ctx);
        break;
    }
    this.recompute(ctx);
    ctx.requestRender();
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext): void {
    this.cursor = e.world;
    if (this.dragDim) {
      const geo = geoOf(ctx.doc.entities);
      this.dragDim.offset = dimensionOffsetFromCursor(this.dragDim, geo, e.world);
      ctx.doc.emitChange();
      return;
    }
    this.recompute(ctx);
    if (this.phase !== "first") ctx.requestRender();
  }

  onPointerUp(): void {
    this.dragDim = null;
  }

  onKeyDown(e: KeyboardEvent, ctx: ToolContext): void {
    if (e.key === "Escape") {
      this.cancel(ctx);
    } else if (e.key === "Tab" && this.phase === "placeCircle") {
      this.circleKind = this.circleKind === "radius" ? "diameter" : "radius";
      e.preventDefault();
      this.recompute(ctx);
      ctx.requestRender();
    }
  }

  getOverlay(): ToolOverlay {
    return this.preview;
  }

  cancel(ctx: ToolContext): void {
    this.phase = "first";
    this.p1 = null;
    this.p2 = null;
    this.circleId = null;
    this.preview = { previews: [], selectionRect: null };
    ctx.requestRender();
  }

  // --- placement -----------------------------------------------------------
  private recompute(ctx: ToolContext): void {
    const geo = geoOf(ctx.doc.entities);
    const unit = ctx.doc.displayUnit;
    this.preview = { previews: [], selectionRect: null };

    if (this.phase === "second" && this.p1) {
      this.preview.previews = [
        { kind: "line", a: this.p1.pos, b: this.cursor },
        { kind: "point", pos: this.p1.pos },
      ];
    } else if (this.phase === "placeLinear" && this.p1 && this.p2) {
      this.curType = chooseLinearType(this.p1.pos, this.p2.pos, this.cursor);
      const dim = this.linearDim(0);
      this.curOffset = dimensionOffsetFromCursor(dim, geo, this.cursor);
      dim.offset = this.curOffset;
      this.previewFromLayout(dim, geo, unit);
    } else if (this.phase === "placeCircle" && this.circleId) {
      const dim = this.circleDim(0);
      this.curOffset = dimensionOffsetFromCursor(dim, geo, this.cursor);
      dim.offset = this.curOffset;
      this.previewFromLayout(dim, geo, unit);
    }
  }

  private previewFromLayout(dim: Dimension, geo: Geo, unit: Unit): void {
    const layout = dimensionLayout(dim, geo, unit);
    if (!layout) return;
    this.preview.previews = [
      ...layout.segments.map(([a, b]) => ({ kind: "line" as const, a, b })),
      { kind: "point" as const, pos: layout.textPos },
    ];
  }

  private linearDim(offset: number): Dimension {
    return makeDimension(this.curType, {
      points: [this.p1!.ref, this.p2!.ref],
      value: 0,
      offset,
    });
  }
  private circleDim(offset: number): Dimension {
    return makeDimension(this.circleKind, {
      entities: [this.circleId!],
      value: 0,
      offset,
    });
  }

  private commitLinear(ctx: ToolContext): void {
    ctx.pushHistory();
    const geo = geoOf(ctx.doc.entities);
    const dim = this.linearDim(this.curOffset);
    dim.value = dimensionMeasure(dim, geo) ?? 0;
    ctx.doc.addDimension(dim);
    ctx.solve();
    this.phase = "first";
    this.p1 = null;
    this.p2 = null;
    ctx.openDimEditor(dim);
  }
  private commitCircle(ctx: ToolContext): void {
    ctx.pushHistory();
    const geo = geoOf(ctx.doc.entities);
    const dim = this.circleDim(this.curOffset);
    dim.value = dimensionMeasure(dim, geo) ?? 0;
    ctx.doc.addDimension(dim);
    ctx.solve();
    this.phase = "first";
    this.circleId = null;
    ctx.openDimEditor(dim);
  }
}

function geoOf(entities: Entity[]): Geo {
  const m = new Map(entities.map((e) => [e.id, e]));
  return (id) => m.get(id);
}
function samePos(a: Vec2, b: Vec2): boolean {
  return dist(a, b) < 1e-9;
}

/** Nearest point on an entity for use as a dimension anchor (pickable points). */
function pickNearestEntityPoint(ent: Entity, p: Vec2): Pick | null {
  let best: Pick | null = null;
  let bestD = Infinity;
  for (const dp of ent.pickablePoints()) {
    const d = dist(dp.pos, p);
    if (d < bestD) {
      bestD = d;
      best = { ref: { entityId: ent.id, key: dp.key }, pos: dp.pos };
    }
  }
  return best;
}

/** Pick the br or tl corner of any rectangle — these aren't DOF points so pickPoint misses them. */
function pickVirtualRectCorner(entities: Entity[], p: Vec2, tol: number): Pick | null {
  let best: Pick | null = null;
  let bestD = tol;
  for (const ent of entities) {
    if (ent.type !== "rectangle") continue;
    for (const key of ["br", "tl"] as const) {
      const pos = ent.getPoint(key);
      const d = dist(pos, p);
      if (d < bestD) {
        bestD = d;
        best = { ref: { entityId: ent.id, key }, pos };
      }
    }
  }
  return best;
}

/** Find the closest edge of a rectangle and return its two corner PointRefs. */
function pickRectEdge(rect: RectEntity, p: Vec2): { p1: Pick; p2: Pick } | null {
  const bl = rect.getPoint("bl");
  const br = rect.getPoint("br");
  const tr = rect.getPoint("tr");
  const tl = rect.getPoint("tl");
  const edges: [string, Vec2, string, Vec2][] = [
    ["bl", bl, "br", br],
    ["br", br, "tr", tr],
    ["tr", tr, "tl", tl],
    ["tl", tl, "bl", bl],
  ];
  let best: [string, Vec2, string, Vec2] | null = null;
  let bestD = Infinity;
  for (const edge of edges) {
    const d = distToSegment(p, edge[1], edge[3]);
    if (d < bestD) {
      bestD = d;
      best = edge;
    }
  }
  if (!best) return null;
  return {
    p1: { ref: { entityId: rect.id, key: best[0] }, pos: best[1] },
    p2: { ref: { entityId: rect.id, key: best[2] }, pos: best[3] },
  };
}
