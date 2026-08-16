/**
 * The STL parser. The load-bearing claim is the format detection: binary STLs
 * routinely carry a header beginning "solid", so every fixture here is written
 * with exactly that header and a keyword-sniffing detector fails all of them.
 */
import { describe, expect, test } from "vitest";
import { isBinarySTL, parseSTL } from "../src/io/stlImport";
import { asciiSTL, binarySTL, hemisphere, steppedBlock } from "./stlFixtures";

const TRI: number[][] = [[0, 0, 0, 10, 0, 0, 0, 10, 5]];

describe("format detection is size arithmetic, not the keyword", () => {
  test("a binary STL whose header starts with \"solid\" is still binary", () => {
    const buf = binarySTL(TRI, "solid created by a writer that lies");
    expect(new TextDecoder().decode(new Uint8Array(buf, 0, 5))).toBe("solid");
    expect(isBinarySTL(buf)).toBe(true);
    expect(parseSTL(buf).format).toBe("binary");
    expect(parseSTL(buf).count).toBe(1);
  });

  test("a real ASCII STL is not mistaken for binary", () => {
    const buf = asciiSTL(TRI, "genuine");
    expect(isBinarySTL(buf)).toBe(false);
    expect(parseSTL(buf).format).toBe("ascii");
    expect(parseSTL(buf).count).toBe(1);
  });

  test("the arithmetic is exact — 84 + 50n and nothing else", () => {
    // Both headers, on purpose. Judging by the keyword gets each of these cases
    // right for the wrong reason on a "solid" header alone, so the sign that the
    // SIZE is what decides is that the verdict flips with the size while the
    // header is held constant — in both header styles.
    for (const header of ["solid a lying binary writer", "BINARY EXPORT v3"]) {
      const buf = binarySTL(hemisphere(5, 4, 8), header);
      expect(buf.byteLength).toBe(84 + 50 * parseSTL(buf).count);
      expect(isBinarySTL(buf)).toBe(true);
      expect(isBinarySTL(buf.slice(0, buf.byteLength - 1))).toBe(false);
      expect(isBinarySTL(buf.slice(0, buf.byteLength - 50))).toBe(false);
    }
  });

  test("a declared count that does not match the file size cannot be trusted", () => {
    const buf = binarySTL(TRI);
    new DataView(buf).setUint32(80, 100000, true); // claim 100k triangles in 134 bytes
    expect(isBinarySTL(buf)).toBe(false);
    // The fallback still refuses to allocate for triangles that are not there.
    expect(parseSTL(buf).count).toBe(0);
  });

  test("a binary file with trailing padding still parses", () => {
    const src = binarySTL(hemisphere(5, 4, 8));
    const padded = new Uint8Array(src.byteLength + 17);
    padded.set(new Uint8Array(src));
    const m = parseSTL(padded.buffer as ArrayBuffer);
    expect(m.format).toBe("binary");
    expect(m.count).toBe(parseSTL(src).count);
  });
});

describe("both encodings describe the same solid", () => {
  const tris = hemisphere(10, 12, 24);

  test("vertex for vertex, and bound for bound", () => {
    const a = parseSTL(binarySTL(tris));
    const b = parseSTL(asciiSTL(tris, "dome"));
    expect(b.count).toBe(a.count);
    // Numeric, not structural: `String(-0)` is "0", so the ASCII writer drops the
    // sign of a negative zero. Nothing downstream can tell the two apart.
    let worst = 0;
    for (let i = 0; i < a.vertices.length; i++)
      worst = Math.max(worst, Math.abs(a.vertices[i] - b.vertices[i]));
    expect(worst).toBe(0);
    expect(a.vertices.length).toBeGreaterThan(1000); // the loop had something to check
    expect(b.min).toEqual(a.min);
    expect(b.max).toEqual(a.max);
  });

  test("bounds are the real extents", () => {
    const m = parseSTL(binarySTL(tris));
    expect(m.min.x).toBeCloseTo(-10, 4);
    expect(m.max.x).toBeCloseTo(10, 4);
    expect(m.min.z).toBeCloseTo(0, 4);
    expect(m.max.z).toBeCloseTo(10, 4);
  });

  test("the ASCII solid name is read; a binary header is not mined for one", () => {
    expect(parseSTL(asciiSTL(TRI, "bracket v2")).name).toBe("bracket v2");
    expect(parseSTL(binarySTL(TRI, "solid whatever")).name).toBe("");
  });

  test("ASCII parsing survives the whitespace real files use", () => {
    const messy =
      "SOLID x\r\n FACET NORMAL 0 0 0\r\n\touter loop\r\n" +
      "\t\tVERTEX  0 0 0\r\n\t\tvertex\t10\t0\t0\r\n\t\tvertex 0 10 5\r\n" +
      " endloop\r\nendfacet\r\nendsolid x\r\n";
    const m = parseSTL(new TextEncoder().encode(messy).buffer as ArrayBuffer);
    expect(m.count).toBe(1);
    expect(m.max.z).toBeCloseTo(5, 6);
  });
});

describe("non-finite coordinates are dropped, never propagated", () => {
  test("one NaN triangle does not poison the bounds of the other nine", () => {
    const tris = hemisphere(10, 4, 8).slice(0, 10);
    const poisoned = tris.map((t, i) => (i === 3 ? [...t.slice(0, 4), NaN, ...t.slice(5)] : t));
    const m = parseSTL(binarySTL(poisoned));
    expect(m.count).toBe(9);
    expect(m.dropped).toBe(1);
    for (const v of [m.min.x, m.min.y, m.min.z, m.max.x, m.max.y, m.max.z])
      expect(Number.isFinite(v)).toBe(true);
    // Positive control: without the NaN all ten survive, so the count above is
    // the drop and not some unrelated parse failure.
    expect(parseSTL(binarySTL(tris)).count).toBe(10);
  });

  test("the kept triangles are the un-poisoned ones, not merely nine of them", () => {
    const tris = steppedBlock(10, 10, 1, 4);
    const bad = tris.map((t, i) => (i === 0 ? [Infinity, ...t.slice(1)] : t));
    const m = parseSTL(binarySTL(bad));
    const ref = parseSTL(binarySTL(tris.slice(1)));
    expect(Array.from(m.vertices)).toEqual(Array.from(ref.vertices));
  });
});

describe("degenerate input yields an empty mesh, not an exception", () => {
  test.each([
    ["an empty buffer", new ArrayBuffer(0)],
    ["a zero-triangle binary STL", binarySTL([])],
    ["text that is not an STL", new TextEncoder().encode("hello there").buffer as ArrayBuffer],
  ])("%s", (_label, buf) => {
    const m = parseSTL(buf as ArrayBuffer);
    expect(m.count).toBe(0);
    expect(m.vertices.length).toBe(0);
    // Never ±Infinity: the bounds feed the depth encoding directly.
    expect(m.min).toEqual({ x: 0, y: 0, z: 0 });
    expect(m.max).toEqual({ x: 0, y: 0, z: 0 });
  });
});
