/** Slot tool: click first centre → click second centre → drag or type width. */

import { Vec2, dist, sub, add, scale, normalize, dot, perp } from "../core/vec2";
import { ArcEntity, LineEntity, SnapPoint } from "../model/entities";
import { makeConstraint } from "../model/constraints";
import { parseLength } from "../core/units";
import { Tool, ToolContext, ToolPointerEvent, ToolOverlay } from "./tool";
import { ICONS } from "./icons";

type Phase = "first" | "second" | "radius";

export class SlotTool implements Tool {
  readonly id = "slot";
  readonly label = "Slot (U)";
  readonly icon = ICONS.slot;

  private phase: Phase = "first";
  private c1: Vec2 | null = null;
  private c1Snap: SnapPoint | null = null;
  private c2: Vec2 | null = null;
  private c2Snap: SnapPoint | null = null;
  private cursor: Vec2 = { x: 0, y: 0 };

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
    if (e.button !== 0) return;

    if (this.phase === "first") {
      this.c1 = e.world;
      this.c1Snap = e.snap?.key ? e.snap : null;
      this.phase = "second";
    } else if (this.phase === "second") {
      if (dist(this.c1!, e.world) < 1e-6) return;
      this.c2 = e.world;
      this.c2Snap = e.snap?.key ? e.snap : null;
      this.phase = "radius";
      ctx.openValueEditor(
        e.world,
        `slot width (${ctx.doc.displayUnit})`,
        (raw) => this.commitByWidth(raw, ctx),
        () => this.cancel(ctx),
      );
    } else {
      ctx.closeValueEditor();
      const r = this.cursorRadius();
      if (r < 1e-6) return;
      this.createSlot(this.c1!, this.c2!, r, ctx);
    }
  }

  onPointerMove(e: ToolPointerEvent, _ctx: ToolContext): void {
    this.cursor = e.world;
  }

  getOverlay(): ToolOverlay {
    if (this.phase === "first") return { previews: [], selectionRect: null };

    const c1 = this.c1!;

    if (this.phase === "second") {
      return {
        previews: [
          { kind: "point", pos: c1 },
          { kind: "line", a: c1, b: this.cursor },
        ],
        selectionRect: null,
      };
    }

    // "radius" phase — show slot preview
    const c2 = this.c2!;
    const d = dist(c1, c2);
    if (d < 1e-6) return { previews: [], selectionRect: null };

    const r = this.cursorRadius();
    if (r < 1e-6) return { previews: [{ kind: "point", pos: c1 }, { kind: "point", pos: c2 }], selectionRect: null };

    return { previews: slotPreviews(c1, c2, r), selectionRect: null };
  }

  onKeyDown(e: KeyboardEvent, ctx: ToolContext): void {
    if (e.key === "Escape") this.cancel(ctx);
  }

  cancel(ctx: ToolContext): void {
    ctx.closeValueEditor();
    this.reset();
    ctx.requestRender();
  }

  private cursorRadius(): number {
    if (!this.c1 || !this.c2) return 0;
    const D = normalize(sub(this.c2, this.c1));
    const P = perp(D);
    return Math.abs(dot(sub(this.cursor, this.c1), P));
  }

  private commitByWidth(raw: string, ctx: ToolContext): boolean {
    const w = parseLength(raw, ctx.doc.displayUnit);
    if (!w || w <= 0) return false;
    this.createSlot(this.c1!, this.c2!, w / 2, ctx);
    return true;
  }

  private createSlot(c1: Vec2, c2: Vec2, r: number, ctx: ToolContext): void {
    const D = normalize(sub(c2, c1));
    const P = perp(D); // 90° CCW from the slot axis
    const angleP    = Math.atan2(P.y, P.x);
    const angleNegP = Math.atan2(-P.y, -P.x);

    // Each cap is a 180° arc. Arc angles are CCW (standard math convention).
    // Arc 1 at C1: CCW from angle(P) → angle(-P), sweeping through -D (outer cap).
    const arc1 = new ArcEntity(c1, r, angleP, angleNegP);
    // Arc 2 at C2: CCW from angle(-P) → angle(P), sweeping through +D (outer cap).
    const arc2 = new ArcEntity(c2, r, angleNegP, angleP);

    // Parallel straight sides
    const lineTop = new LineEntity(add(c1, scale(P,  r)), add(c2, scale(P,  r)));
    const lineBot = new LineEntity(add(c1, scale(P, -r)), add(c2, scale(P, -r)));

    ctx.pushHistory();
    for (const e of [arc1, arc2, lineTop, lineBot]) {
      e.isConstruction = ctx.doc.isConstructionMode;
      ctx.doc.add(e);
    }

    const coin = (eid1: string, k1: string, eid2: string, k2: string) =>
      ctx.doc.addConstraint(makeConstraint("coincident", {
        points: [{ entityId: eid1, key: k1 }, { entityId: eid2, key: k2 }],
      }));

    // Arc endpoints ↔ line endpoints at the four junctions
    coin(arc1.id, "start", lineTop.id, "a"); // C1 top
    coin(arc2.id, "end",   lineTop.id, "b"); // C2 top
    coin(arc1.id, "end",   lineBot.id, "a"); // C1 bottom
    coin(arc2.id, "start", lineBot.id, "b"); // C2 bottom

    ctx.doc.addConstraint(makeConstraint("equal",    { entities: [arc1.id, arc2.id] }));
    ctx.doc.addConstraint(makeConstraint("parallel", { entities: [lineTop.id, lineBot.id] }));

    // Snap centres to existing geometry
    const c1Snap = this.c1Snap;
    const c2Snap = this.c2Snap;
    if (c1Snap?.key) coin(arc1.id, "c", c1Snap.entityId, c1Snap.key);
    if (c2Snap?.key) coin(arc2.id, "c", c2Snap.entityId, c2Snap.key);

    ctx.solve();
    this.reset();
  }

  private reset(): void {
    this.phase = "first";
    this.c1 = null;
    this.c1Snap = null;
    this.c2 = null;
    this.c2Snap = null;
  }
}

function slotPreviews(c1: Vec2, c2: Vec2, r: number): ToolOverlay["previews"] {
  const D = normalize(sub(c2, c1));
  const P = perp(D);
  const aP  = Math.atan2(P.y, P.x);
  const aNP = Math.atan2(-P.y, -P.x);
  return [
    { kind: "arc",  center: c1, radius: r, startAngle: aP,  endAngle: aNP },
    { kind: "arc",  center: c2, radius: r, startAngle: aNP, endAngle: aP  },
    { kind: "line", a: add(c1, scale(P,  r)), b: add(c2, scale(P,  r)) },
    { kind: "line", a: add(c1, scale(P, -r)), b: add(c2, scale(P, -r)) },
    { kind: "point", pos: c1 },
    { kind: "point", pos: c2 },
  ];
}
