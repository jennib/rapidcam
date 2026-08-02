import { describe, it, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { SnapEngine } from "../src/input/snapping";
import { autoJoin } from "../src/tools/lineTool";
import { Viewport } from "../src/view/viewport";

describe("Stock Edge Snap & AutoJoin Test", () => {
  it("snaps to stock edge and creates pointOnLine constraint on line end", () => {
    const doc = new CADDocument({ width: 300, height: 250 });
    doc.stockRect = { x: 50, y: 50, width: 200, height: 150 };

    const snapEngine = new SnapEngine();
    const view = new Viewport();
    view.setSize(800, 600);

    // Screen position corresponding to world { x: 50, y: 100 } (on left stock edge)
    const screenOnStockLeft = view.worldToScreen({ x: 50, y: 100 });

    const snapRes = snapEngine.resolve(screenOnStockLeft, view, doc);
    expect(snapRes.snap).not.toBeNull();
    expect(snapRes.snap?.kind).toBe("pointOnLine");
    expect(snapRes.snap?.entityId).toBe("__stock__");
    expect(snapRes.snap?.edgeKey).toBe("mid_l");

    const mockCtx: any = {
      doc,
      pushHistory: () => {},
    };

    autoJoin(mockCtx, "line1", "b", snapRes.snap);

    const polCon = doc.constraints.find(
      (c) =>
        c.type === "pointOnLine" &&
        c.points.some((p) => p.entityId === "line1" && p.key === "b") &&
        c.entities.includes("__stock__#mid_l"),
    );
    expect(polCon).toBeDefined();
  });
});
