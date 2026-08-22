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
import { cross, dist, normalize, sub, type Vec2 } from "../core/vec2";
import { type Geo, type PointRef, SEGMENT_SEP } from "../model/constraints";
import {
  avoidDimensionCollision,
  chainProjectAnchors,
  chooseLinearType,
  type Dimension,
  type DimensionType,
  dimensionLayout,
  dimensionMeasure,
  dimensionOffsetFromCursor,
  dragDimensionTo,
  findDrivingDuplicate,
  type LinearDimType,
  makeDimension,
  projectOnLine,
} from "../model/dimensions";
import {
  type CADDocument,
  STOCK_ENTITY_ID,
  stockEdgeSegments,
  stockRefEntity,
} from "../model/document";
import {
  ArcEntity,
  baseAnchorKey,
  isEdgeAnchorKey,
  BezierEntity,
  bezierPointAt,
  CircleEntity,
  curveAnchorKey,
  edgeAnchorKey,
  edgeEndsForKey,
  type Entity,
  type LineEntity,
  PolylineEntity,
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
 * Circle and angle placement still require OPEN SPACE. Linear placement does
 * not — a bare click places it anywhere. The "second" hint names the gesture a
 * click there can mean that is not simply "the other end": open space, which
 * dimensions the first pick on its own. `null` means "restore the tool
 * default".
 */
export function dimensionHint(phase: Phase): string | null {
  switch (phase) {
    case "second":
      return "Click anywhere on the second object, or open space for the first one's own size";
    case "placeLinear":
      return "Click to place the dimension — Tab for a line's angle from horizontal";
    case "placeCircle":
    case "placeAngle":
      return "Move to position, then click in open space to place the dimension";
    default:
      return null; // "first" → the tool's default hint
  }
}

/**
 * Lock a dimension to an EDGE's own orientation, so where the cursor happens to
 * sit cannot turn it into a rotationally-invariant "distance" type. Null for a
 * diagonal edge, where there is no axis to lock to.
 */
function forcedTypeFor(a: Vec2, b: Vec2): LinearDimType | null {
  const dx = Math.abs(b.x - a.x);
  const dy = Math.abs(b.y - a.y);
  return dx > dy * 1.4 ? "horizontal" : dy > dx * 1.4 ? "vertical" : null;
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
  /**
   * Set while placing a LINE's own length, so Tab can switch that dimension to
   * the line's angle from horizontal — the other thing one selected line can be
   * dimensioned for, and one with no second operand to click.
   */
  private lengthOfLineId: string | null = null;
  private firstRaw: Vec2 | null = null;
  private cursor: Vec2 = { x: 0, y: 0 };
  private cursorRaw: Vec2 = { x: 0, y: 0 };
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
          // A circle or arc is the one shape whose click means something other
          // than "a point here": it selects the whole circle. A full circle is
          // dimensioned by its DIAMETER — that is the default in both Fusion
          // and SolidWorks, and the number a machinist wants for a hole. An arc
          // defaults to its radius, also as both do. Tab moves between them.
          this.circleId = hit.id;
          this.circleKind = hit.type === "arc" ? "radius" : "diameter";
          this.phase = "placeCircle";
        } else if (hit) {
          // Every other body click is a point ON that object, where it was
          // clicked — AutoCAD's "nearest" object snap. See pickAnywhereOn.
          const pick = pickAnywhereOn(hit, e.worldRaw, tol);
          if (pick) {
            this.firstRaw = e.worldRaw;
            this.p1 = pick;
            this.phase = "second";
          }
        } else {
          // Not a hitTest candidate — the stock rect isn't an entity — so check
          // it explicitly, the same way every real edge is handled above.
          const edge = pickStockEdge(ctx.doc, e.worldRaw, tol);
          if (edge) {
            this.firstRaw = e.worldRaw;
            this.p1 = edge.mid;
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
          this.acceptSecond(ctx, pick);
          break;
        }
        // Entity body click: anchor ON the edge that was clicked (or, for a
        // shape with no named edges, the nearest point on it).
        const hit = ctx.doc.hitTest(e.worldRaw, tol);
        if (hit) {
          // Clicking the SAME edge a second time means "this edge's length" —
          // the one-click shortcut a body click used to be, now spelled as a
          // deliberate gesture rather than the only thing a body click could
          // do. It measures between the edge's real END POINTS, so the
          // dimension drives them; it runs after pickPoint above, so clicking
          // an endpoint instead still measures a partial length.
          const span = sameEdgeSpan(pickEntityEdge(hit, e.worldRaw), this.p1!);
          if (span) {
            this.p1 = span.p1;
            this.p2 = span.p2;
            this.forcedLinearType = forcedTypeFor(span.p1.pos, span.p2.pos);
            this.phase = "placeLinear";
            break;
          }
          const entityPick = pickAnywhereOn(hit, e.worldRaw, tol);
          if (entityPick && !samePos(entityPick.pos, this.p1!.pos)) {
            this.acceptSecond(ctx, entityPick);
          }
          break;
        }
        // Stock rect edge click (not an entity, so hitTest won't catch it)
        if (this.p1) {
          const edge = pickStockEdge(ctx.doc, e.worldRaw, tol);
          if (edge) {
            const span = sameEdgeSpan(edge, this.p1);
            if (span) {
              this.p1 = span.p1;
              this.p2 = span.p2;
              this.forcedLinearType = forcedTypeFor(span.p1.pos, span.p2.pos);
              this.phase = "placeLinear";
            } else {
              this.acceptSecond(ctx, edge.mid);
            }
            break;
          }
        }
        // Open space, having picked an EDGE: that edge's own LENGTH, the way
        // Fusion and SolidWorks read "pick one thing, then click away" — one
        // entity selected means the dimension OF that entity.
        //
        // This gesture used to make the line's angle from horizontal instead.
        // That measurement has no second thing to click (the X axis is named by
        // the dimension's type, not by selectable geometry), so it now rides on
        // Tab during placement, the same key this tool already uses to cycle a
        // circle between radius and diameter.
        if (this.p1 && isEdgeAnchorKey(this.p1.ref.key)) {
          const hit = ctx.doc.entities.find((x) => x.id === this.p1!.ref.entityId);
          const span = hit ? pickEntityEdge(hit, this.p1.pos) : null;
          if (span && baseAnchorKey(span.mid.ref.key) === baseAnchorKey(this.p1.ref.key)) {
            this.p1 = span.p1;
            this.p2 = span.p2;
            this.forcedLinearType = forcedTypeFor(span.p1.pos, span.p2.pos);
            this.lengthOfLineId = hit?.type === "line" ? hit.id : null;
            this.phase = "placeLinear";
          }
        }
        break;
      }
      case "placeLinear": {
        // A click here always places the dimension. Both operands were picked
        // in phase "second", so there is nothing left to re-target — this used
        // to host a Shift-click that added the SECOND edge, back when the first
        // click on an edge consumed both of a dimension's ends at once.
        this.commitLinear(ctx);
        break;
      }
      case "placeCircle":
        if (this.gapTargetId) this.commitGap(ctx);
        else if (!this.circleToSecondPick(ctx, e.worldRaw, tol)) this.commitCircle(ctx);
        break;
      case "placeAngle":
        this.commitAngle(ctx);
        break;
    }
    this.recompute(ctx);
    this.updateHint(ctx);
    ctx.requestRender();
  }

  /**
   * Accept the second operand and move to placement. What the pair MEANS is
   * decided in `recompute`, which sees the same two picks and can re-decide as
   * the cursor moves; all this does is clear any type the first pick forced.
   */
  private acceptSecond(ctx: ToolContext, pick: Pick): void {
    const first = this.p1!;
    // Two EDGES that are not parallel: what lies between them is an ANGLE, not
    // a distance — there is no canonical distance between two lines that meet.
    // Fusion, SolidWorks and AutoCAD's DIMANGULAR all answer this pick that way.
    const e1 = isEdgeAnchorKey(first.ref.key) ? getEdgeEnds(ctx.doc, first) : null;
    const e2 = isEdgeAnchorKey(pick.ref.key) ? getEdgeEnds(ctx.doc, pick) : null;
    if (e1 && e2) {
      const d1 = normalize(sub(e1.b, e1.a));
      const d2 = normalize(sub(e2.b, e2.a));
      if (Math.abs(cross(d1, d2)) > 0.05) {
        this.line1Id = lineDistanceRef(first);
        this.line2Id = lineDistanceRef(pick);
        this.angleToAxis = false;
        this.phase = "placeAngle";
        return;
      }
    }
    this.p2 = pick;
    this.forcedLinearType = null;
    this.phase = "placeLinear";
  }

  /**
   * With a circle selected, a click on some OTHER geometry measures from that
   * circle's centre to it, rather than committing the radius.
   *
   * Selecting a circle used to be a one-way door: the click went straight to
   * radius placement and the only way out was Escape, so a circle could not be
   * one end of a distance at all unless you hit its exact centre hotspot — the
   * same "the first click already decided what this dimension is" hole that
   * made every line dimension start at a midpoint. Fusion and SolidWorks both
   * let a second selection convert it.
   *
   * Open space still places the radius/diameter, which is the same rule the
   * phase already had (and what its hint says), so nothing here is ambiguous
   * with placing. Returns false when the click was not on other geometry.
   */
  private circleToSecondPick(ctx: ToolContext, raw: Vec2, tol: number): boolean {
    const circle = ctx.doc.entities.find((x) => x.id === this.circleId);
    if (!circle) return false;
    const other = (pick: Pick | null): Pick | null =>
      pick && pick.ref.entityId !== this.circleId ? pick : null;

    const hit = ctx.doc.hitTest(raw, tol);
    const pick =
      other(ctx.doc.pickPoint(raw, tol)) ??
      other(pickVirtualRectCorner(ctx.doc.entities, raw, tol)) ??
      (hit && hit.id !== this.circleId ? other(pickAnywhereOn(hit, raw, tol)) : null) ??
      (hit ? null : (pickStockEdge(ctx.doc, raw, tol)?.mid ?? null));
    if (!pick) return false;

    this.p1 = { ref: { entityId: circle.id, key: "c" }, pos: circle.getPoint("c") };
    this.circleId = null;
    this.gapTargetId = null;
    this.acceptSecond(ctx, pick);
    return true;
  }

  /** Push the hint for the current phase (see {@link dimensionHint}). */
  private updateHint(ctx: ToolContext): void {
    ctx.setHint(dimensionHint(this.phase));
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext): void {
    this.cursor = e.world;
    this.cursorRaw = e.worldRaw;
    if (this.dragDim) {
      dragDimensionTo(this.dragDim, geoOf(ctx.doc), e.world);
      ctx.doc.emitChange();
      return;
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
    } else if (e.key === "Tab" && this.phase === "placeLinear" && this.lengthOfLineId) {
      // One selected line has two dimensions worth taking: its length, and its
      // angle from horizontal. Tab moves between them, matching how Tab already
      // moves a circle between radius and diameter.
      this.line1Id = this.lengthOfLineId;
      this.angleToAxis = true;
      this.lengthOfLineId = null;
      this.phase = "placeAngle";
      e.preventDefault();
      this.updateHint(ctx);
      this.recompute(ctx);
      ctx.requestRender();
    } else if (e.key === "Tab" && this.phase === "placeAngle" && this.angleToAxis) {
      const l = ctx.doc.entities.find((x) => x.id === this.line1Id) as LineEntity | undefined;
      if (l) {
        this.lengthOfLineId = l.id;
        this.p1 = { ref: { entityId: l.id, key: "a" }, pos: { ...l.a } };
        this.p2 = { ref: { entityId: l.id, key: "b" }, pos: { ...l.b } };
        this.forcedLinearType = forcedTypeFor(l.a, l.b);
        this.line1Id = null;
        this.angleToAxis = false;
        this.phase = "placeLinear";
      }
      e.preventDefault();
      this.updateHint(ctx);
      this.recompute(ctx);
      ctx.requestRender();
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
        this.circleKind = this.circleKind === "diameter" ? "radius" : "diameter";
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
    this.firstRaw = null;
    this.circleId = null;
    this.gapTargetId = null;
    this.line1Id = null;
    this.line2Id = null;
    this.lengthOfLineId = null;
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
      // With one edge picked and nothing under the cursor, show the dimension a
      // click right here would commit: that edge's own length. Fusion and
      // SolidWorks both preview the single-entity dimension from the moment you
      // select one thing, which is the only reason anybody discovers that
      // clicking open space finishes it — and, via the hint the preview brings
      // up, that Tab then switches a line to its angle.
      const pending = this.pendingEdgeLength(ctx);
      if (pending) {
        pending.offset = dimensionOffsetFromCursor(pending, geo, this.cursor);
        this.previewFromLayout(pending, geo, unit);
      } else {
        this.preview.previews = [
          { kind: "line", a: this.p1.pos, b: this.cursor },
          { kind: "point", pos: this.p1.pos },
        ];
      }
    } else if (this.phase === "placeLinear" && this.p1 && this.p2) {
      const activeP1 = this.p1;
      const activeP2 = this.p2;

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
      } else if (isEdgeAnchorKey(activeP1.ref.key) !== isEdgeAnchorKey(activeP2.ref.key)) {
        // Exactly one side is an EDGE and the other a real point: the thing
        // between them is the perpendicular distance to that edge. Measured any
        // other way it reports the gap to wherever along the edge the click
        // landed — a number that changes when you click elsewhere on the same
        // edge, with nothing having moved. See the "point-line-distance" note.
        const edgePick = isEdgeAnchorKey(activeP1.ref.key) ? activeP1 : activeP2;
        if (getEdgeEnds(ctx.doc, edgePick)) this.curType = "point-line-distance";
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

  /**
   * The dimension an open-space click would commit right now: the whole length
   * of the edge already picked. Null when there is no such pending dimension —
   * the pick was a bare point, or the cursor is over geometry the next click
   * would pick as the second operand instead.
   */
  private pendingEdgeLength(ctx: ToolContext): Dimension | null {
    const p1 = this.p1;
    if (!p1 || !isEdgeAnchorKey(p1.ref.key)) return null;
    const tol = ctx.view.toWorldLen(POINT_PICK_PX);
    if (ctx.doc.pickPoint(this.cursorRaw, tol) || ctx.doc.hitTest(this.cursorRaw, tol)) return null;
    if (pickStockEdge(ctx.doc, this.cursorRaw, tol)) return null;
    const ent = ctx.doc.entities.find((x) => x.id === p1.ref.entityId);
    const edge = ent ? pickEntityEdge(ent, p1.pos) : null;
    if (!edge || baseAnchorKey(edge.mid.ref.key) !== baseAnchorKey(p1.ref.key)) return null;
    return makeDimension(forcedTypeFor(edge.p1.pos, edge.p2.pos) ?? "distance", {
      points: [edge.p1.ref, edge.p2.ref],
      value: dist(edge.p1.pos, edge.p2.pos),
      offset: 0,
    });
  }

  private previewFromLayout(dim: Dimension, geo: Geo, unit: Unit): void {
    const layout = dimensionLayout(dim, geo, unit);
    if (!layout) return;
    const previews: PreviewShape[] = [
      ...layout.segments.map(([a, b]) => ({ kind: "line" as const, a, b })),
      // The VALUE, not just a dot where it will land. Watching the number
      // change as you position the dimension is how every CAD tool shows what
      // you are about to commit — and here it is also the only thing that says
      // whether the pair resolved to a length, a gap, an angle or a diameter
      // before you click.
      { kind: "text" as const, pos: layout.textPos, text: layout.label, dx: 8, dy: 0 },
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
    this.lengthOfLineId = null;
    this.angleToAxis = false;
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

    const ap1 = activeP1 ?? this.p1!;
    const ap2 = activeP2 ?? this.p2!;
    if (this.curType === "point-line-distance") {
      // points[0] is the POINT, entities[0] the LINE — whichever way round they
      // were clicked.
      const edge = isEdgeAnchorKey(ap1.ref.key) ? ap1 : ap2;
      const pt = edge === ap1 ? ap2 : ap1;
      return makeDimension(this.curType, {
        points: [pt.ref],
        entities: [lineDistanceRef(edge)],
        value: 0,
        offset: 0,
      });
    }

    return makeDimension(this.curType, {
      points: [ap1.ref, ap2.ref],
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

/**
 * The anchor for a click on an entity's body: a point ON THE OBJECT WHERE IT
 * WAS CLICKED — a line, any side of a rectangle/image/stock, any segment of a
 * polyline, anywhere on a circle or arc's rim, anywhere along a Bézier.
 * Falls back to the nearest pickable point only for shapes with no continuous
 * geometry to land on (text boxes, points).
 *
 * That fallback was once the ONLY behaviour, and it is what made a dimension
 * "only attach to the midpoint of a line": a line's pickable points are its two
 * ends and its midpoint, a rectangle's are its corners, edge midpoints and
 * centre, a polyline's are its vertices and segment midpoints. A click aimed
 * along an edge snapped to that edge's midpoint, so every dimension measured to
 * it started from the same point and they stacked with no way to pull them
 * apart.
 *
 * `doc.pickPoint` has already claimed every one of those hotspots within this
 * same tolerance before this runs, so a click that gets here is one the user
 * aimed at the object's BODY, not at a named point on it.
 */
function pickAnywhereOn(ent: Entity, p: Vec2, tol: number): Pick | null {
  if (ent instanceof CircleEntity || ent instanceof ArcEntity) {
    const rim = circleEdgePick(ent, p, tol);
    if (rim) return rim;
  }
  if (ent instanceof BezierEntity) {
    const on = bezierCurvePick(ent, p);
    if (on) return on;
  }
  const edge = pickEntityEdge(ent, p);
  if (edge) return edge.mid;
  return pickNearestEntityPoint(ent, p, tol);
}

/**
 * The one straight edge a click landed on, for any entity that has straight
 * edges: its two END PointRefs plus the anchor where the click landed. Null for
 * everything else. One function so "which edge did they click" is answered the
 * same way wherever it is asked.
 */
function pickEntityEdge(
  ent: Entity,
  p: Vec2,
): { p1: Pick; p2: Pick; mid: Pick } | null {
  if (ent.type === "line") {
    const l = ent as LineEntity;
    return {
      p1: { ref: { entityId: l.id, key: "a" }, pos: { ...l.a } },
      p2: { ref: { entityId: l.id, key: "b" }, pos: { ...l.b } },
      mid: edgeAnchorPick(l.id, "mid", l.a, l.b, p),
    };
  }
  if (ent.type === "rectangle" || ent.type === "image") {
    return pickRectOrImageEdge(ent as RectEntity | RasterImageEntity, p);
  }
  if (ent instanceof PolylineEntity) return pickPolylineSegment(ent, p);
  return null;
}

/**
 * The polyline segment nearest `p`. A segment is named by the STABLE id of its
 * start vertex — the same `v<id>` / `mid_<id>` spelling the entity's own
 * pickable points use — so an anchor survives an edit that inserts a vertex
 * ahead of it, the same way a vertex reference does.
 */
function pickPolylineSegment(
  ent: PolylineEntity,
  p: Vec2,
): { p1: Pick; p2: Pick; mid: Pick } | null {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < ent.segmentCount(); i++) {
    const [a, b] = ent.segment(i);
    const d = distToSegment(p, a, b);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  if (best < 0) return null;
  const [a, b] = ent.segment(best);
  const startId = ent.vertexIds[best];
  const endId = ent.vertexIds[(best + 1) % ent.points.length];
  return {
    p1: { ref: { entityId: ent.id, key: `v${startId}` }, pos: { ...a } },
    p2: { ref: { entityId: ent.id, key: `v${endId}` }, pos: { ...b } },
    mid: edgeAnchorPick(ent.id, `mid_${startId}`, a, b, p),
  };
}

/**
 * The point on a Bézier nearest `p`, as a `curve@<t>` anchor.
 *
 * Found on the same flattening the curve is drawn and hit-tested with, so what
 * the anchor lands on is what the user sees; `t` is then interpolated within
 * the winning chord. A Bézier's only named points are its four control points,
 * two of which are not even ON the curve — so without this a dimension could
 * not touch the curve anywhere between its ends.
 */
function bezierCurvePick(ent: BezierEntity, p: Vec2): Pick | null {
  const N = 64;
  let bestT = 0;
  let bestD = Infinity;
  let prev = bezierPointAt(ent.p0, ent.p1, ent.p2, ent.p3, 0);
  for (let i = 1; i <= N; i++) {
    const t1 = i / N;
    const cur = bezierPointAt(ent.p0, ent.p1, ent.p2, ent.p3, t1);
    const d = distToSegment(p, prev, cur);
    if (d < bestD) {
      bestD = d;
      // Where along THIS chord, mapped back into the curve's own parameter.
      bestT = ((i - 1) + projectOnLine(p, prev, cur)) / N;
    }
    prev = cur;
  }
  return {
    ref: { entityId: ent.id, key: curveAnchorKey(bestT) },
    pos: bezierPointAt(ent.p0, ent.p1, ent.p2, ent.p3, bestT),
  };
}

/**
 * When a second click lands on the SAME edge the first pick anchored to, that
 * edge's two ends — i.e. "dimension this edge's length". Null otherwise, which
 * includes a different side of the same rectangle: two points on two different
 * sides is a perfectly ordinary thing to measure.
 */
function sameEdgeSpan(
  edge: { p1: Pick; p2: Pick; mid: Pick } | null,
  first: Pick,
): { p1: Pick; p2: Pick } | null {
  if (!edge) return null;
  if (edge.mid.ref.entityId !== first.ref.entityId) return null;
  if (baseAnchorKey(edge.mid.ref.key) !== baseAnchorKey(first.ref.key)) return null;
  return { p1: edge.p1, p2: edge.p2 };
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
  return edgeEndsForKey(e, midRef.ref.key);
}

/**
 * How a line-distance dimension names one of its two sides. A plain line is
 * just its id; one edge of a multi-edge entity (rectangle, image, stock) has
 * to carry WHICH edge, via the existing `<id>#<key>` segment-ref convention.
 */
function lineDistanceRef(pick: Pick): string {
  const { entityId, key } = pick.ref;
  // The bare edge key: a line-distance dim names two whole EDGES and carries
  // where it sits along them in `anchors`, so a `@t` fraction in the ref would
  // be a second, silently disagreeing copy of that same fact.
  const base = baseAnchorKey(key);
  return base.startsWith("mid_") ? `${entityId}${SEGMENT_SEP}${base}` : entityId;
}

/**
 * The anchor Pick for a click at `p` on the edge running a→b: the point on the
 * edge WHERE THE USER CLICKED, not that edge's midpoint.
 *
 * Every edge dimension used to anchor at the midpoint, because the midpoint was
 * the only named point on an edge. Two dimensions measured to the same edge
 * therefore started from the same point and their extension lines ran along
 * each other, which moving the dimension cannot fix — `offset` slides the
 * shaft, never the anchor. AutoCAD's "nearest" object snap and Fusion's sketch
 * dimensions both witness an edge where you picked it; so does this.
 *
 * Deliberately no snapping to the ends or the middle: all three are DOF
 * hotspots `pickPoint` has already claimed within this same tolerance, so any
 * click that reaches here is further than the tolerance from every one of them.
 */
function edgeAnchorPick(entityId: string, edgeKey: string, a: Vec2, b: Vec2, p: Vec2): Pick {
  const t = projectOnLine(p, a, b);
  return {
    ref: { entityId, key: edgeAnchorKey(edgeKey, t) },
    pos: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t },
  };
}

/** Find the closest edge of a rectangle or image and return its two corner PointRefs and the clicked anchor on it. */
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
  const edges: [string, Vec2, string, Vec2, string][] = [
    [blKey, bl, brKey, br, "mid_b"],
    [brKey, br, trKey, tr, "mid_r"],
    [trKey, tr, tlKey, tl, "mid_t"],
    [tlKey, tl, blKey, bl, "mid_l"],
  ];
  let best: [string, Vec2, string, Vec2, string] | null = null;
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
    mid: edgeAnchorPick(ent.id, best[4], best[1], best[3], p),
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
  // Edge order and key names come from STOCK_EDGES so this cannot drift out of
  // step with the offset tool's copy or with RECT_EDGE_CORNERS.
  const segs = stockEdgeSegments(doc);
  if (!segs) return null; // rotary: no flat stock to dimension from
  const edges: [string, Vec2, string, Vec2, string][] = segs.map((s) => [
    s.edge.corners[0],
    s.a,
    s.edge.corners[1],
    s.b,
    s.edge.mid,
  ]);
  let best: [string, Vec2, string, Vec2, string] | null = null;
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
    mid: edgeAnchorPick(STOCK_ENTITY_ID, best[4], best[1], best[3], p),
  };
}

/** True when a linear dimension measures entirely between two stock points —
 *  both sides fixed, so it can never drive anything (see commitLinear). */
function measuresStockOnly(dim: Dimension): boolean {
  return dim.points.length === 2 && dim.points.every((p) => p.entityId === STOCK_ENTITY_ID);
}
