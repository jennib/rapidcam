// @vitest-environment happy-dom
import { expect, test, vi } from "vitest";
import { CamBar } from "../src/ui/camBar";
import { CADDocument } from "../src/model/document";
import { RectEntity } from "../src/model/entities";
import type { CAMOperation } from "../src/cam/types";

/**
 * `scheduleOpEstimates` posts G-code for every op whose cached run-time
 * estimate is invalid, to fill in the "⏱ ~Xm" line on its card.
 * `opTimeKey` includes `machineKind`, so a SINGLE machine-kind switch
 * invalidates EVERY op's cache entry at once. Before this fix, the whole
 * pending list was posted inside one synchronous `setTimeout` callback — on a
 * large job (a 26-cell laser material-test grid) that froze the tab for
 * minutes with no way to even navigate away. This proves estimates now post in
 * small chunks across several event-loop turns instead of one big batch.
 */

function millDoc(nOps: number): CADDocument {
  const doc = new CADDocument({ width: 300, height: 200 });
  doc.stockThickness = 10;
  const rect = doc.add(new RectEntity({ x: 0, y: 0 }, { x: 100, y: 60 }));
  for (let i = 0; i < nOps; i++) {
    const op: CAMOperation = {
      id: `op${i}`,
      name: `profile ${i}`,
      type: "profile",
      side: "outside",
      entityIds: [rect.id],
      toolType: "end-mill",
      toolNumber: 1,
      diameter: 6,
      feedrate: 1000,
      plungeRate: 300,
      spindleSpeed: 18000,
      safeZ: 5,
      depth: -3,
      stepdown: 1.5,
      stepover: 0.4,
    };
    doc.operations.push(op);
  }
  return doc;
}

test("op run-time estimates post in small chunks, not one synchronous batch", () => {
  vi.useFakeTimers();
  try {
    const doc = millDoc(7); // more than one chunk (chunk size is 3)
    const host = document.createElement("div");
    document.body.appendChild(host);
    new CamBar(host, doc);

    const filled = () =>
      [...host.querySelectorAll(".tp-op-time")].filter((e) => e.textContent !== "⏱ …").length;

    // Nothing is posted synchronously during mount — only placeholders.
    expect(filled()).toBe(0);

    // The debounce timer (150ms) fires, but only the FIRST chunk.
    vi.advanceTimersByTime(150);
    const afterFirstChunk = filled();
    expect(afterFirstChunk).toBeGreaterThan(0);
    expect(afterFirstChunk).toBeLessThan(7); // NOT everything in one pass

    // Later chunks are chained via setTimeout(...,0) — draining the timer
    // queue completes the rest across several more turns.
    vi.runAllTimers();
    expect(filled()).toBe(7);
  } finally {
    vi.useRealTimers();
  }
});
