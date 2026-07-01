import { test, expect } from "vitest";
import { adjustGrey } from "../src/core/imageManager";

test("no-op adjustment leaves values unchanged", () => {
  const g = new Uint8Array([0, 64, 128, 192, 255]);
  const out = adjustGrey(g, { brightness: 0, contrast: 0 });
  expect([...out]).toEqual([0, 64, 128, 192, 255]);
});

test("positive brightness lifts every pixel (clamped at 255)", () => {
  const g = new Uint8Array([0, 128, 255]);
  const out = adjustGrey(g, { brightness: 50, contrast: 0 });
  expect(out[0]).toBeGreaterThan(0);
  expect(out[1]).toBeGreaterThan(128);
  expect(out[2]).toBe(255);
});

test("negative brightness darkens every pixel (clamped at 0)", () => {
  const g = new Uint8Array([0, 128, 255]);
  const out = adjustGrey(g, { brightness: -50, contrast: 0 });
  expect(out[0]).toBe(0);
  expect(out[1]).toBeLessThan(128);
});

test("positive contrast pushes darks down and lights up around the mid-grey pivot", () => {
  const g = new Uint8Array([64, 128, 192]);
  const out = adjustGrey(g, { brightness: 0, contrast: 60 });
  expect(out[0]).toBeLessThan(64);   // below pivot → darker
  expect(out[1]).toBe(128);          // pivot fixed
  expect(out[2]).toBeGreaterThan(192); // above pivot → lighter
});

test("adjustment does not mutate the input buffer", () => {
  const g = new Uint8Array([10, 20, 30]);
  adjustGrey(g, { brightness: 40, contrast: 40 });
  expect([...g]).toEqual([10, 20, 30]);
});
