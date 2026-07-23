/**
 * Polygon tool: click centre → drag or type radius to place a regular n-gon.
 * [ / ] keys change the number of sides (min 3, max 64).
 */

import { type Vec2, dist, sub, angle as vecAngle } from "../core/vec2";
import { PolylineEntity } from "../model/entities";
import { regularPolygonPoints } from "../core/geom";
import { parseLength } from "../core/units";
import type { Tool, ToolContext, ToolPointerEvent, ToolOverlay } from "./tool";
import { ICONS } from "./icons";

type Phase = "center" | "radius";

export class PolygonTool implements Tool {
  readonly id = "polygon";
  readonly label = "Polygon";
  readonly icon = ICONS.polygon;

  private phase: Phase = "center";
  private center: Vec2 | null = null;
  private sides = 6;
  private cursor: Vec2 = { x: 0, y: 0 };

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext): void {
    if (e.button !== 0) return;

    if (this.phase === "center") {
      this.center = e.world;
      this.phase = "radius";
      ctx.openMultiValueEditor(
        e.world,
        [
          { placeholder: "Sides", initial: this.sides.toString() },
          { placeholder: `Ø (${ctx.doc.displayUnit})` }
        ],
        (raws) => this.commitByText(raws, ctx),
        () => this.cancel(ctx),
        (raws) => {
          const n = parseInt(raws[0].trim(), 10);
          if (Number.isFinite(n) && n >= 3 && n <= 64) {
            this.sides = n;
            ctx.requestRender();
          }
        }
      );
    } else {
      ctx.closeValueEditor();
      const r = dist(this.center!, e.world);
      if (r < 1e-6) return;
      this.commit(r, vecAngle(sub(e.world, this.center!)), ctx);
    }
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext): void {
    this.cursor = e.world;
    if (this.phase !== "center") ctx.requestRender();
  }

  getOverlay(): ToolOverlay {
    const hint = `${this.sides} sides  ([ / ] or type N×Ø)`;

    if (this.phase === "center") {
      return { previews: [], selectionRect: null };
    }

    const center = this.center!;
    const r = dist(center, this.cursor);
    if (r < 1e-6) return { previews: [{ kind: "point", pos: center }], selectionRect: null };

    const startAngle = vecAngle(sub(this.cursor, center));
    const pts = regularPolygonPoints(center, r, this.sides, startAngle);

    return {
      previews: [
        { kind: "polyline", points: pts, closed: true },
        { kind: "point", pos: center },
        { kind: "text", pos: this.cursor, text: hint },
      ],
      selectionRect: null,
    };
  }

  onKeyDown(e: KeyboardEvent, ctx: ToolContext): void {
    if (e.key === "Escape") {
      this.cancel(ctx);
    } else if (e.key === "[") {
      this.sides = Math.max(3, this.sides - 1);
      ctx.requestRender();
    } else if (e.key === "]") {
      this.sides = Math.min(64, this.sides + 1);
      ctx.requestRender();
    }
  }

  cancel(ctx: ToolContext): void {
    ctx.closeValueEditor();
    this.reset();
    ctx.requestRender();
  }

  /**
   * Parse the multi-value editor. Receives [sidesStr, diaStr].
   * Diameter is across-flats (inscribed-circle Ø), the machinist convention, so
   * the circumradius is (D/2) / cos(π/n).
   */
  private commitByText(raws: string[], ctx: ToolContext): boolean {
    if (raws.length !== 2) return false;

    const sidesStr = raws[0].trim();
    const diaStr = raws[1].trim();

    if (!diaStr) return false;

    if (sidesStr) {
      const n = parseInt(sidesStr, 10);
      if (!Number.isFinite(n) || n < 3 || n > 64) return false;
      this.sides = n;
    }

    const d = parseLength(diaStr, ctx.doc.displayUnit);
    if (!d || d <= 0) return false;
    const r = d / 2 / Math.cos(Math.PI / this.sides);

    const startAngle =
      this.center && dist(this.center, this.cursor) > 1e-6
        ? vecAngle(sub(this.cursor, this.center))
        : 0;
    this.commit(r, startAngle, ctx);
    return true;
  }

  private commit(r: number, startAngle: number, ctx: ToolContext): void {
    const center = this.center!;
    const pts = regularPolygonPoints(center, r, this.sides, startAngle);
    ctx.pushHistory();
    const ent = new PolylineEntity(pts, true);
    ent.isConstruction = ctx.doc.isConstructionMode;
    // Remember the construction params so the polygon stays editable by
    // sides / across-flats Ø until a vertex is hand-edited (see propertiesBar).
    ent.polygon = { sides: this.sides, center: { ...center }, radius: r, rotation: startAngle };
    ctx.doc.addSelected(ent);
    ctx.solve();
    this.reset();
  }

  private reset(): void {
    this.phase = "center";
    this.center = null;
  }
}
