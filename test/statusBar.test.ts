import { describe, it, expect } from "vitest";
import { solveStatusLabel } from "../src/ui/statusBar";
import type { SolveResult } from "../src/solver/solver";

const res = (o: Partial<SolveResult>): SolveResult => ({
  hasConstraints: true,
  converged: true,
  residualNorm: 0,
  dof: 0,
  variables: 0,
  equations: 0,
  ...o,
});

describe("solveStatusLabel", () => {
  it("shows nothing for an unconstrained sketch (no definedness to report)", () => {
    expect(solveStatusLabel(null)).toBeNull();
    expect(solveStatusLabel(res({ hasConstraints: false, dof: 8 }))).toBeNull();
  });

  it("reads 'Fully constrained' at DOF 0", () => {
    const l = solveStatusLabel(res({ dof: 0 }))!;
    expect(l.html).toContain("Fully constrained");
    expect(l.tooltip).toMatch(/locked/i);
  });

  it("names the under-constrained state in plain language, not a bare DOF number", () => {
    const l = solveStatusLabel(res({ dof: 5 }))!;
    expect(l.html).toContain("Under-constrained");
    expect(l.html).toContain("5");
    // The tooltip must explain what DOF means and that geometry can move.
    expect(l.tooltip).toMatch(/degrees of freedom/i);
    expect(l.tooltip).toMatch(/can move|shift/i);
  });

  it("singularises the tooltip at DOF 1", () => {
    const l = solveStatusLabel(res({ dof: 1 }))!;
    expect(l.tooltip).toContain("1 degree of freedom");
  });

  it("flags a non-converged solve as over-constrained/conflicting", () => {
    const l = solveStatusLabel(res({ converged: false, dof: 0 }))!;
    expect(l.html).toMatch(/over-constrained|conflict/i);
    expect(l.color).toBe("var(--danger)");
  });
});
