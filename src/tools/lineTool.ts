/**
 * Line tool: click start, click end. Stays active to draw more lines.
 *
 * Type to draw (the keyboard twin of dragDraw.ts): after the first click a
 * Length/Angle pair opens at the start point, so an exact line never needs a
 * second click. Either field on its own is useful — a length alone keeps the
 * cursor's direction (point where you want it and type the distance), an angle
 * alone keeps the cursor's distance — which is why they're parsed independently
 * rather than as one required pair.
 *
 * Everything routes through {@link LineTool.endPoint} and
 * {@link LineTool.commitLine}: the preview, Enter, and the second click all
 * compute the same endpoint and build the line the same way, so what's on
 * screen is always what lands, and auto-join/H-V constraints can't apply to one
 * path and not the other.
 */

import { type Vec2, distSq } from "../core/vec2";
import { parseAngle, parseLength } from "../core/units";
import { ArcEntity, CircleEntity, LineEntity, type SnapPoint } from "../model/entities";
import {
  type Constraint,
  lineRefEntityId,
  makeConstraint,
  SEGMENT_SEP,
} from "../model/constraints";
import type { Tool, ToolContext, ToolPointerEvent, ToolOverlay } from "./tool";
import { ICONS } from "./icons";
import { isDragRelease } from "./dragDraw";
import { orthoSnap } from "../input/snapping";

export class LineTool implements Tool {
  readonly id = "line";
  readonly label = "Line";
  readonly icon = ICONS.line;

