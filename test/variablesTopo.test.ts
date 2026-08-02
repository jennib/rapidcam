import { test, expect } from "vitest";
import { evaluateVariables, makeVariable, type Variable } from "../src/model/variables";

const V = (name: string, expr: string): Variable => makeVariable(name, expr, "mm");
const valueOfVar = (vars: Variable[], name: string) => vars.find((v) => v.name === name)!.value;

test("a variable can reference another variable", () => {
  const vars = [V("width", "100"), V("margin", "width * 0.1")];
  evaluateVariables(vars, "mm");
  expect(valueOfVar(vars, "width")).toBe(100);
  expect(valueOfVar(vars, "margin")).toBe(10);
});

test("references resolve regardless of declaration order (topological)", () => {
  const vars = [V("margin", "width * 0.1"), V("width", "100")]; // margin declared first
  evaluateVariables(vars, "mm");
  expect(valueOfVar(vars, "margin")).toBe(10);
});

test("chained references resolve", () => {
  const vars = [V("a", "10"), V("b", "a * 2"), V("c", "b + 5")];
  evaluateVariables(vars, "mm");
  expect([valueOfVar(vars, "a"), valueOfVar(vars, "b"), valueOfVar(vars, "c")]).toEqual([
    10, 20, 25,
  ]);
});

test("plain lengths keep unit-aware parsing (mm/in/fractions)", () => {
  const vars = [V("a", "50mm"), V("b", "3in"), V("c", "1/2in")];
  evaluateVariables(vars, "mm");
  expect(valueOfVar(vars, "a")).toBe(50);
  expect(valueOfVar(vars, "b")).toBeCloseTo(76.2, 4);
  expect(valueOfVar(vars, "c")).toBeCloseTo(12.7, 4);
});

test("a reference cycle leaves the vars at their last value (no infinite loop)", () => {
  const vars = [V("a", "b + 1"), V("b", "a + 1")];
  vars[0].value = 7;
  vars[1].value = 9; // pretend last-known values
  evaluateVariables(vars, "mm");
  expect(valueOfVar(vars, "a")).toBe(7);
  expect(valueOfVar(vars, "b")).toBe(9);
});

test("a self-reference does not run away", () => {
  const vars = [V("a", "a + 1")];
  vars[0].value = 5;
  evaluateVariables(vars, "mm");
  expect(valueOfVar(vars, "a")).toBe(5); // unchanged, not 6/∞
});

test("non-cyclic vars still evaluate even when another pair cycles", () => {
  const vars = [V("good", "40"), V("a", "b"), V("b", "a")];
  evaluateVariables(vars, "mm");
  expect(valueOfVar(vars, "good")).toBe(40);
});

test("restoring variables updates ID counter so newly added variables get unique IDs", async () => {
  const { CADDocument } = await import("../src/model/document");
  const doc = new CADDocument({ width: 400, height: 400 });
  const snap = doc.snapshot();
  doc.restore({
    ...snap,
    variables: [
      { id: "var1", name: "var1", expr: "35", value: 35 },
      { id: "var2", name: "var2", expr: "3", value: 3 },
      { id: "var3", name: "var3", expr: "7.2", value: 7.2 },
      { id: "var4", name: "var4", expr: "48", value: 48 },
      { id: "var5", name: "var5", expr: "22.5", value: 22.5 },
    ],
  });

  const newVar = doc.addVariable(makeVariable("var6", "10", "mm"));
  expect(newVar.id).not.toBe("var1");
  expect(newVar.id).not.toBe("var2");
  expect(newVar.id).not.toBe("var3");
  expect(newVar.id).not.toBe("var4");
  expect(newVar.id).not.toBe("var5");
  expect(doc.variables).toHaveLength(6);
});
