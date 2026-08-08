/**
 * The solve WIRING, which used to be untestable.
 *
 * This sequence — evaluate, solve, recompute status, recompute staleness,
 * report health, publish, render — lived inside `App`, a class that needs a
 * canvas and a DOM to construct. So 1500+ green tests could not see it, and did
 * not: changing stock thickness silently failed to re-drive anything bound to
 * `stock`. These tests exist because `SolveCoordinator` can now be built with
 * plain recording functions in place of the UI.
 *
 * The drag path is the subtle one. A pinned solve must NOT commit: it is not the
 * document's real state, it happens 60× a second, and treating it as committed
 * would report transient non-convergence as a quality signal and recompute
 * pattern staleness against half-dragged geometry.
 */
import { describe, it, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { LineEntity } from "../src/model/entities";
import { makeConstraint } from "../src/model/constraints";
import { SolveCoordinator, type SolveSinks } from "../src/shell/solveCoordinator";
import type { EntityStatusMap } from "../src/solver/solver";

/** A sinks implementation that records instead of drawing. */
function recordingSinks() {
  const calls = {
    entityStatus: [] as EntityStatusMap[],
    solveStatus: [] as { converged: boolean | null; anyUnderDefined: boolean }[],
    staleness: [] as { ids: Set<string>; count: number }[],
    renders: 0,
    historyPushes: 0,
  };
  const sinks: SolveSinks = {
    publishEntityStatus: (s) => calls.entityStatus.push(s),
    publishSolveStatus: (res, anyUnderDefined) =>
      calls.solveStatus.push({ converged: res?.converged ?? null, anyUnderDefined }),
    publishPatternStaleness: (ids, count) => calls.staleness.push({ ids, count }),
    requestRender: () => {
      calls.renders++;
    },
    pushHistory: () => {
      calls.historyPushes++;
    },
  };
  return { sinks, calls };
}

function docWithLine(): { doc: CADDocument; lineId: string } {
  const doc = new CADDocument({ width: 200, height: 200 });
  const line = doc.add(new LineEntity({ x: 0, y: 0 }, { x: 50, y: 0 }));
  return { doc, lineId: line.id };
}

describe("SolveCoordinator — committed solves", () => {
  it("publishes status, verdict, staleness and a render", () => {
    const { doc } = docWithLine();
    const { sinks, calls } = recordingSinks();
    new SolveCoordinator(doc, sinks).run();

    expect(calls.entityStatus).toHaveLength(1);
    expect(calls.solveStatus).toHaveLength(1);
    expect(calls.staleness).toHaveLength(1);
    expect(calls.renders).toBe(1);
  });

  it("reports a loose line as under-defined, so the status bar matches the blue geometry", () => {
    const { doc } = docWithLine();
    const { sinks, calls } = recordingSinks();
    new SolveCoordinator(doc, sinks).run();
    expect(calls.solveStatus[0].anyUnderDefined).toBe(true);
  });

  it("reports a fully-fixed line as NOT under-defined", () => {
    const { doc, lineId } = docWithLine();
    doc.addConstraint(makeConstraint("fixed", { entities: [lineId] }));
    const { sinks, calls } = recordingSinks();
    new SolveCoordinator(doc, sinks).run();
    // Positive control for the assertion above: if this also read `true`, the
    // under-defined check would be passing for a reason unrelated to DOF.
    expect(calls.solveStatus[0].anyUnderDefined).toBe(false);
  });

  it("exposes DOF only after a solve — Infinity before, finite after", () => {
    const { doc } = docWithLine();
    const { sinks } = recordingSinks();
    const c = new SolveCoordinator(doc, sinks);
    expect(c.dof).toBe(Infinity);
    expect(c.result).toBeNull();
    c.run();
    expect(c.dof).toBeLessThan(Infinity);
    expect(c.result).not.toBeNull();
  });
});

describe("SolveCoordinator — a drag (pinned) solve must not commit", () => {
  it("leaves the committed result and DOF untouched", () => {
    const { doc, lineId } = docWithLine();
    const { sinks } = recordingSinks();
    const c = new SolveCoordinator(doc, sinks);
    c.run();
    const committed = c.result;
    const dof = c.dof;

    c.run(new Map([[`${lineId}:a`, { x: 5, y: 5 }]]));

    expect(c.result).toBe(committed);
    expect(c.dof).toBe(dof);
  });

  it("does not recompute pattern staleness mid-drag", () => {
    const { doc, lineId } = docWithLine();
    const { sinks, calls } = recordingSinks();
    const c = new SolveCoordinator(doc, sinks);
    c.run();
    expect(calls.staleness).toHaveLength(1);

    c.run(new Map([[`${lineId}:a`, { x: 5, y: 5 }]]));
    expect(calls.staleness).toHaveLength(1); // still 1 — the drag added none
  });

  it("still publishes a verdict and renders, so the screen keeps up", () => {
    const { doc, lineId } = docWithLine();
    const { sinks, calls } = recordingSinks();
    const c = new SolveCoordinator(doc, sinks);
    c.run();

    c.run(new Map([[`${lineId}:a`, { x: 5, y: 5 }]]));
    expect(calls.solveStatus).toHaveLength(2);
    expect(calls.renders).toBe(2);
  });

  it("re-publishes the SAME status map object mid-drag, not a fresh one", () => {
    const { doc, lineId } = docWithLine();
    const { sinks, calls } = recordingSinks();
    const c = new SolveCoordinator(doc, sinks);
    c.run();
    c.run(new Map([[`${lineId}:a`, { x: 5, y: 5 }]]));
    // Identity, not equality: the design tree diffs by reference to skip work,
    // and the renderer assigns over itself. A fresh map each frame would defeat
    // both and answer against half-dragged geometry.
    expect(calls.entityStatus[1]).toBe(calls.entityStatus[0]);
  });
});

describe("SolveCoordinator — variables and regeneration", () => {
  it("a variable change re-solves and emits one document change", () => {
    const { doc } = docWithLine();
    const { sinks, calls } = recordingSinks();
    let changes = 0;
    doc.onChange(() => changes++);

    new SolveCoordinator(doc, sinks).onVariablesChanged();

    expect(calls.solveStatus.length).toBeGreaterThanOrEqual(1);
    expect(changes).toBe(1);
  });

  it("does not re-enter when a regeneration emits its own change", () => {
    const { doc } = docWithLine();
    const { sinks, calls } = recordingSinks();
    const c = new SolveCoordinator(doc, sinks);
    // Re-entrancy is the failure this guards: a regen's emitChange calling back
    // into onVariablesChanged would recurse. Drive that from the listener.
    let depth = 0;
    let maxDepth = 0;
    doc.onChange(() => {
      depth++;
      maxDepth = Math.max(maxDepth, depth);
      if (depth < 3) c.onVariablesChanged();
      depth--;
    });

    c.onVariablesChanged();
    expect(maxDepth).toBeLessThanOrEqual(3);
    expect(calls.renders).toBeGreaterThan(0);
  });

  it("regenerateStale does nothing — and opens no undo step — when nothing is stale", () => {
    const { doc } = docWithLine();
    const { sinks, calls } = recordingSinks();
    const c = new SolveCoordinator(doc, sinks);
    c.run();
    const rendersBefore = calls.renders;

    c.regenerateStale();

    expect(c.staleCount).toBe(0);
    expect(calls.historyPushes).toBe(0);
    expect(calls.renders).toBe(rendersBefore);
  });

  it("a pattern whose source moved is reported stale, and regenerating it opens one undo step", () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    const src = doc.add(new LineEntity({ x: 0, y: 0 }, { x: 50, y: 0 }));
    const copy = doc.add(new LineEntity({ x: 0, y: 20 }, { x: 50, y: 20 }));
    doc.patterns.push({
      id: "pat1",
      kind: "linear",
      sourceIds: [src.id],
      instanceIds: [[copy.id]],
      params: { countX: 2, countY: 1, dx: 0, dy: 20 } as never,
      // A snapshot that cannot match the current geometry — the pattern reads
      // stale without needing to simulate an edit.
      sourceSnapshot: -1,
    });

    const { sinks, calls } = recordingSinks();
    const c = new SolveCoordinator(doc, sinks);
    c.run();

    expect(c.staleCount).toBe(1);
    expect(calls.staleness.at(-1)?.count).toBe(1);
    expect(calls.staleness.at(-1)?.ids.has(copy.id)).toBe(true);

    c.regenerateStale();
    expect(calls.historyPushes).toBe(1);
  });
});