  private start: Vec2 | null = null;
  private startSnap: SnapPoint | null = null;
  /** Where the first point was pressed, for press-drag-release (see dragDraw.ts). */
  private anchorScreen: Vec2 | null = null;
  private cursor: Vec2 = { x: 0, y: 0 };
  /** Type-to-draw overrides, in mm and radians CCW from +X; null = follow the cursor. */
  private typedLen: number | null = null;
  private typedAngle: number | null = null;

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
    if (e.button !== 0) return;
    if (!this.start) {
      this.start = e.world;
      this.startSnap = e.snap;
      this.anchorScreen = e.screen;
      this.cursor = e.world;
      ctx.setHint("Click the end, or type a length and angle · Shift = ortho");
      ctx.openTypeToDraw(
        e.world,
        [{ placeholder: `Length (${ctx.doc.displayUnit})` }, { placeholder: "Angle (°)" }],
        {
          onCommit: (raws) => this.commitByText(raws, ctx),
          onCancel: () => this.cancel(ctx),
          onChange: (raws) => {
            this.readTyped(raws, ctx);
            ctx.requestRender();
          },
        },
      );
    } else {
      ctx.closeTypeToDraw();
      // A typed endpoint is already exact: snapping it (ortho or object) would
      // move it off the length or angle that was asked for.
      const typed = this.typedLen !== null || this.typedAngle !== null;
      const shifted = !typed && e.shiftKey;
      const world = typed
        ? this.endPoint(e.world)
        : shifted
          ? orthoSnap(this.start, e.world)
          : e.world;
      const endSnap = typed ? null : shifted ? resolveShiftedSnap(e.snap, world) : e.snap;
      if (!this.commitLine(world, endSnap, ctx)) {
        // Snapping can pull the second point onto the first. Refusing silently
        // reads as "my drag did nothing" — say why (see ToolContext.notify).
        ctx.notify(
          typed ? "Zero-length line." : "Both ends snapped together — zoom in or toggle snap.",
        );
      }
      this.reset(ctx);
    }
  }

  /** Release far enough from the start point = a drag; finish the line there. */
  onPointerUp(e: ToolPointerEvent, ctx: ToolContext): void {
    if (!isDragRelease(this.anchorScreen, e)) return;
    this.onPointerDown(e, ctx);
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext): void {
    this.cursor = this.start && e.shiftKey ? orthoSnap(this.start, e.world) : e.world;
    if (this.start) ctx.requestRender();
  }

  getOverlay(): ToolOverlay {
    if (!this.start) return { previews: [], selectionRect: null };
    return {
      previews: [
        { kind: "line", a: this.start, b: this.endPoint(this.cursor) },
        { kind: "point", pos: this.start },
      ],
      selectionRect: null,
    };
  }

  onKeyDown(e: KeyboardEvent, ctx: ToolContext): void {
    if (e.key === "Escape") this.cancel(ctx);
  }

  cancel(ctx: ToolContext): void {
    ctx.closeTypeToDraw();
    this.reset(ctx);
    ctx.requestRender();
  }

  /**
   * Where the line ends given the current cursor, honouring whichever
   * type-to-draw fields are filled in. The single source of truth for the
   * preview and every commit path.
   */
  private endPoint(cursorWorld: Vec2): Vec2 {
    const start = this.start;
    if (!start) return cursorWorld;
    if (this.typedLen === null && this.typedAngle === null) return cursorWorld;
    const dx = cursorWorld.x - start.x;
    const dy = cursorWorld.y - start.y;
    const dist = Math.hypot(dx, dy);
    const len = this.typedLen ?? dist;
    // With the cursor still on the start point there's no direction to keep, so
    // a bare length draws along +X rather than collapsing to nothing.
    const ang = this.typedAngle ?? (dist > 1e-9 ? Math.atan2(dy, dx) : 0);
    return { x: start.x + len * Math.cos(ang), y: start.y + len * Math.sin(ang) };
  }

  /** Parse both fields into the typed overrides; a blank or bad field is null (= follow the cursor). */
  private readTyped(raws: string[], ctx: ToolContext): void {
    const len = parseLength((raws[0] ?? "").trim(), ctx.doc.displayUnit);
    const ang = parseAngle((raws[1] ?? "").trim());
    this.typedLen = len !== null && len > 1e-6 ? len : null;
    this.typedAngle = ang;
  }

  private commitByText(raws: string[], ctx: ToolContext): boolean {
    if (!this.start) return false;
    const lenStr = (raws[0] ?? "").trim();
    const angStr = (raws[1] ?? "").trim();
    if (!lenStr && !angStr) return false;
    // Re-read rather than trust what onChange cached: a paste, or a fast typist
    // hitting Enter, can commit before an input event has fired.
    this.readTyped(raws, ctx);
    // Typed but unparseable (or a non-positive length) must not fall through to
    // "follow the cursor" — that would silently commit a line nobody asked for.
    if (lenStr && this.typedLen === null) return false;
    if (angStr && this.typedAngle === null) return false;
    if (!this.commitLine(this.endPoint(this.cursor), null, ctx)) return false;
    this.reset(ctx);
    return true;
  }

  /** Build the line and wire its constraints. Returns false when the ends coincide. */
  private commitLine(end: Vec2, endSnap: SnapPoint | null, ctx: ToolContext): boolean {
    const start = this.start;
    if (!start || distSq(start, end) <= 1e-9) return false;

    ctx.pushHistory();
    const ent = new LineEntity(start, end);
    ent.isConstruction = ctx.doc.isConstructionMode;
    ctx.doc.addSelected(ent);
    autoJoin(ctx, ent.id, "a", this.startSnap);
    autoJoin(ctx, ent.id, "b", endSnap);

    // Auto-add H/V constraints if perfectly orthogonal. A typed 0°/90° lands
    // here too: cos(π/2) is 6e-17, so the ×length product stays under the
    // tolerance for any sane line.
    if (Math.abs(start.y - end.y) < 1e-6) {
      ctx.doc.addConstraint(makeConstraint("horizontal", { entities: [ent.id] }));
    } else if (Math.abs(start.x - end.x) < 1e-6) {
      ctx.doc.addConstraint(makeConstraint("vertical", { entities: [ent.id] }));
    }

    ctx.solve();
    return true;
  }

  private reset(ctx: ToolContext): void {
    this.start = null;
    this.anchorScreen = null;
    this.startSnap = null;
    this.typedLen = null;
    this.typedAngle = null;
    ctx.setHint(null);
  }
}

