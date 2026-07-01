import { test, expect } from "vitest";
import { evaluateVariables, makeVariable, type Variable } from "../src/model/variables";

const V = (name: string, expr: string): Variable => makeVariable(name, expr, "mm");
const valueOf = (vars: Variable[], name: string) => vars.find((v) => v.name === name)!.value;

test("a variable can reference another variable", () => {
  const vars = [V("width", "100"), V("margin", "width * 0.1")];
  evaluateVariables(vars, "mm");
  expect(valueOf(vars, "width")).toBe(100);
  expect(valueOf(vars, "margin")).toBe(10);
});

test("references resolve regardless of declaration order (topological)", () => {
  const vars = [V("margin", "width * 0.1"), V("width", "100")]; // margin declared first
  evaluateVariables(vars, "mm");
  expect(valueOf(vars, "margin")).toBe(10);
});

test("chained references resolve", () => {
  const vars = [V("a", "10"), V("b", "a * 2"), V("c", "b + 5")];
  evaluateVariables(vars, "mm");
  expect([valueOf(vars, "a"), valueOf(vars, "b"), valueOf(vars, "c")]).toEqual([10, 20, 25]);
});

test("plain lengths keep unit-aware parsing (mm/in/fractions)", () => {
  const vars = [V("a", "50mm"), V("b", "3in"), V("c", "1/2in")];
  evaluateVariables(vars, "mm");
  expect(valueOf(vars, "a")).toBe(50);
  expect(valueOf(vars, "b")).toBeCloseTo(76.2, 4);
  expect(valueOf(vars, "c")).toBeCloseTo(12.7, 4);
});

test("a reference cycle leaves the vars at their last value (no infinite loop)", () => {
  const vars = [V("a", "b + 1"), V("b", "a + 1")];
  vars[0].value = 7; vars[1].value = 9; // pretend last-known values
  evaluateVariables(vars, "mm");
  expect(valueOf(vars, "a")).toBe(7);
  expect(valueOf(vars, "b")).toBe(9);
});

test("a self-reference does not run away", () => {
  const vars = [V("a", "a + 1")];
  vars[0].value = 5;
  evaluateVariables(vars, "mm");
  expect(valueOf(vars, "a")).toBe(5); // unchanged, not 6/∞
});

test("non-cyclic vars still evaluate even when another pair cycles", () => {
  const vars = [V("good", "40"), V("a", "b"), V("b", "a")];
  evaluateVariables(vars, "mm");
  expect(valueOf(vars, "good")).toBe(40);
});
