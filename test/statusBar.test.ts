import { describe, it, expect } from "vitest";
import { solveStatusLabel } from "../src/ui/statusBar";
import type { SolveResult } from "../src/solver/solver";
import { COLORS } from "../src/view/colors";

const res = (o: Partial<SolveResult>): SolveResult => ({
  hasConstraints: true,
  converged: true,
  residualNorm: 0,
  dof: 0,
  variables: 8, // nonzero by default → there is solvable geometry (override to 0 for "empty")
  equations: 8,
  ...o,
});

describe("solveStatusLabel", () => {
  it("shows nothing when there is no solvable geometry (empty canvas)", () => {
    expect(solveStatusLabel(null)).toBeNull();
    expect(solveStatusLabel(res({ variables: 0, dof: 0 }))).toBeNull();
  });

  it("reads under-constrained for fresh geometry even before any constraint (SolidWorks model)", () => {
    // Free geometry, no constraints yet: variables > 0, dof > 0, hasConstraints false.
    const l = solveStatusLabel(res({ hasConstraints: false, variables: 4, dof: 4 }))!;
    expect(l.html).toContain("Under-constrained");
    expect(l.html).toContain("4");
  });

  it("reads 'Fully constrained' at DOF 0", () => {
    const l = solveStatusLabel(res({ dof: 0 }))!;
    expect(l.html).toContain("Fully constrained");
    expect(l.tooltip).toMatch(/can't move|loose/i);
  });

  it("names the under-constrained state in plain language, not a bare DOF number", () => {
    const l = solveStatusLabel(res({ dof: 5 }))!;
    expect(l.html).toContain("Under-constrained");
    expect(l.html).toContain("5");
    // The tooltip must explain what DOF means and that geometry can move.
    expect(l.tooltip).toMatch(/degrees of freedom/i);
    expect(l.tooltip).toMatch(/can move|shift/i);
  });

  it("reads fully constrained when nothing is loose, even with free DOF (feature-only sketch)", () => {
    // A generator feature has free solver DOF but is controlled, so the caller
    // passes hasUnderDefined=false — the bar must agree with the layer-coloured
    // geometry, not contradict it with "under-constrained".
    const l = solveStatusLabel(res({ dof: 4, variables: 4 }), false)!;
    expect(l.html).toContain("Fully constrained");
  });

  it("respects an explicit hasUnderDefined=true even at a low DOF", () => {
    const l = solveStatusLabel(res({ dof: 2, variables: 8 }), true)!;
    expect(l.html).toContain("Under-constrained");
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

describe("the solve readout joins the number to the geometry", () => {
  it("names the colour the canvas is already painting", () => {
    // The canvas draws loose geometry blue and the bar reports a count; nothing
    // told a newcomer those were the same fact. The tooltip is the only place
    // the two can be joined, since the canvas has no legend.
    const l = solveStatusLabel(res({ dof: 3 }))!;
    expect(l.tooltip).toMatch(/blue/i);
    expect(COLORS.entityUnderDefined, "there must BE a distinct blue to name").toBeTruthy();
  });

  it("offers the click only in the state that has something to select", () => {
    // A pointer cursor over "Fully constrained" that does nothing when clicked
    // is worse than no cursor at all.
    expect(solveStatusLabel(res({ dof: 3 }))!.actionable).toBe(true);
    expect(solveStatusLabel(res({ dof: 0 }))!.actionable).toBeFalsy();
    expect(solveStatusLabel(res({ converged: false, dof: 2 }))!.actionable).toBeFalsy();
  });

  it("says what the click does, or nobody clicks a line of plain text", () => {
    expect(solveStatusLabel(res({ dof: 3 }))!.tooltip).toMatch(/click/i);
  });
});
