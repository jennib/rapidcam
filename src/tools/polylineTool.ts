/**
 * Polyline tool: click to add vertices.
 *   click first vertex   → close and finish
 *   Enter / double-click → finish open
 *   Backspace            → remove last vertex
 *   Escape               → cancel
 *
 * Type to Draw (see lineTool.ts) applies PER SEGMENT: after every vertex a
 * Length/Angle pair opens for the segment about to be drawn, and re-opens after
 * each one, so a whole exact profile can be entered without ever measuring a
 * click. Enter in the fields adds the vertex and asks for the next; Enter on
 * EMPTY fields finishes the polyline, which keeps the tool's existing
 * "Enter finishes" reflex intact rather than trapping it in the input.
 *
 * Angles are absolute (CCW from +X), not relative to the previous segment —
 * same convention as the line tool, and it matches how a drawing is dimensioned.
 */

import { type Vec2, distSq, dist } from "../core/vec2";
import { parseAngle, parseLength } from "../core/units";
import { PolylineEntity, type SnapPoint } from "../model/entities";
import { makeConstraint } from "../model/constraints";
import type { Tool, ToolContext, ToolPointerEvent, ToolOverlay } from "./tool";
import { ICONS } from "./icons";
import { orthoSnap } from "../input/snapping";

import { autoJoin, resolveShiftedSnap } from "./lineTool";

export class PolylineTool implements Tool {
  readonly id = "polyline";
  readonly label = "Polyline";
  readonly icon = ICONS.polyline;

  private points: Vec2[] = [];
  private snaps: (SnapPoint | null)[] = [];
  private cursor: Vec2 = { x: 0, y: 0 };
  /** Type-to-draw overrides for the segment in progress, in mm and radians CCW. */
  private typedLen: number | null = null;
  private typedAngle: number | null = null;

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
    if (e.button !== 0) return;
    const prev = this.points[this.points.length - 1];

    const typed = prev != null && (this.typedLen !== null || this.typedAngle !== null);
    const shifted = !typed && e.shiftKey && prev != null;
    // A typed endpoint is already exact; snapping it would move it off the
    // length or angle that was asked for.
    const world = typed ? this.nextPoint(e.world) : shifted ? orthoSnap(prev, e.world) : e.world;
    const snap = typed ? null : shifted ? resolveShiftedSnap(e.snap, world) : e.snap;

    if (prev && distSq(prev, world) < 1e-9) return; // ignore duplicate click

