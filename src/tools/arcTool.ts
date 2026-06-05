/** Arc tool: click centre → click start → click end (CCW arc). */

import { Vec2, dist } from "../core/vec2";
import { ArcEntity, SnapPoint } from "../model/entities";
import { makeConstraint } from "../model/constraints";
import { makeDimension } from "../model/dimensions";
import { parseLength } from "../core/units";
import { Tool, ToolContext, ToolPointerEvent, ToolOverlay } from "./tool";
import { ICONS } from "./icons";

type Phase = "center" | "start" | "end";

export class ArcTool implements Tool {
  readonly id = "arc";
  readonly label = "Arc (A)";
  readonly icon = ICONS.arc;

  private phase: Phase = "center";
  private center: Vec2 | null = null;
  private centerSnap: SnapPoint | null = null;
  private radius = 0;
  private startAngle = 0;
  private startSnap: SnapPoint | null = null;
  private cursor: Vec2 = { x: 0, y: 0 };

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
    if (e.button !== 0) return;

    if (this.phase === "center") {
      this.center = e.world;
      this.centerSnap = e.snap?.key ? e.snap : null;
      this.phase = "start";
    } else if (this.phase === "start") {
      const r = dist(this.center!, e.world);
      if (r < 1e-6) return;
      this.radius = r;
      this.startAngle = Math.atan2(e.world.y - this.center!.y, e.world.x - this.center!.x);
      this.startSnap = e.snap?.key ? e.snap : null;
      this.phase = "end";
      const unit = ctx.doc.displayUnit;
      ctx.openValueEditor(
        e.world,
        `arc length (${unit})`,
        (raw) => this.commitByLength(raw, ctx),
        () => this.cancel(ctx),
      );
    } else {
      ctx.closeValueEditor();
      this.commit(e, ctx);
    }
  }

  onPointerMove(e: ToolPointerEvent, _ctx: ToolContext): void {
    this.cursor = e.world;
  }

  getOverlay(): ToolOverlay {
    if (this.phase === "center") return { previews: [], selectionRect: null };

    const center = this.center!;
    const r = this.phase === "start"
      ? dist(center, this.cursor)
      : this.radius;

    if (this.phase === "start") {
      return {
        previews: [
          { kind: "circle", center, radius: r },
          { kind: "line", a: center, b: this.cursor },
          { kind: "point", pos: center },
        ],
        selectionRect: null,
      };
    }

    // "end" phase: show arc preview
    const endAngle = Math.atan2(this.cursor.y - center.y, this.cursor.x - center.x);
    const startPt = ptOnCircle(center, r, this.startAngle);
    const previews = [
      { kind: "point" as const, pos: center },
      { kind: "point" as const, pos: startPt },
      { kind: "line" as const, a: center, b: startPt },
      ...arcPolyline(center, r, this.startAngle, endAngle),
    ];
    return { previews, selectionRect: null };
  }

  onKeyDown(e: KeyboardEvent, ctx: ToolContext): void {
    if (e.key === "Escape") this.cancel(ctx);
  }

  cancel(ctx: ToolContext): void {
    ctx.closeValueEditor();
    this.phase = "center";
    this.center = null;
    this.centerSnap = null;
    this.startSnap = null;
    ctx.requestRender();
  }

  private commitByLength(raw: string, ctx: ToolContext): boolean {
    const len = parseLength(raw, ctx.doc.displayUnit);
    if (!len || len <= 0 || this.radius < 1e-6) return false;
    const spanRad = len / this.radius; // arc length = r * θ
    if (spanRad < 1e-4 || spanRad > 2 * Math.PI) return false;
    const endAngle = this.startAngle + spanRad;
    ctx.pushHistory();
    const arc = new ArcEntity(this.center!, this.radius, this.startAngle, endAngle);
    arc.isConstruction = ctx.doc.isConstructionMode;
    ctx.doc.addSelected(arc);
    this.addSnappedConstraints(arc, null, ctx);
    ctx.doc.addDimension(makeDimension("arclength", { entities: [arc.id], value: len, offset: 8, driving: true }));
    ctx.solve();
    this.phase = "center";
    this.center = null;
    this.centerSnap = null;
    this.startSnap = null;
    return true;
  }

  private commit(e: ToolPointerEvent, ctx: ToolContext): void {
    const endAngle = Math.atan2(e.world.y - this.center!.y, e.world.x - this.center!.x);
    const spanRad = ((endAngle - this.startAngle) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
    if (spanRad < 1e-4) return;

    ctx.pushHistory();
    const arc = new ArcEntity(this.center!, this.radius, this.startAngle, endAngle);
    arc.isConstruction = ctx.doc.isConstructionMode;
    ctx.doc.addSelected(arc);
    this.addSnappedConstraints(arc, e.snap?.key ? e.snap : null, ctx);
    ctx.solve();
    this.phase = "center";
    this.center = null;
    this.centerSnap = null;
    this.startSnap = null;
  }

  private addSnappedConstraints(arc: ArcEntity, endSnap: SnapPoint | null, ctx: ToolContext): void {
    const coin = (k1: string, snap: SnapPoint) =>
      ctx.doc.addConstraint(makeConstraint("coincident", {
        points: [{ entityId: arc.id, key: k1 }, { entityId: snap.entityId, key: snap.key! }],
      }));
    if (this.centerSnap?.key) coin("c", this.centerSnap);
    if (this.startSnap?.key) coin("start", this.startSnap);
    if (endSnap?.key) coin("end", endSnap);
  }
}

function ptOnCircle(center: Vec2, r: number, angle: number): Vec2 {
  return { x: center.x + r * Math.cos(angle), y: center.y + r * Math.sin(angle) };
}

function arcPolyline(center: Vec2, r: number, startAngle: number, endAngle: number) {
  const span = ((endAngle - startAngle) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  const N = Math.max(8, Math.ceil(span * 12));
  const pts: Vec2[] = [];
  for (let i = 0; i <= N; i++) {
    pts.push(ptOnCircle(center, r, startAngle + span * (i / N)));
  }
  return [{ kind: "polyline" as const, points: pts, closed: false }];
}
