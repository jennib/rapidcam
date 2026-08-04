/** Line tool: click start, click end. Stays active to draw more lines. */

import { type Vec2, distSq } from "../core/vec2";
import { ArcEntity, CircleEntity, LineEntity, type SnapPoint } from "../model/entities";
import { lineRefEntityId, makeConstraint, SEGMENT_SEP } from "../model/constraints";
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

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
    if (e.button !== 0) return;
    if (!this.start) {
      this.start = e.world;
      this.startSnap = e.snap;
      this.anchorScreen = e.screen;
    } else {
      const shifted = e.shiftKey;
      const world = shifted ? orthoSnap(this.start, e.world) : e.world;
      const endSnap = shifted ? resolveShiftedSnap(e.snap, world) : e.snap;
      if (distSq(this.start, world) > 1e-9) {
        ctx.pushHistory();
        const ent = new LineEntity(this.start, world);
        ent.isConstruction = ctx.doc.isConstructionMode;
        ctx.doc.addSelected(ent);
        autoJoin(ctx, ent.id, "a", this.startSnap);
        autoJoin(ctx, ent.id, "b", endSnap);

        // Auto-add H/V constraints if perfectly orthogonal
        if (Math.abs(this.start.y - world.y) < 1e-6) {
          ctx.doc.addConstraint(makeConstraint("horizontal", { entities: [ent.id] }));
        } else if (Math.abs(this.start.x - world.x) < 1e-6) {
          ctx.doc.addConstraint(makeConstraint("vertical", { entities: [ent.id] }));
        }

        ctx.solve();
      } else {
        // Snapping can pull the second point onto the first. Refusing silently
        // reads as "my drag did nothing" — say why (see ToolContext.notify).
        ctx.notify("Both ends snapped together — zoom in or toggle snap.");
      }
      this.start = null;
      this.anchorScreen = null;
      this.startSnap = null;
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
        { kind: "line", a: this.start, b: this.cursor },
        { kind: "point", pos: this.start },
      ],
      selectionRect: null,
    };
  }

  onKeyDown(e: KeyboardEvent, ctx: ToolContext): void {
    if (e.key === "Escape") this.cancel(ctx);
  }

  cancel(ctx: ToolContext): void {
    this.start = null;
    this.anchorScreen = null;
    this.startSnap = null;
    ctx.requestRender();
  }
}

/** If `snap` has a point key or is on a line, add the appropriate constraint. */
export function autoJoin(
  ctx: ToolContext,
  newEntityId: string,
  newKey: string,
  snap: SnapPoint | null,
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
      ctx.doc.addConstraint(
        makeConstraint(type, {
          points: [{ entityId: newEntityId, key: newKey }],
          entities: [ref],
        }),
      );
    }
    return;
  }
  if (snap.key && snap.entityId) {
    ctx.doc.addConstraint(
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
    ctx.doc.addConstraint(
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
