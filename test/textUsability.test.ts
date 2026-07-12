import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadFromFile, getTextInkBox } from "../src/core/fontManager";
import { TextEntity } from "../src/model/entities";
import { applyScale, applyRotate, applyFlipH, applyFlipV } from "../src/core/transform";

// Text hit-testing and transforms. Historically TextEntity hit-tested against a
// guessed 0.6-em-per-character box that didn't match the rendered glyphs (wide
// text was unclickable past the estimate, descenders missed entirely), and the
// interactive transforms silently skipped text. These lock in the fixes.

let fontId: string;

beforeAll(async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const bytes = readFileSync(join(here, "..", "public", "fonts", "roboto-regular.woff"));
  const fakeFile = {
    name: "roboto.woff",
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as File;
  ({ id: fontId } = await loadFromFile(fakeFile));
});

describe("getTextInkBox", () => {
  it("measures real glyph extents, wider than the 0.6-em estimate for wide text", () => {
    const ink = getTextInkBox(fontId, "WWWW", 10);
    expect(ink).not.toBeNull();
    // Roboto's W advance is ~0.94 em; the old estimate capped the box at 24 mm.
    expect(ink!.max.x).toBeGreaterThan(28);
    // Ascent well below the old 1.2-em (12 mm) guess.
    expect(ink!.max.y).toBeGreaterThan(5);
    expect(ink!.max.y).toBeLessThan(10);
  });

  it("includes descenders below the baseline", () => {
    const ink = getTextInkBox(fontId, "gy", 10);
    expect(ink).not.toBeNull();
    expect(ink!.min.y).toBeLessThan(-1);
  });

  it("returns null for unloaded fonts and ink-free strings", () => {
    expect(getTextInkBox("no-such-font", "hi", 10)).toBeNull();
    expect(getTextInkBox(fontId, "   ", 10)).toBeNull();
  });
});

describe("TextEntity hit-testing", () => {
  it("hits anywhere on the rendered glyphs, including past the old estimate", () => {
    const t = new TextEntity("WWWW", fontId, 10, { x: 0, y: 0 });
    const ink = getTextInkBox(fontId, "WWWW", 10)!;
    // Inside the last W — beyond the old 24 mm estimated box.
    expect(t.distanceTo({ x: ink.max.x - 1, y: 3 })).toBe(0);
    // Just past the end: small positive distance, not a huge one.
    expect(t.distanceTo({ x: ink.max.x + 5, y: 3 })).toBeCloseTo(5, 0);
  });

  it("hits descenders and rejects the dead air the old box covered", () => {
    const t = new TextEntity("ggg", fontId, 10, { x: 0, y: 0 });
    expect(t.distanceTo({ x: 5, y: -1 })).toBe(0); // descender tail
    expect(t.distanceTo({ x: 5, y: 11.5 })).toBeGreaterThan(0); // old box said 0 here
  });

  it("falls back to the estimate box when the font isn't loaded", () => {
    const t = new TextEntity("hi", "no-such-font", 10, { x: 0, y: 0 });
    const b = t.bounds();
    expect(b.max.x).toBeCloseTo(12); // 0.6 em × 2 chars
    expect(b.max.y).toBeCloseTo(12); // 1.2 em
    expect(t.distanceTo({ x: 6, y: 6 })).toBe(0);
  });
});

describe("text transforms", () => {
  it("applyRotate rigid-rotates text (anchor + orientation)", () => {
    const t = new TextEntity("abc", fontId, 10, { x: 10, y: 0 });
    applyRotate([t], 0, 0, Math.PI / 2);
    expect(t.position.x).toBeCloseTo(0);
    expect(t.position.y).toBeCloseTo(10);
    expect(t.angle).toBeCloseTo(Math.PI / 2);
  });

  it("applyScale scales the anchor and the glyph size uniformly", () => {
    const t = new TextEntity("abc", fontId, 10, { x: 10, y: 10 });
    applyScale([t], 0, 0, 2, 2);
    expect(t.position.x).toBeCloseTo(20);
    expect(t.position.y).toBeCloseTo(20);
    expect(t.sizeMM).toBeCloseTo(20);
  });

  it("applyFlipH/V keep text readable and mirror its footprint (MIRRTEXT=0)", () => {
    const t = new TextEntity("abc", fontId, 10, { x: 5, y: 0 });
    const before = t.bounds();
    const cxBefore = (before.min.x + before.max.x) / 2;

    applyFlipH([t], 0);
    let after = t.bounds();
    expect((after.min.x + after.max.x) / 2).toBeCloseTo(-cxBefore);
    expect(t.angle).toBe(0); // still readable, not mirrored
    expect(after.max.x - after.min.x).toBeCloseTo(before.max.x - before.min.x);

    const cyBefore = (after.min.y + after.max.y) / 2;
    applyFlipV([t], 0);
    after = t.bounds();
    expect((after.min.y + after.max.y) / 2).toBeCloseTo(-cyBefore);
    expect(t.sizeMM).toBeCloseTo(10);
  });
});
