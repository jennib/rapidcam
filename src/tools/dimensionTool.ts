/**
 * Dimension tool.
 *   - click point A, click point B, move to place, click → linear dimension.
 *     The sub-type is chosen by where you place it (drag up/down = horizontal,
 *     sideways = vertical, diagonal = aligned) — like SolidWorks "smart" dims.
 *   - click a circle, move to place, click → radius dimension (Tab toggles ⌀).
 * New dimensions are driving; double-click one (any tool) to edit its value.
 */

import { angleInArc, distToSegment } from "../core/geom";
import type { Unit } from "../core/units";
import { cross, dist, mid, normalize, sub, type Vec2 } from "../core/vec2";
import { type Geo, type PointRef, SEGMENT_SEP } from "../model/constraints";
import {
  avoidDimensionCollision,
  chainProjectAnchors,
  chooseLinearType,
  type Dimension,
  type DimensionType,
  dimensionAnchorsFromCursor,
  dimensionLayout,
  dimensionMeasure,
  dimensionOffsetFromCursor,
  findDrivingDuplicate,
  type LinearDimType,
  makeDimension,
} from "../model/dimensions";
import {
  type CADDocument,
  STOCK_ENTITY_ID,
  stockRefEntity,
  stockRefPoint,
} from "../model/document";
import {
  ArcEntity,
  CircleEntity,
  edgeEndsOf,
  type Entity,
  type LineEntity,
  type RasterImageEntity,
  type RectEntity,
  TextEntity,
} from "../model/entities";

/** True when an entity can carry a radius / gap dimension. */
function isCircular(e: Entity | null): e is Entity {
  return !!e && (e.type === "circle" || e.type === "arc");
}

/**
 * True when a linear dimension measures across a single TextEntity's own box —
 * both anchors resolve to the same text. Such a dim can't drive: a text's size
 * lives in its font, not the solver, so both points move together and the
 * residual gradient is zero. Callers create these as reference (non-driving)
 * dims so editing the value doesn't silently revert. Exported for testing.
 */
export function measuresSingleTextBox(dim: Dimension, geo: Geo): boolean {
  if (dim.points.length !== 2) return false;
  const [a, b] = dim.points;
  if (a.entityId !== b.entityId) return false;
  return geo(a.entityId) instanceof TextEntity;
}

import type { PreviewShape } from "../view/overlay";
import { ICONS } from "./icons";
import type { Tool, ToolContext, ToolOverlay, ToolPointerEvent } from "./tool";

export type Phase =
  | "first"
  | "second"
  | "placeLinear"
  | "placeCircle"
  | "placeAngle";
const POINT_PICK_PX = 8;

/**
 * Phase-aware status-bar hint. The tool's static TOOL_HINTS entry only covers
 * the start; once the user has picked their points the guidance must change, or
 * a click that gets consumed as a pick reads as "nothing happened" (audit #4).
 *
 * Circle and angle placement still require OPEN SPACE. Linear placement no
 * longer does — a bare click places it anywhere, and re-targeting onto a second
 * edge takes Shift — so its hint advertises the Shift gesture instead, which is
 * otherwise undiscoverable. `null` means "restore the tool default".
 */
export function dimensionHint(phase: Phase): string | null {
  switch (phase) {
    case "second":
      return "Click the second point or edge — or, from a line, open space for its angle from horizontal";
    case "placeLinear":
      return "Click to place the dimension — Shift-click another edge to measure to that instead";
    case "placeCircle":
    case "placeAngle":
      return "Move to position, then click in open space to place the dimension";
    default:
      return null; // "first" → the tool's default hint
  }
}

/** Exported for testing. */
export interface Pick {
  ref: PointRef;
  pos: Vec2;
}

export class DimensionTool implements Tool {
  readonly id = "dimension";
  readonly label = "Dimension";
  readonly icon = ICONS.dimension;

  private phase: Phase = "first";
  private p1: Pick | null = null;
  private p2: Pick | null = null;
  private circleId: string | null = null;
  private circleKind: DimensionType = "radius";
  // When hovering a second circle/arc while placing a circle dim, switch to a
  // gap dimension between the two (e.g. inner/outer offset). null = radius/⌀.
  private gapTargetId: string | null = null;
  private line1Id: string | null = null;
  /** True once the second operand was chosen as the X axis rather than a line. */
  private angleToAxis = false;
  private line2Id: string | null = null;
  private firstMid: Pick | null = null;
  private hoverP1: Pick | null = null;
  private hoverP2: Pick | null = null;
  private firstRaw: Vec2 | null = null;
  private cursor: Vec2 = { x: 0, y: 0 };
  private dragDim: Dimension | null = null;

  // committed-on-move placement state
  private curType: DimensionType = "distance";
  private forcedLinearType: LinearDimType | null = null;
  private curOffset = 0;
  private preview: ToolOverlay = { previews: [], selectionRect: null };

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
    if (e.button !== 0) return;
    const tol = ctx.view.toWorldLen(POINT_PICK_PX);

