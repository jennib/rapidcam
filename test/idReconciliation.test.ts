import { test, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { nextId } from "../src/model/ids";

// Regression guard: restore() must reconcile the id counters for every
// nextId-generated collection, so creating a new operation/layer/binding after
// loading a file never reuses an id the loaded document already carries. (The
// counters are module-global and monotonic; without reconcile, a fresh session
// opening a file with "cam3" would hand the next operation "cam1" again.)
//
// Large base numbers keep the assertion deterministic: no other test in this
// worker advances these prefixes anywhere near 900000, so the reconcile is the
// only thing that can move the counter that high.
test("restore() reconciles id counters for operations, layers and bindings", () => {
  const doc = new CADDocument({ width: 100, height: 100 });
  const snap = doc.snapshot();

  snap.operations = [{ id: "cam900001", name: "cut", entityIds: [] } as never];
  snap.layers = [{ id: "layer900001", name: "Loaded", color: "#ffffff", visible: true, locked: false }];
  snap.bindings = [{ id: "bind900001", entityId: "ignored", scalarKey: "r", expr: "1" } as never];

  doc.restore(snap);

  // Each counter was raised to the loaded id's number, so the next allocation
  // is one past it — not a collision with the loaded "…900001".
  expect(nextId("cam")).toBe("cam900002");
  expect(nextId("layer")).toBe("layer900002");
  expect(nextId("bind")).toBe("bind900002");
});

// Tools are deliberately NOT reconciled (see restore()'s comment): their ids are
// `builtin-*` or `tool-<timestamp>`, never nextId-generated, so there is no
// counter to raise and no collision to prevent. Guard that nextId has no "tool"
// family to collide with — a tool added next still gets its timestamp id.
test("tool ids do not participate in nextId counters", () => {
  const doc = new CADDocument({ width: 100, height: 100 });
  const snap = doc.snapshot();
  snap.tools = [{ id: "tool-1718000000000", name: "6mm", toolType: "end-mill", diameter: 6 } as never];
  doc.restore(snap);

  // No "tool" counter exists, and nextId("tool") starts from 1 — proving tool
  // ids never flow through nextId and so can't collide with loaded ones.
  expect(nextId("tool")).toBe("tool1");
});
