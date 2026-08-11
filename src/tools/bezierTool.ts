/**
 * Bezier tool — two-phase click workflow:
 *   Phase 1: click p0 (start), click p3 (end)
 *   Phase 2: click p1 (handle near start), click p2 (handle near end) → commit
 * Key: B
 *
 * Type to Draw applies to the CHORD only (p0 → p3): a Length/Angle pair opens
 * after the start point, exactly as on the line tool. The chord is a real
 * dimensioned quantity and its two ends are what `autoJoin` constrains to
 * neighbouring geometry.
 *
 * The handles deliberately get NO fields. A cubic's control arms have no
 * engineering convention behind them — no drawing calls out a handle length —
 * so a number typed there would mean nothing to the person typing it. Shape
 * stays on the mouse; the dimensioned part goes on the keyboard.
 */

import type { Vec2 } from "../core/vec2";
import { parseAngle, parseLength } from "../core/units";
import { BezierEntity, type SnapPoint } from "../model/entities";
import { makeConstraint } from "../model/constraints";
import type { PreviewShape } from "../view/overlay";
import type { Tool, ToolContext, ToolPointerEvent, ToolOverlay } from "./tool";
import { ICONS } from "./icons";

type Phase = "p0" | "p3" | "p1" | "p2";

export class BezierTool implements Tool {
  readonly id = "bezier";
  readonly label = "Bezier";
  readonly icon = ICONS.bezier;

  private phase: Phase = "p0";
  private p0: Vec2 = { x: 0, y: 0 };
  private p0Snap: SnapPoint | null = null;
  private p3: Vec2 = { x: 0, y: 0 };
  private p3Snap: SnapPoint | null = null;
  private p1: Vec2 = { x: 0, y: 0 };
  private cursor: Vec2 = { x: 0, y: 0 };
  /** Type-to-draw overrides for the chord, in mm and radians CCW from +X. */
  private typedLen: number | null = null;
  private typedAngle: number | null = null;

  onActivate(_ctx: ToolContext): void {
    this.phase = "p0";
  }

  cancel(ctx: ToolContext): void {
    ctx.closeTypeToDraw();
    this.phase = "p0";
    this.p0Snap = null;
    this.p3Snap = null;
    this.typedLen = null;
    this.typedAngle = null;
    ctx.setHint(null);
    ctx.requestRender();
  }

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
    if (e.button !== 0) return;
    const p = e.world;

    switch (this.phase) {
      case "p0":
        this.p0 = p;
        this.p0Snap = e.snap?.key ? e.snap : null;
        this.cursor = p;
        this.phase = "p3";
        ctx.setHint("Click the end point, or type the chord's length and angle");
        ctx.openTypeToDraw(
          p,
          [{ placeholder: `Length (${ctx.doc.displayUnit})` }, { placeholder: "Angle (°)" }],
          {
            onCommit: (raws) => this.commitChordByText(raws, ctx),
            onCancel: () => this.cancel(ctx),
            onChange: (raws) => {
              this.readTyped(raws, ctx);
              ctx.requestRender();
            },
          },
        );
        break;

      case "p3": {
        // A typed chord end is already exact — take it over the click position,
        // which is also what the preview has been showing.
        const typed = this.typedLen !== null || this.typedAngle !== null;
        this.setChordEnd(typed ? this.chordEnd(p) : p, typed ? null : (e.snap?.key ? e.snap : null), ctx);
        break;
      }

      case "p1":
        this.p1 = p;
        this.cursor = p;
        this.phase = "p2";
        break;

      case "p2": {
        const p2 = p;
        ctx.pushHistory();
        const ent = new BezierEntity(this.p0, this.p1, p2, this.p3);
        ent.isConstruction = ctx.doc.isConstructionMode;
        ctx.doc.addSelected(ent);
        autoJoin(ctx, ent.id, "p0", this.p0Snap);
        autoJoin(ctx, ent.id, "p3", this.p3Snap);
        ctx.solve();
        this.phase = "p0";
        this.p0Snap = null;
        this.p3Snap = null;
        ctx.setHint(null);
        break;
      }
    }