    switch (this.phase) {
      case "first": {
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

        // Grab an existing dimension to reposition it (offset/anchors only — no re-solve).
        const existing = ctx.doc.dimensionAt(e.worldRaw, ctx.view.toWorldLen(8), ctx.view.scale);
        if (existing) {
          ctx.pushHistory();
          this.dragDim = existing;
          return;
        }
        const hit = ctx.doc.hitTest(e.worldRaw, tol);
        if (hit && (hit.type === "circle" || hit.type === "arc")) {
          this.circleId = hit.id;
          this.circleKind = "radius";
          this.phase = "placeCircle";
        } else if (hit && (hit.type === "rectangle" || hit.type === "image")) {
          // Clicking an edge directly sets both endpoints and skips the second pick.
          const edge = pickRectOrImageEdge(hit as RectEntity | RasterImageEntity, e.worldRaw);
          if (edge) {
            this.firstRaw = e.worldRaw;
            this.firstMid = edge.mid;
            this.p1 = edge.p1;
            this.p2 = edge.p2;
            const dx = Math.abs(edge.p2.pos.x - edge.p1.pos.x);
            const dy = Math.abs(edge.p2.pos.y - edge.p1.pos.y);
            this.forcedLinearType =
              dx > dy * 1.4 ? "horizontal" : dy > dx * 1.4 ? "vertical" : null;
            this.phase = "placeLinear";
          }
        } else if (hit) {
          if (hit.type === "line") {
            // Line body click: dimension the line length directly.
            const line = hit as LineEntity;
            this.firstRaw = e.worldRaw;
            this.firstMid = { ref: { entityId: hit.id, key: "mid" }, pos: mid(line.a, line.b) };
            this.p1 = { ref: { entityId: hit.id, key: "a" }, pos: { ...line.a } };
            this.p2 = { ref: { entityId: hit.id, key: "b" }, pos: { ...line.b } };
            // Lock to the line's actual orientation so the cursor position can't
            // accidentally produce a "distance" type (rotationally invariant).
            const dx = Math.abs(line.b.x - line.a.x);
            const dy = Math.abs(line.b.y - line.a.y);
            this.forcedLinearType =
              dx > dy * 1.4 ? "horizontal" : dy > dx * 1.4 ? "vertical" : null;
            this.phase = "placeLinear";
          } else {
            // Polyline body click: snap to nearest vertex.
            const entityPick = pickNearestEntityPoint(hit, e.worldRaw, tol);
            if (entityPick) {
              this.p1 = entityPick;
              this.phase = "second";
            }
          }
        } else {
          // Not a hitTest candidate — the stock rect isn't an entity — so check
          // it explicitly, same as a rectangle/image edge above.
          const edge = pickStockEdge(ctx.doc, e.worldRaw, tol);
          if (edge) {
            this.firstRaw = e.worldRaw;
            this.firstMid = edge.mid;
            this.p1 = edge.p1;
            this.p2 = edge.p2;
            const dx = Math.abs(edge.p2.pos.x - edge.p1.pos.x);
            const dy = Math.abs(edge.p2.pos.y - edge.p1.pos.y);
            this.forcedLinearType =
              dx > dy * 1.4 ? "horizontal" : dy > dx * 1.4 ? "vertical" : null;
            this.phase = "placeLinear";
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
          this.forcedLinearType = null;
          this.phase = "placeLinear";
          break;
        }
        // Entity body click: snap to nearest point on the hit entity.
        const hit = ctx.doc.hitTest(e.worldRaw, tol);
        if (hit) {
          const entityPick = pickNearestEntityPoint(hit, e.worldRaw, tol);
          if (entityPick && !samePos(entityPick.pos, this.p1!.pos)) {
            this.p2 = entityPick;
            this.forcedLinearType = null;
            this.phase = "placeLinear";
          }
          break;
        }
        // Stock rect edge click (not an entity, so hitTest won't catch it)
        if (this.p1 && this.p1.ref.entityId !== STOCK_ENTITY_ID) {
          const edge = pickStockEdge(ctx.doc, e.worldRaw, tol);
          if (edge) {
            this.p2 = edge.mid;
            const edgeEnds = getEdgeEnds(ctx.doc, edge.mid);
            if (edgeEnds) {
              const dir = normalize(sub(edgeEnds.b, edgeEnds.a));
              if (Math.abs(dir.y) > Math.abs(dir.x) * 1.4) this.forcedLinearType = "horizontal";
              else if (Math.abs(dir.x) > Math.abs(dir.y) * 1.4) this.forcedLinearType = "vertical";
              else this.forcedLinearType = null;
            } else {
              this.forcedLinearType = null;
            }
            this.phase = "placeLinear";
            break;
          }
        }
        // Open space, having started on a LINE: dimension that line's angle
        // from horizontal. There is no second thing to click for it — the X
        // axis is named by the dimension type rather than being selectable
        // geometry — so a miss is the only gesture available. It was dead
        // before (an open-space click here did nothing at all), and the phase
        // hint advertises it.
        if (this.p1 && ctx.doc.entities.find((x) => x.id === this.p1!.ref.entityId)?.type === "line") {
          this.line1Id = this.p1.ref.entityId;
          this.angleToAxis = true;
          this.phase = "placeAngle";
        }
        break;
      }
      case "placeLinear": {
        // Re-targeting onto a SECOND edge takes Shift; a plain click always
        // places the dimension.
        //
        // These two gestures used to share one click, disambiguated only by
        // proximity to some other edge — and since `pickStockEdge` stopped
        // requiring an explicit `doc.stockRect`, the stock's edges are the sheet
        // boundary in the default fills-the-sheet case. The pick tolerance is
        // 8px/scale, i.e. ~35mm of world at fit zoom, so an ordinary "click just
        // outside the part to place it" click landed inside that band and
        // silently measured the part-to-stock gap instead of committing what the
        // user had asked for. Placing is the overwhelmingly common action, so it
        // gets the bare click.
        if (this.firstMid && e.shiftKey) {
          const resolved = resolveSecondPick(
            ctx.doc,
            this.p1!,
            this.p2,
            this.firstMid,
            this.firstRaw,
            e.worldRaw,
            tol,
          );
          if (resolved) {
            const { newP1, newP2, forcedType } = resolved;
            this.forcedLinearType = forcedType;
            if (
              newP1?.ref.key.startsWith("mid") &&
              newP2?.ref.key.startsWith("mid") &&
              newP1.ref.entityId !== STOCK_ENTITY_ID &&
              newP2.ref.entityId !== STOCK_ENTITY_ID
            ) {
              const edge1 = getEdgeEnds(ctx.doc, newP1);
              const edge2 = getEdgeEnds(ctx.doc, newP2);
              if (edge1 && edge2) {
                const dir1 = normalize(sub(edge1.b, edge1.a));
                const dir2 = normalize(sub(edge2.b, edge2.a));
                if (Math.abs(cross(dir1, dir2)) > 0.05) {
                  this.line1Id = newP1.ref.entityId;
                  this.line2Id = newP2.ref.entityId;
                  this.phase = "placeAngle";
                  this.hoverP1 = null;
                  this.hoverP2 = null;
                  this.firstMid = null;
                  break;
                }
              }
            }
            if (newP1) this.p1 = newP1;
            if (newP2) this.p2 = newP2;
            this.firstMid = null;
            this.hoverP1 = null;
            this.hoverP2 = null;
            break;
          }
        }
        this.commitLinear(ctx);
        break;
      }
      case "placeCircle":
        if (this.gapTargetId) this.commitGap(ctx);
        else this.commitCircle(ctx);
        break;
      case "placeAngle":
        this.commitAngle(ctx);
        break;
    }
    this.recompute(ctx);
    this.updateHint(ctx);
    ctx.requestRender();
  }