/**
 * If `snap` has a point key or is on a line, add the appropriate constraint.
 *
 * A thin wrapper over {@link constraintsForSnap} so the DRAWING tools keep their
 * unconditional behaviour: a brand-new entity has full freedom, so its join
 * cannot over-constrain anything. Dragging an EXISTING point onto a snap can, so
 * SelectTool builds the same constraints and rank-checks them before adding —
 * see `tryJoinDroppedPoint` there. Both paths must derive the constraint from
 * one place or they will disagree about what a snap means.
 */
export function autoJoin(
  ctx: ToolContext,
  newEntityId: string,
  newKey: string,
  snap: SnapPoint | null,
): void {
  for (const c of constraintsForSnap(ctx, newEntityId, newKey, snap)) {
    ctx.doc.addConstraint(c);
  }
}

/** The constraints a snap implies for `(entityId, key)`, without adding them. */
export function constraintsForSnap(
  ctx: ToolContext,
  newEntityId: string,
  newKey: string,
  snap: SnapPoint | null,
): Constraint[] {
  const out: Constraint[] = [];
  const add = (c: Constraint) => out.push(c);
  buildForSnap(ctx, newEntityId, newKey, snap, add);
  return out;
}

function buildForSnap(
  ctx: ToolContext,
  newEntityId: string,
  newKey: string,
  snap: SnapPoint | null,
  emit: (c: Constraint) => void,
): void {
  if (!snap) return;
  if (snap.kind === "intersection" && snap.crossIds) {
    // A crossing is held by TWO constraints, one per entity — that is what
    // makes it an intersection rather than a coincidence of coordinates. With
    // only one the point slides along the other curve the moment anything moves.
    for (const ref of snap.crossIds) {
      // `ref` may name one EDGE of a multi-edge shape (`<id>#mid_b`, or a
      // polyline segment's start-vertex id). Resolve the owner to choose the
      // constraint, but constrain against the qualified ref, or `pointOnLine`
      // would target the whole rectangle and hold the point nowhere.
      const target = ctx.doc.entities.find((x) => x.id === lineRefEntityId(ref));
      const isEdge = ref.includes(SEGMENT_SEP);
      const type =
        isEdge || target instanceof LineEntity
          ? "pointOnLine" // an edge or segment IS a line
          : target instanceof CircleEntity
            ? "pointOnCircle"
            : target instanceof ArcEntity
              ? "pointOnArc"
              : null;
      // Anything whose crossing still cannot be named to a single curve — a
      // flattened bezier, a text outline — is skipped rather than given an
      // inert constraint.
      if (!type) continue;
      emit(
        makeConstraint(type, {
          points: [{ entityId: newEntityId, key: newKey }],
          entities: [ref],
        }),
      );
    }
    return;
  }
  if (snap.key && snap.entityId) {
    emit(
      makeConstraint("coincident", {
        points: [
          { entityId: newEntityId, key: newKey },
          { entityId: snap.entityId, key: snap.key },
        ],
      }),
    );
  } else if (snap.kind === "pointOnLine" && snap.entityId) {
    // A rectangle can't be named as a whole here: pointOnLine resolves one
    // LINE, so a bare rect id resolved to nothing and the constraint silently
    // held the point nowhere. Qualify it with the edge that was snapped to.
    const target = snap.edgeKey ? `${snap.entityId}${SEGMENT_SEP}${snap.edgeKey}` : snap.entityId;
    emit(
      makeConstraint("pointOnLine", {
        points: [{ entityId: newEntityId, key: newKey }],
        entities: [target],
      }),
    );
  }
}

export function resolveShiftedSnap(snap: SnapPoint | null, world: Vec2): SnapPoint | null {
  if (!snap) return null;
  if (distSq(snap.pos, world) <= 1e-4) return snap;
  return null;
}
