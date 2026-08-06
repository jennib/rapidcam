/**
 * Toolpath Canvas Highlighter.
 * Resolves closed loops and region fills to highlight active operations in the 2D canvas view.
 */
import type { CADDocument } from "../../model/document";
import type { Vec2 } from "../../core/vec2";
import { collectClosedLoops } from "../../cam/loops";
import { resolveRegion } from "../../cam/regions";
import { TP_PALETTE } from "./opItemBuilder";

export class CamHighlighter {
  private highlightedOpId: string | null = null;

  constructor(private doc: CADDocument) {}

  get currentId(): string | null {
    return this.highlightedOpId;
  }

  highlightOp(id: string | null): void {
    this.highlightedOpId = id;
    const opIndex = id ? this.doc.operations.findIndex((o) => o.id === id) : -1;
    const op = opIndex >= 0 ? this.doc.operations[opIndex] : null;
    this.doc.toolpathHighlightColor = op ? TP_PALETTE[opIndex % TP_PALETTE.length] : null;
    if (op?.regions?.length) {
      const loops = collectClosedLoops(this.doc.entities);
      const highlight = new Set<string>();
      const fills: Vec2[][][] = [];
      for (const ref of op.regions) {
        const region = resolveRegion(ref, loops);
        if (!region) continue;
        for (const lid of region.loopIds) highlight.add(lid);
        fills.push([region.outer, ...region.holes]);
      }
      this.doc.toolpathHighlightIds = highlight;
      this.doc.regionPickFills = fills;
    } else {
      this.doc.toolpathHighlightIds = op ? new Set(op.entityIds) : null;
      this.doc.regionPickFills = null;
    }
    this.doc.emitChange();
  }
}