  /** Push the hint for the current phase (see {@link dimensionHint}). */
  private updateHint(ctx: ToolContext): void {
    ctx.setHint(dimensionHint(this.phase));
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext): void {
    this.cursor = e.world;
    if (this.dragDim) {
      const geo = geoOf(ctx.doc);
      const anchors = dimensionAnchorsFromCursor(this.dragDim, geo, e.world);
      if (anchors) this.dragDim.anchors = anchors;
      this.dragDim.offset = dimensionOffsetFromCursor(this.dragDim, geo, e.world);
      ctx.doc.emitChange();
      return;
    }

    if (this.phase === "placeLinear") {
      this.hoverP1 = null;
      this.hoverP2 = null;
      // Preview the re-target only while Shift is down, so what the preview
      // shows is always what a click would produce.
      if (this.firstMid && e.shiftKey) {
        const tol = ctx.view.toWorldLen(POINT_PICK_PX);
        const resolved = resolveSecondPick(
          ctx.doc,
          this.p1!,
          this.p2,
          this.firstMid,
          this.firstRaw,
          e.worldRaw,
          tol,
        );
        if (resolved) {
          this.hoverP1 = resolved.newP1;
          this.hoverP2 = resolved.newP2;
        }
      }
    }

    if (this.phase === "placeCircle") {
      // Hovering a different circle/arc → preview a gap dim between the two.
      const tol = ctx.view.toWorldLen(POINT_PICK_PX);
      const hit = ctx.doc.hitTest(e.worldRaw, tol);
      this.gapTargetId = isCircular(hit) && hit.id !== this.circleId ? hit.id : null;
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
      const ent = this.circleId ? ctx.doc.entities.find((e) => e.id === this.circleId) : null;
      if (ent?.type === "arc") {
        // arc: cycle radius → diameter → arclength → radius
        this.circleKind =
          this.circleKind === "radius"
            ? "diameter"
            : this.circleKind === "diameter"
              ? "arclength"
              : "radius";
      } else {
        this.circleKind = this.circleKind === "radius" ? "diameter" : "radius";
      }
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
    this.firstMid = null;
    this.hoverP1 = null;
    this.hoverP2 = null;
    this.firstRaw = null;
    this.circleId = null;
    this.gapTargetId = null;
    this.line1Id = null;
    this.line2Id = null;
    this.angleToAxis = false;
    this.forcedLinearType = null;
    this.preview = { previews: [], selectionRect: null };
    this.updateHint(ctx); // phase reset to "first" → restore the default hint
    ctx.requestRender();
  }

  // --- placement -----------------------------------------------------------
  private recompute(ctx: ToolContext): void {
    const geo = geoOf(ctx.doc);
    const unit = ctx.doc.displayUnit;
    this.preview = { previews: [], selectionRect: null };

    if (this.phase === "second" && this.p1) {
      this.preview.previews = [
        { kind: "line", a: this.p1.pos, b: this.cursor },
        { kind: "point", pos: this.p1.pos },
      ];
    } else if (this.phase === "placeLinear" && this.p1 && this.p2) {
      const activeP1 = this.hoverP1 ?? this.p1;
      const activeP2 = this.hoverP2 ?? this.p2;

      this.curType =
        this.forcedLinearType ??
        chooseLinearType(activeP1.pos, activeP2.pos, this.cursor);
      // Two parallel edges measure as a true edge-to-edge gap, drawn where you
      // clicked. This used to exclude the stock (and any rect/image edge could
      // only be named as a whole entity), because dim.entities held bare ids
      // with no way to say WHICH of 4 edges was meant — so those degraded to a
      // point dimension pinned to both edges' MIDPOINTS, at two unrelated
      // positions, which is what made a line-to-stock-edge dimension look
      // broken. lineDistanceRef now qualifies the id with the edge key.
      if (activeP1.ref.key.startsWith("mid") && activeP2.ref.key.startsWith("mid")) {
        const edge1 = getEdgeEnds(ctx.doc, activeP1);
        const edge2 = getEdgeEnds(ctx.doc, activeP2);
        if (edge1 && edge2) {
          const dir1 = normalize(sub(edge1.b, edge1.a));
          const dir2 = normalize(sub(edge2.b, edge2.a));
          if (Math.abs(cross(dir1, dir2)) < 0.05) this.curType = "line-distance";
        }
      }

      const dim = this.linearDim(ctx, 0, activeP1, activeP2);
      this.curOffset = dimensionOffsetFromCursor(dim, geo, this.cursor);
      dim.offset = this.curOffset;
      this.previewFromLayout(dim, geo, unit);
    } else if (this.phase === "placeCircle" && this.circleId) {
      const dim = this.gapTargetId ? this.gapDim(0) : this.circleDim(0);
      this.curOffset = dimensionOffsetFromCursor(dim, geo, this.cursor);
      dim.offset = this.curOffset;
      this.previewFromLayout(dim, geo, unit);
    } else if (this.phase === "placeAngle" && this.line1Id && (this.line2Id || this.angleToAxis)) {
      const dim = this.angleDim(0);
      this.curOffset = dimensionOffsetFromCursor(dim, geo, this.cursor);
      dim.offset = this.curOffset;
      this.previewFromLayout(dim, geo, unit);
    }
  }

  private previewFromLayout(dim: Dimension, geo: Geo, unit: Unit): void {
    const layout = dimensionLayout(dim, geo, unit);
    if (!layout) return;
    const previews: PreviewShape[] = [
      ...layout.segments.map(([a, b]) => ({ kind: "line" as const, a, b })),
      { kind: "point" as const, pos: layout.textPos },
    ];
    if (layout.arc) {
      const { center, radius, startDir, endDir, ccw } = layout.arc;
      previews.push({
        kind: "polyline" as const,
        points: arcPolylinePoints(center, radius, startDir, endDir, ccw),
        closed: false,
      });
    }
    this.preview.previews = previews;
  }

  private angleDim(offset: number): Dimension {
    if (this.angleToAxis)
      return makeDimension("angle-x", { entities: [this.line1Id!], value: 0, offset });
    return makeDimension("angle", {
      entities: [this.line1Id!, this.line2Id!],
      value: 0,
      offset,
    });
  }

  private commitAngle(ctx: ToolContext): void {
    ctx.pushHistory();
    const geo = geoOf(ctx.doc);
    const dim = this.angleDim(this.curOffset);
    dim.value = dimensionMeasure(dim, geo) ?? 0;
    this.phase = "first";
    this.line1Id = null;
    this.line2Id = null;
    this.angleToAxis = false;
    this.firstMid = null;
    this.hoverP1 = null;
    this.hoverP2 = null;
    this.firstRaw = null;
    this.finaliseDim(dim, ctx);
  }

  /**
   * Add a dimension to the doc. If adding it as driving would over-constrain
   * (DOF is already 0), demote it to a reference dimension instead and skip
   * the editor. Otherwise add driving and open the editor.
   */
  private finaliseDim(dim: Dimension, ctx: ToolContext): void {
    // Refresh the DOF FIRST: some draw tools (circle/arc/line) don't re-solve on
    // commit, so currentDof() can be stale from before the geometry existed —
    // typically the empty-doc 0. Reading that stale 0 here would wrongly demote
    // the FIRST dimension on freshly-drawn geometry to a non-driving reference:
    // no editor, no constraint, no feedback — which reads as "nothing happened"
    // (audit #4). Solving now makes the check reflect the geometry as it is.
    ctx.solve();
    // Something already DRIVES this exact measurement. A second driver is at
    // best redundant and at worst a contradiction the solver cannot resolve —
    // and the failure surfaces later, on some unrelated edit, with no hint
    // that duplicates were the cause. Keep it as a reference annotation and
    // say so, rather than silently building an unsolvable sketch.
    const dup = findDrivingDuplicate(dim, ctx.doc.dimensions);
    if (dup) {
      dim.driving = false;
      ctx.notify("Already dimensioned — added for reference only");
    } else if (ctx.currentDof() < 1) {
      // Sketch is fully or already over-constrained — add as reference only.
      dim.driving = false;
    }
    ctx.doc.addDimension(dim);
    ctx.solve();
    if (dim.driving) ctx.openDimEditor(dim);
  }

  private linearDim(ctx: ToolContext, offset: number, activeP1?: Pick, activeP2?: Pick): Dimension {
    if (this.curType === "line-distance") {
      const ap1 = activeP1 ?? this.p1!;
      const ap2 = activeP2 ?? this.p2!;
      const p1Raw = this.firstRaw ?? ap1.pos;

      const edge1 = getEdgeEnds(ctx.doc, ap1);
      const edge2 = getEdgeEnds(ctx.doc, ap2);

      // t2 is derived from t1 (chain-projected across to line2), not from its
      // own raw click — two independently-clicked anchors are almost never at
      // matching heights, which used to draw a diagonal shaft instead of a
      // straight perpendicular one. See chainProjectAnchors.
      return makeDimension(this.curType, {
        entities: [lineDistanceRef(ap1), lineDistanceRef(ap2)],
        anchors: edge1 && edge2 ? chainProjectAnchors(p1Raw, edge1, edge2) : [0.5, 0.5],
        value: 0,
        offset,
      });
    }

    return makeDimension(this.curType, {
      points: [(activeP1 ?? this.p1!).ref, (activeP2 ?? this.p2!).ref],
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
  private gapDim(offset: number): Dimension {
    return makeDimension("circle-gap", {
      entities: [this.circleId!, this.gapTargetId!],
      value: 0,
      offset,
    });
  }

  private commitLinear(ctx: ToolContext): void {
    ctx.pushHistory();
    const geo = geoOf(ctx.doc);
    const dim = this.linearDim(ctx, this.curOffset);
    // Chain dimensioning (two dims measured from the same datum) otherwise
    // lands on the same or a near-identical offset — the shaft's position is
    // derived purely from where THIS click landed, with no awareness of what's
    // already there — so the shorter one buries inside the longer one instead
    // of stacking cleanly outward.
    dim.offset = avoidDimensionCollision(dim, ctx.doc.dimensions, geo, ctx.doc.displayUnit);
    dim.value = dimensionMeasure(dim, geo) ?? 0;
    // A dim across a single text's own box can't drive (the size lives in the
    // font, not the solver — both anchors translate together). Make it a
    // reference dimension so editing its value doesn't silently revert.
    if (measuresSingleTextBox(dim, geo)) {
      dim.driving = false;
      ctx.notify("Reference dimension — text size is set by its font/size, not driven");
    } else if (measuresStockOnly(dim)) {
      // Both anchors are fixed stock points — nothing here is ever a solver
      // variable, so a driving residual would just be permanently-satisfied
      // dead weight (and would wrongly count against the sketch's free DOF).
      dim.driving = false;
      ctx.notify("Reference dimension — the stock doesn't move, so this can't drive anything");
    }
    this.phase = "first";
    this.p1 = null;
    this.p2 = null;
    this.firstMid = null;
    this.hoverP1 = null;
    this.hoverP2 = null;
    this.firstRaw = null;
    this.finaliseDim(dim, ctx);
  }
  private commitCircle(ctx: ToolContext): void {
    ctx.pushHistory();
    const geo = geoOf(ctx.doc);
    const dim = this.circleDim(this.curOffset);
    dim.value = dimensionMeasure(dim, geo) ?? 0;
    this.phase = "first";
    this.circleId = null;
    this.gapTargetId = null;
    this.finaliseDim(dim, ctx);
  }
  private commitGap(ctx: ToolContext): void {
    ctx.pushHistory();
    const geo = geoOf(ctx.doc);
    const dim = this.gapDim(this.curOffset);
    dim.value = dimensionMeasure(dim, geo) ?? 0;
    this.phase = "first";
    this.circleId = null;
    this.gapTargetId = null;
    this.finaliseDim(dim, ctx);
  }
}

function geoOf(doc: CADDocument): Geo {
  const m = new Map(doc.entities.map((e) => [e.id, e]));
  return (id) =>
    id === STOCK_ENTITY_ID || id.startsWith(STOCK_ENTITY_ID)
      ? stockRefEntity(doc)
      : m.get(id);
}

function arcPolylinePoints(
  center: Vec2,
  radius: number,
  startDir: Vec2,
  endDir: Vec2,
  ccw: boolean,
): Vec2[] {
  const a0 = Math.atan2(startDir.y, startDir.x);
  const a1 = Math.atan2(endDir.y, endDir.x);
  let delta = a1 - a0;
  if (ccw && delta < 0) delta += 2 * Math.PI;
  if (!ccw && delta > 0) delta -= 2 * Math.PI;
  const N = Math.max(8, Math.ceil(Math.abs(delta) * 8));
  const pts: Vec2[] = [];
  for (let i = 0; i <= N; i++) {
    const a = a0 + delta * (i / N);
    pts.push({ x: center.x + radius * Math.cos(a), y: center.y + radius * Math.sin(a) });
  }
  return pts;
}
function samePos(a: Vec2, b: Vec2): boolean {
  return dist(a, b) < 1e-9;
}

const QUADRANT_ANGLES = [0, Math.PI / 2, Math.PI, -Math.PI / 2];

/**
 * Circle/arc rim anchor at the clicked angle, or null when the click is nearer
 * the centre (or off an arc's span). The key encodes the angle so the point is
 * recomputed live from the circle as it resizes/moves.
 *
 * Snaps to the nearest QUADRANT (matching CircleEntity's own snapPoints — the
 * ones every draw tool already snaps to) when the click is close enough, in
 * ARC LENGTH rather than raw angle, so the catch radius means the same few
 * screen pixels regardless of the circle's size. Without this, the picked
 * angle is whatever the mouse happened to be at — a click aimed at "the top
 * of the circle" lands a fraction of a degree off, and a dimension anchored
 * there renders visibly crooked even though its measured VALUE is always
 * exactly the radius (so the label looks perfectly clean, which makes the
 * crooked line read as a bug rather than an imprecise click). Only snaps to a
 * quadrant that's ALSO valid for an arc's span — never widens what an arc
 * pick can reach, only makes an already-valid nearby click land exactly.
 */
export function circleEdgePick(ent: CircleEntity | ArcEntity, p: Vec2, tol: number): Pick | null {
  const c = ent.center,
    r = ent.radius;
  const dCenter = dist(c, p);
  if (Math.abs(dCenter - r) >= dCenter) return null; // nearer the centre → let it win
  const rawTheta = Math.atan2(p.y - c.y, p.x - c.x);
  if (ent instanceof ArcEntity && !angleInArc(rawTheta, ent.startAngle, ent.endAngle)) return null;

  let theta = rawTheta;
  let bestArcDist = tol;
  for (const q of QUADRANT_ANGLES) {
    let d = Math.abs(rawTheta - q);
    if (d > Math.PI) d = 2 * Math.PI - d; // shortest angular distance
    const arcDist = d * r;
    if (
      arcDist < bestArcDist &&
      (!(ent instanceof ArcEntity) || angleInArc(q, ent.startAngle, ent.endAngle))
    ) {
      bestArcDist = arcDist;
      theta = q;
    }
  }
  return {
    ref: { entityId: ent.id, key: `edge@${theta}` },
    pos: { x: c.x + r * Math.cos(theta), y: c.y + r * Math.sin(theta) },
  };
}

/** Nearest point on an entity for use as a dimension anchor (pickable points). */
function pickNearestEntityPoint(ent: Entity, p: Vec2, tol: number): Pick | null {
  if (ent instanceof CircleEntity || ent instanceof ArcEntity) {
    const edge = circleEdgePick(ent, p, tol);
    if (edge) return edge;
  }
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
    const r = ent as RectEntity;
    for (const key of ["br", "tl"] as const) {
      const pos = r.getPoint(key);
      const d = dist(pos, p);
      if (d < bestD) {
        bestD = d;
        best = { ref: { entityId: r.id, key }, pos };
      }
    }
  }
  return best;
}

function getEdgeEnds(doc: CADDocument, midRef: Pick): { a: Vec2; b: Vec2 } | null {
  const id = midRef.ref.entityId;
  // The stock rect isn't in doc.entities — it resolves through stockRefEntity,
  // the same way Geo lookups do. Without this it returned null, so a
  // dimension from a stock edge never qualified as an edge-to-edge dimension
  // and silently degraded to a midpoint-to-midpoint point dimension.
  const e = id === STOCK_ENTITY_ID ? stockRefEntity(doc) : doc.entities.find((x) => x.id === id);
  if (!e) return null;
  if (e.type === "line") return { a: (e as LineEntity).a, b: (e as LineEntity).b };
  return edgeEndsOf(e, midRef.ref.key);
}

/**
 * How a line-distance dimension names one of its two sides. A plain line is
 * just its id; one edge of a multi-edge entity (rectangle, image, stock) has
 * to carry WHICH edge, via the existing `<id>#<key>` segment-ref convention.
 */
function lineDistanceRef(pick: Pick): string {
  const { entityId, key } = pick.ref;
  return key.startsWith("mid_") ? `${entityId}${SEGMENT_SEP}${key}` : entityId;
}

/** Find the closest edge of a rectangle or image and return its two corner PointRefs and its midpoint. */
function pickRectOrImageEdge(
  ent: RectEntity | RasterImageEntity,
  p: Vec2,
): { p1: Pick; p2: Pick; mid: Pick } | null {
  const isImg = ent.type === "image";
  const blKey = isImg ? "c0" : "bl";
  const brKey = isImg ? "c1" : "br";
  const trKey = isImg ? "c2" : "tr";
  const tlKey = isImg ? "c3" : "tl";
  const bl = ent.getPoint(blKey);
  const br = ent.getPoint(brKey);
  const tr = ent.getPoint(trKey);
  const tl = ent.getPoint(tlKey);
  const edges: [string, Vec2, string, Vec2, string, Vec2][] = [
    [blKey, bl, brKey, br, "mid_b", mid(bl, br)],
    [brKey, br, trKey, tr, "mid_r", mid(br, tr)],
    [trKey, tr, tlKey, tl, "mid_t", mid(tr, tl)],
    [tlKey, tl, blKey, bl, "mid_l", mid(tl, bl)],
  ];
  let best: [string, Vec2, string, Vec2, string, Vec2] | null = null;
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
    p1: { ref: { entityId: ent.id, key: best[0] }, pos: best[1] },
    p2: { ref: { entityId: ent.id, key: best[2] }, pos: best[3] },
    mid: { ref: { entityId: ent.id, key: best[4] }, pos: best[5] },
  };
}

/**
 * Find the closest edge of the STOCK rectangle within `tol`, same shape as
 * {@link pickRectOrImageEdge}. The stock isn't an entity, so it's never a
 * `hitTest` candidate — unlike a real rectangle, where `pickRectOrImageEdge`
 * only runs after hitTest has already confirmed the click is on its outline,
 * this does its own tolerance check (`bestD` starts at `tol`, not `Infinity`).
 * Without this, only the stock's 8 exact corner/midpoint points (each an
 * ~8px hotspot) were clickable — the rest of every edge was dead space, unlike
 * every other edge in the app.
 */
function pickStockEdge(
  doc: CADDocument,
  p: Vec2,
  tol: number,
): { p1: Pick; p2: Pick; mid: Pick } | null {
  const bl = stockRefPoint(doc, "bl");
  const br = stockRefPoint(doc, "br");
  const tr = stockRefPoint(doc, "tr");
  const tl = stockRefPoint(doc, "tl");
  if (!bl || !br || !tr || !tl) return null; // rotary: no flat stock to dimension from
  const edges: [string, Vec2, string, Vec2, string, Vec2][] = [
    ["bl", bl, "br", br, "mid_b", mid(bl, br)],
    ["br", br, "tr", tr, "mid_r", mid(br, tr)],
    ["tr", tr, "tl", tl, "mid_t", mid(tr, tl)],
    ["tl", tl, "bl", bl, "mid_l", mid(tl, bl)],
  ];
  let best: [string, Vec2, string, Vec2, string, Vec2] | null = null;
  let bestD = tol;
  for (const edge of edges) {
    const d = distToSegment(p, edge[1], edge[3]);
    if (d < bestD) {
      bestD = d;
      best = edge;
    }
  }
  if (!best) return null;
  return {
    p1: { ref: { entityId: STOCK_ENTITY_ID, key: best[0] }, pos: best[1] },
    p2: { ref: { entityId: STOCK_ENTITY_ID, key: best[2] }, pos: best[3] },
    mid: { ref: { entityId: STOCK_ENTITY_ID, key: best[4] }, pos: best[5] },
  };
}

/** True when a linear dimension measures entirely between two stock points —
 *  both sides fixed, so it can never drive anything (see commitLinear). */
function measuresStockOnly(dim: Dimension): boolean {
  return dim.points.length === 2 && dim.points.every((p) => p.entityId === STOCK_ENTITY_ID);
}

function resolveSecondPick(
  doc: CADDocument,
  p1: Pick,
  p2: Pick | null,
  firstMid: Pick | null,
  firstRaw: Vec2 | null,
  raw: Vec2,
  tol: number,
): { newP1: Pick | null; newP2: Pick | null; forcedType: LinearDimType | null } | null {
  const pick =
    doc.pickPoint(raw, tol) ??
    pickVirtualRectCorner(doc.entities, raw, tol);
  if (pick && !samePos(pick.pos, p1.pos) && (!p2 || !samePos(pick.pos, p2.pos))) {
    let newP1: Pick | null = null;
    if (firstMid && p2 && firstRaw) {
      newP1 = dist(firstRaw, p1.pos) <= dist(firstRaw, p2.pos) ? p1 : p2;
    }
    return { newP1, newP2: pick, forcedType: null };
  }

  const hit = doc.hitTest(raw, tol);
  if (hit) {
    if (hit.type === "rectangle" || hit.type === "image") {
      const edge = pickRectOrImageEdge(hit as RectEntity | RasterImageEntity, raw);
      if (edge && hit.id !== p1.ref.entityId) {
        return resolveEdgePair(doc, p1, p2, firstMid, firstRaw, edge);
      }
    } else if (hit.type === "line") {
      const line = hit as LineEntity;
      if (hit.id !== p1.ref.entityId) {
        const edge = {
          p1: { ref: { entityId: hit.id, key: "a" }, pos: { ...line.a } },
          p2: { ref: { entityId: hit.id, key: "b" }, pos: { ...line.b } },
          mid: { ref: { entityId: hit.id, key: "mid" }, pos: mid(line.a, line.b) },
        };
        return resolveEdgePair(doc, p1, p2, firstMid, firstRaw, edge);
      }
    } else {
      const pt = pickNearestEntityPoint(hit, raw, tol);
      if (pt && !samePos(pt.pos, p1.pos) && (!p2 || !samePos(pt.pos, p2.pos))) {
        let newP1: Pick | null = null;
        if (firstMid && p2 && firstRaw) {
          newP1 = dist(firstRaw, p1.pos) <= dist(firstRaw, p2.pos) ? p1 : p2;
        }
        return { newP1, newP2: pt, forcedType: null };
      }
    }
  } else if (p1.ref.entityId !== STOCK_ENTITY_ID) {
    const edge = pickStockEdge(doc, raw, tol);
    if (edge) {
      return resolveEdgePair(doc, p1, p2, firstMid, firstRaw, edge);
    }
  }

  return null;
}

function resolveEdgePair(
  doc: CADDocument,
  p1: Pick,
  p2: Pick | null,
  firstMid: Pick | null,
  firstRaw: Vec2 | null,
  edge2: { p1: Pick; p2: Pick; mid: Pick },
): { newP1: Pick | null; newP2: Pick | null; forcedType: LinearDimType | null } {
  if (firstMid && p2) {
    const edge1Ends = getEdgeEnds(doc, firstMid);
    const edge2Ends = getEdgeEnds(doc, edge2.mid);
    if (edge1Ends && edge2Ends) {
      const dir1 = normalize(sub(edge1Ends.b, edge1Ends.a));
      const dir2 = normalize(sub(edge2Ends.b, edge2Ends.a));
      const isParallel = Math.abs(cross(dir1, dir2)) < 0.05;
      if (isParallel) {
        return { newP1: firstMid, newP2: edge2.mid, forcedType: null };
      }
      // Non-parallel: dimension from the nearest clicked endpoint of Edge 1 to Edge 2
      const d1 = firstRaw ? dist(firstRaw, p1.pos) : 0;
      const d2 = firstRaw ? dist(firstRaw, p2.pos) : Infinity;
      const newP1 = d1 <= d2 ? p1 : p2;
      const newP2 = edge2.mid;

      const dx1 = Math.abs(dir1.x), dy1 = Math.abs(dir1.y);
      const dx2 = Math.abs(dir2.x), dy2 = Math.abs(dir2.y);
      let forcedType: LinearDimType | null = null;
      if (dx1 > dy1 * 1.4 && dy2 > dx2 * 1.4) {
        forcedType = "horizontal";
      } else if (dy1 > dx1 * 1.4 && dx2 > dy2 * 1.4) {
        forcedType = "vertical";
      }
      return { newP1, newP2, forcedType };
    }
    return { newP1: firstMid, newP2: edge2.mid, forcedType: null };
  }

  // First pick was a discrete point, second pick is an edge
  let forcedType: LinearDimType | null = null;
  const edge2Ends = getEdgeEnds(doc, edge2.mid);
  if (edge2Ends) {
    const dir2 = normalize(sub(edge2Ends.b, edge2Ends.a));
    const dx2 = Math.abs(dir2.x), dy2 = Math.abs(dir2.y);
    if (dy2 > dx2 * 1.4) forcedType = "horizontal";
    else if (dx2 > dy2 * 1.4) forcedType = "vertical";
  }
  return { newP1: null, newP2: edge2.mid, forcedType };
}