    // Clicking the first vertex closes the polyline.
    if (this.points.length >= 2 && !typed) {
      const tol = ctx.view.toWorldLen(8);
      if (dist(this.points[0], world) <= tol) {
        this.finish(ctx, true);
        return;
      }
    }
    this.addVertex(world, snap, ctx);
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext): void {
    const prev = this.points[this.points.length - 1];
    this.cursor = prev && e.shiftKey ? orthoSnap(prev, e.world) : e.world;
    if (this.points.length > 0) ctx.requestRender();
  }

  onDoubleClick(_e: ToolPointerEvent, ctx: ToolContext): void {
    this.finish(ctx, false);
  }

  onKeyDown(e: KeyboardEvent, ctx: ToolContext): void {
    if (e.key === "Enter") this.finish(ctx, false);
    else if (e.key === "Escape") this.cancel(ctx);
    else if (e.key === "Backspace") {
      this.points.pop();
      this.snaps.pop();
      ctx.requestRender();
    }
  }

  getOverlay(): ToolOverlay {
    if (this.points.length === 0) return { previews: [], selectionRect: null };
    const pts = [...this.points, this.nextPoint(this.cursor)];
    return {
      previews: [
        { kind: "polyline", points: pts, closed: false },
        ...this.points.map((p) => ({ kind: "point" as const, pos: p })),
      ],
      selectionRect: null,
    };
  }

  cancel(ctx: ToolContext): void {
    ctx.closeTypeToDraw();
    this.points = [];
    this.snaps = [];
    this.typedLen = null;
    this.typedAngle = null;
    ctx.requestRender();
  }

  /**
   * Where the segment in progress ends, honouring whichever fields are filled
   * in. Single source of truth for the preview and both commit paths.
   */
  private nextPoint(cursorWorld: Vec2): Vec2 {
    const prev = this.points[this.points.length - 1];
    if (!prev || (this.typedLen === null && this.typedAngle === null)) return cursorWorld;
    const dx = cursorWorld.x - prev.x;
    const dy = cursorWorld.y - prev.y;
    const d = Math.hypot(dx, dy);
    const len = this.typedLen ?? d;
    const ang = this.typedAngle ?? (d > 1e-9 ? Math.atan2(dy, dx) : 0);
    return { x: prev.x + len * Math.cos(ang), y: prev.y + len * Math.sin(ang) };
  }

  /** Add a vertex, then ask for the segment that will leave it. */
  private addVertex(world: Vec2, snap: SnapPoint | null, ctx: ToolContext): void {
    this.points.push(world);
    this.snaps.push(snap);
    this.armFields(world, ctx);
  }

  /** Put a fresh, empty Length/Angle pair at `at` — the vertex the next segment leaves from. */
  private armFields(at: Vec2, ctx: ToolContext): void {
    ctx.closeTypeToDraw();
    this.typedLen = null;
    this.typedAngle = null;
    ctx.setHint("Click the next vertex, or type a length and angle · Enter finishes");
    ctx.openTypeToDraw(
      at,
      [{ placeholder: `Length (${ctx.doc.displayUnit})` }, { placeholder: "Angle (°)" }],
      {
        onCommit: (raws) => this.commitByText(raws, ctx),
        onCancel: () => this.cancel(ctx),
        onChange: (raws) => {
          this.readTyped(raws, ctx);
          ctx.requestRender();
        },
        // The fields hold focus from the first vertex on, so without this the
        // tool's own Backspace — step back a vertex — would be unreachable.
        onEmptyBackspace: () => this.dropLastVertex(ctx),
      },
    );
    ctx.requestRender();
  }

  /** Step back one vertex, re-arming against the one that is now last. */
  private dropLastVertex(ctx: ToolContext): void {
    this.points.pop();
    this.snaps.pop();
    const prev = this.points[this.points.length - 1];
    if (!prev) {
      this.cancel(ctx);
      return;
    }
    this.armFields(prev, ctx);
  }

  /** Parse both fields; a blank or bad field is null (= follow the cursor). */
  private readTyped(raws: string[], ctx: ToolContext): void {
    const len = parseLength((raws[0] ?? "").trim(), ctx.doc.displayUnit);
    const ang = parseAngle((raws[1] ?? "").trim());
    this.typedLen = len !== null && len > 1e-6 ? len : null;
    this.typedAngle = ang;
  }

  private commitByText(raws: string[], ctx: ToolContext): boolean {
    const lenStr = (raws[0] ?? "").trim();
    const angStr = (raws[1] ?? "").trim();
    // Enter on empty fields means what Enter has always meant here: finish.
    // Without this the fields would swallow the tool's own finish key.
    if (!lenStr && !angStr) {
      this.finish(ctx, false);
      return true;
    }
    // Re-read rather than trust what onChange cached: a paste, or a fast typist
    // hitting Enter, can commit before an input event has fired.
    this.readTyped(raws, ctx);
    if (lenStr && this.typedLen === null) return false;
    if (angStr && this.typedAngle === null) return false;

    const next = this.nextPoint(this.cursor);
    const prev = this.points[this.points.length - 1];
    if (prev && distSq(prev, next) < 1e-9) return false;
    this.addVertex(next, null, ctx);
    return true;
  }

  private finish(ctx: ToolContext, closed: boolean): void {
    ctx.closeTypeToDraw();
    this.typedLen = null;
    this.typedAngle = null;
    const { pts, snaps } = dedupeConsecutive(this.points, this.snaps);
    if (pts.length >= 2) {
      ctx.pushHistory();
      const ent = new PolylineEntity(pts, closed);
      ent.isConstruction = ctx.doc.isConstructionMode;
      ctx.doc.addSelected(ent);
      for (let i = 0; i < snaps.length; i++) {
        autoJoin(ctx, ent.id, `v${ent.vertexIds[i]}`, snaps[i]);
      }

      // Auto-add H/V constraints to each segment if perfectly orthogonal
      const numSegs = closed ? pts.length : pts.length - 1;
      for (let i = 0; i < numSegs; i++) {
        const p1 = pts[i];
        const p2 = pts[(i + 1) % pts.length];
        const refId = `${ent.id}#${ent.vertexIds[i]}`;
        if (Math.abs(p1.y - p2.y) < 1e-6) {
          ctx.doc.addConstraint(makeConstraint("horizontal", { entities: [refId] }));
        } else if (Math.abs(p1.x - p2.x) < 1e-6) {
          ctx.doc.addConstraint(makeConstraint("vertical", { entities: [refId] }));
        }
      }

      ctx.solve();
    }
    this.points = [];
    this.snaps = [];
    ctx.requestRender();
  }
}

function dedupeConsecutive(
  points: Vec2[],
  snaps: (SnapPoint | null)[],
): { pts: Vec2[]; snaps: (SnapPoint | null)[] } {
  const pts: Vec2[] = [];
  const outSnaps: (SnapPoint | null)[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const last = pts[pts.length - 1];
    if (!last || distSq(last, p) > 1e-9) {
      pts.push(p);
      outSnaps.push(snaps[i]);
    }
  }
  return { pts, snaps: outSnaps };
}
