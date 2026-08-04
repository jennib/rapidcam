import { describe, expect, test } from "vitest";
import { type SolveResult, solveConverged, solveFailureEvent } from "../src/solver/solver";

/**
 * Covers the solve-failure analytics decision.
 *
 * The point of this event is that a failed solve is otherwise invisible after
 * the fact — the user sees red geometry, fixes or undoes it, and nothing records
 * that it happened. Two ways to get that wrong, both tested here:
 *
 *  - **Firing level-triggered.** A broken sketch re-solves on every subsequent
 *    edit. Reporting each one would bury the moment it broke under a keystroke's
 *    worth of duplicates.
 *  - **Calling an unconstrained sketch a failure.** A fresh sketch has nothing
 *    to converge, so `converged: false` on it is normal, not a fault.
 *
 * The payload is asserted to be counts only. Geometry must never reach an
 * analytics event.
 */

function result(over: Partial<SolveResult> = {}): SolveResult {
  return {
    hasConstraints: true,
    converged: true,
    residualNorm: 0,
    dof: 0,
    variables: 10,
    equations: 10,
    ...over,
  };
}

const COUNTS = { entities: 4, constraints: 6, dimensions: 2 };
const broke = result({ converged: false, residualNorm: 0.42, dof: 3 });

describe("solveConverged", () => {
  test("a constrained sketch that satisfied its constraints is healthy", () => {
    expect(solveConverged(result())).toBe(true);
  });

  test("a constrained sketch that failed is not", () => {
    expect(solveConverged(result({ converged: false }))).toBe(false);
  });

  test("an unconstrained sketch is healthy regardless of the converged flag", () => {
    // A fresh canvas has no constraints to satisfy — reporting it as a failure
    // would fire on every new document.
    expect(solveConverged(result({ hasConstraints: false, converged: false }))).toBe(true);
  });
});

describe("solveFailureEvent", () => {
  test("reports the transition from solving to not solving", () => {
    expect(solveFailureEvent(broke, true, COUNTS)).not.toBeNull();
  });

  test("stays silent while the sketch remains broken", () => {
    // The edit AFTER the break re-solves and still fails; that is not news.
    expect(solveFailureEvent(broke, false, COUNTS)).toBeNull();
  });

  test("stays silent while the sketch keeps solving", () => {
    expect(solveFailureEvent(result(), true, COUNTS)).toBeNull();
  });

  test("re-arms after a fix, so a second break is reported", () => {
    // Simulate the real bookkeeping App does: break, stay broken, fix, break.
    let prev = true;
    const seen: boolean[] = [];
    for (const res of [broke, broke, result(), broke]) {
      seen.push(solveFailureEvent(res, prev, COUNTS) !== null);
      prev = solveConverged(res);
    }
    expect(seen).toEqual([true, false, false, true]);
  });

  test("an unconstrained sketch never reports", () => {
    const fresh = result({ hasConstraints: false, converged: false });
    expect(solveFailureEvent(fresh, true, COUNTS)).toBeNull();
  });

  test("carries the solver numbers and object counts", () => {
    expect(solveFailureEvent(broke, true, COUNTS)).toEqual({
      residual_norm: 0.42,
      dof: 3,
      variables: 10,
      equations: 10,
      entities: 4,
      constraints: 6,
      dimensions: 2,
    });
  });

  test("carries nothing but numbers", () => {
    // Guards against a future field leaking geometry, a name or an expression
    // into an analytics payload.
    const payload = solveFailureEvent(broke, true, COUNTS);
    expect(payload).not.toBeNull();
    for (const v of Object.values(payload!)) expect(typeof v).toBe("number");
  });
});