    ctx.requestRender();
  }

  /** Where the chord ends, honouring whichever fields are filled in. */
  private chordEnd(cursorWorld: Vec2): Vec2 {
    if (this.phase !== "p3" || (this.typedLen === null && this.typedAngle === null)) {
      return cursorWorld;
    }
    const dx = cursorWorld.x - this.p0.x;
    const dy = cursorWorld.y - this.p0.y;
    const d = Math.hypot(dx, dy);
    const len = this.typedLen ?? d;
    const ang = this.typedAngle ?? (d > 1e-9 ? Math.atan2(dy, dx) : 0);
    return { x: this.p0.x + len * Math.cos(ang), y: this.p0.y + len * Math.sin(ang) };
  }

  /** Lock in the chord's far end and move on to the handles. */
  private setChordEnd(p: Vec2, snap: SnapPoint | null, ctx: ToolContext): void {
    ctx.closeTypeToDraw();
    this.p3 = p;
    this.p3Snap = snap;
    this.cursor = p;
    this.phase = "p1";
    this.typedLen = null;
    this.typedAngle = null;
    // Handles are mouse-only by design — see the file header.
    ctx.setHint("Click the two curve handles");
  }

  private readTyped(raws: string[], ctx: ToolContext): void {
    const len = parseLength((raws[0] ?? "").trim(), ctx.doc.displayUnit);
    const ang = parseAngle((raws[1] ?? "").trim());
    this.typedLen = len !== null && len > 1e-6 ? len : null;
    this.typedAngle = ang;
  }

  private commitChordByText(raws: string[], ctx: ToolContext): boolean {
    const lenStr = (raws[0] ?? "").trim();
    const angStr = (raws[1] ?? "").trim();
    if (!lenStr && !angStr) return false;
    // Re-read rather than trust what onChange cached: a paste, or a fast typist
    // hitting Enter, can commit before an input event has fired.
    this.readTyped(raws, ctx);
    if (lenStr && this.typedLen === null) return false;
    if (angStr && this.typedAngle === null) return false;

    const end = this.chordEnd(this.cursor);
    const dx = end.x - this.p0.x;
    const dy = end.y - this.p0.y;
    if (dx * dx + dy * dy < 1e-9) return false;
    this.setChordEnd(end, null, ctx);
    ctx.requestRender();
    return true;
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext): void {
    this.cursor = e.world;
    if (this.phase !== "p0") ctx.requestRender();
  }

  getOverlay(): ToolOverlay {
    const previews: PreviewShape[] = [];

    switch (this.phase) {
      case "p0":
        break;

      case "p3":
        // Chord from p0 to the cursor — or to the typed end, when there is one.
        previews.push({ kind: "line", a: this.p0, b: this.chordEnd(this.cursor) });
        previews.push({ kind: "point", pos: this.p0 });
        break;

      case "p1":
        // Curve with p1=cursor, p2=p3 (degenerate — shows one handle active)
        previews.push({ kind: "bezier", p0: this.p0, p1: this.cursor, p2: this.p3, p3: this.p3 });
        // First control arm
        previews.push({ kind: "line", a: this.p0, b: this.cursor });
        previews.push({ kind: "point", pos: this.p0 });
        previews.push({ kind: "point", pos: this.p3 });
        break;

      case "p2":
        // Curve with p1 fixed, p2=cursor
        previews.push({ kind: "bezier", p0: this.p0, p1: this.p1, p2: this.cursor, p3: this.p3 });
        // Both control arms
        previews.push({ kind: "line", a: this.p0, b: this.p1 });
        previews.push({ kind: "line", a: this.p3, b: this.cursor });
        previews.push({ kind: "point", pos: this.p0 });
        previews.push({ kind: "point", pos: this.p3 });
        break;
    }

    return { previews, selectionRect: null };
  }

  onKeyDown(e: KeyboardEvent, ctx: ToolContext): void {
    if (e.key === "Escape") this.cancel(ctx);
  }
}

function autoJoin(
  ctx: ToolContext,
  newEntityId: string,
  newKey: string,
  snap: SnapPoint | null,
): void {
  if (!snap?.key) return;
  ctx.doc.addConstraint(
    makeConstraint("coincident", {
      points: [
        { entityId: newEntityId, key: newKey },
        { entityId: snap.entityId, key: snap.key },
      ],
    }),
  );
}
