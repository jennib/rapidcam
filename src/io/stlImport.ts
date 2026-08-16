/**
 * STL → triangle soup.
 *
 * An STL is the least structured 3-D format in use: no units, no topology, no
 * material — just an unordered pile of triangles, each stated by its three
 * vertices. That is exactly what the heightfield rasteriser wants, so this
 * parser's whole job is to produce the pile and its bounds without editorialising.
 *
 * ## Detecting the format: arithmetic, never the keyword
 *
 * The two encodings are told apart by SIZE, not by whether the file starts with
 * `solid`. A binary STL's 80-byte header is free-form text and a great many
 * writers — SolidWorks and several slicers among them — fill it with a string
 * that begins "solid", so the keyword test misidentifies real files in the wild
 * and then reads a binary body as text, yielding zero triangles and no error.
 *
 * The arithmetic is exact and cannot lie: a binary file is a 80-byte header, a
 * `uint32` triangle count `n`, then 50 bytes per triangle.
 *
 *     byteLength === 84 + 50·n
 *
 * That doubles as validation — `n` is checked against the file's actual size, so
 * a corrupt count can never make us allocate for triangles that aren't there.
 *
 * ## Normals are read past, not read
 *
 * Every facet carries a normal, and this parser ignores all of them. The
 * heightfield keeps the MAXIMUM Z over each cell, which is the top surface of the
 * solid whichever way its facets happen to be wound — so a mesh with flipped or
 * zeroed normals (common, and the usual reason a slicer complains) rasterises
 * correctly here. Nothing downstream asks which way a triangle faces.
 *
 * ## NaNs are dropped, not repaired
 *
 * A non-finite coordinate cannot be repaired without inventing geometry: there is
 * no defensible value to substitute, and a single NaN vertex poisons the bounds
 * (and therefore the entire depth encoding) for the whole model. Such triangles
 * are dropped and counted, so the caller can say so rather than silently carving
 * a model whose Z range came out `NaN`.
 */

/** A point in model space. STL carries no units — see `suggestUnitScale`. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** A parsed STL: flat triangle soup plus the bounds, in the file's own units. */
export interface STLMesh {
  /** 9 floats per triangle — x0,y0,z0, x1,y1,z1, x2,y2,z2. */
  vertices: Float32Array;
  /** Triangles kept (`vertices.length / 9`). */
  count: number;
  min: Vec3;
  max: Vec3;
  /** Which encoding it turned out to be — decided by size arithmetic. */
  format: "binary" | "ascii";
  /** The ASCII `solid <name>` label, or "" (binary headers are free-form junk). */
  name: string;
  /** Triangles dropped for a non-finite coordinate. */
  dropped: number;
}

const BINARY_HEADER = 80;
const BINARY_TRIANGLE = 50;

/**
 * Is this a binary STL? By size arithmetic only — see the header for why the
 * "solid" keyword is not a usable test.
 */
export function isBinarySTL(buf: ArrayBuffer): boolean {
  if (buf.byteLength < BINARY_HEADER + 4) return false;
  const n = new DataView(buf).getUint32(BINARY_HEADER, true);
  return buf.byteLength === BINARY_HEADER + 4 + BINARY_TRIANGLE * n;
}

/**
 * Parse an STL of either encoding.
 *
 * Binary is decided by exact size arithmetic; anything else is read as ASCII.
 * The one fallback is for files with trailing padding after the triangle data
 * (some exporters append junk), where the arithmetic under-reads: if the ASCII
 * pass finds no triangles at all but the binary header describes a body that
 * fits, the binary body is read. That ordering means a genuine ASCII file is
 * never mistaken for binary, because it is tried first whenever the exact
 * arithmetic fails.
 */
export function parseSTL(buf: ArrayBuffer): STLMesh {
  if (isBinarySTL(buf)) return parseBinarySTL(buf);
  const ascii = parseAsciiSTL(buf);
  if (ascii.count > 0) return ascii;
  if (buf.byteLength >= BINARY_HEADER + 4) {
    const n = new DataView(buf).getUint32(BINARY_HEADER, true);
    if (n > 0 && buf.byteLength >= BINARY_HEADER + 4 + BINARY_TRIANGLE * n) return parseBinarySTL(buf);
  }
  return ascii; // empty, and honestly so
}

/** Running bounds accumulator — one place, so both parsers agree on empty. */
class Bounds {
  minX = Infinity;
  minY = Infinity;
  minZ = Infinity;
  maxX = -Infinity;
  maxY = -Infinity;
  maxZ = -Infinity;

  add(x: number, y: number, z: number): void {
    if (x < this.minX) this.minX = x;
    if (y < this.minY) this.minY = y;
    if (z < this.minZ) this.minZ = z;
    if (x > this.maxX) this.maxX = x;
    if (y > this.maxY) this.maxY = y;
    if (z > this.maxZ) this.maxZ = z;
  }

  /** Collapses to the origin when nothing was added, so `min`/`max` are never ±Infinity. */
  min(): Vec3 {
    return this.maxX < this.minX
      ? { x: 0, y: 0, z: 0 }
      : { x: this.minX, y: this.minY, z: this.minZ };
  }
  max(): Vec3 {
    return this.maxX < this.minX
      ? { x: 0, y: 0, z: 0 }
      : { x: this.maxX, y: this.maxY, z: this.maxZ };
  }
}

function parseBinarySTL(buf: ArrayBuffer): STLMesh {
  const view = new DataView(buf);
  const declared = view.getUint32(BINARY_HEADER, true);
  // The body may be shorter than the header claims only in the padded-file
  // fallback path; clamp so a truncated file yields the triangles it does have.
  const available = Math.floor((buf.byteLength - BINARY_HEADER - 4) / BINARY_TRIANGLE);
  const n = Math.min(declared, Math.max(0, available));

  const out = new Float32Array(n * 9);
  const b = new Bounds();
  let kept = 0;
  let dropped = 0;

  for (let i = 0; i < n; i++) {
    // +12 skips the facet normal — see the header on why it is never read.
    let p = BINARY_HEADER + 4 + i * BINARY_TRIANGLE + 12;
    let ok = true;
    const tri = new Array<number>(9);
    for (let v = 0; v < 9; v++, p += 4) {
      const c = view.getFloat32(p, true);
      if (!Number.isFinite(c)) ok = false;
      tri[v] = c;
    }
    if (!ok) {
      dropped++;
      continue;
    }
    const base = kept * 9;
    for (let v = 0; v < 9; v++) out[base + v] = tri[v];
    b.add(tri[0], tri[1], tri[2]);
    b.add(tri[3], tri[4], tri[5]);
    b.add(tri[6], tri[7], tri[8]);
    kept++;
  }

  return {
    vertices: kept === n ? out : out.subarray(0, kept * 9),
    count: kept,
    min: b.min(),
    max: b.max(),
    format: "binary",
    name: "",
    dropped,
  };
}

/**
 * Parse the ASCII encoding by scanning for `vertex` and reading the three floats
 * that follow it, three vertices to a triangle.
 *
 * Deliberately not a grammar. Real ASCII STLs vary in whitespace, indentation,
 * line endings and capitalisation, some omit `outer loop`, and a strict reader
 * rejects files every other tool accepts. The vertices are the only tokens that
 * carry geometry, so finding them is the whole parse — and a stray count that
 * isn't a multiple of three is reported as a dropped partial triangle rather
 * than throwing the other 99.9% of the model away.
 */
function parseAsciiSTL(buf: ArrayBuffer): STLMesh {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(buf);
  const b = new Bounds();
  const coords: number[] = [];
  let dropped = 0;

  const name = /^\s*solid[ \t]+([^\r\n]*)/i.exec(text)?.[1]?.trim() ?? "";

  const VERTEX = /\bvertex\b/gi;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: the exec-loop idiom
  while ((m = VERTEX.exec(text)) !== null) {
    let i = m.index + m[0].length;
    const xyz = [0, 0, 0];
    let ok = true;
    for (let k = 0; k < 3; k++) {
      while (i < text.length && isSpace(text.charCodeAt(i))) i++;
      const start = i;
      while (i < text.length && !isSpace(text.charCodeAt(i))) i++;
      if (i === start) {
        ok = false;
        break;
      }
      const v = Number.parseFloat(text.slice(start, i));
      if (!Number.isFinite(v)) ok = false;
      xyz[k] = v;
    }
    if (!ok) {
      // A malformed vertex would silently shear every later triangle by one
      // vertex, so drop the whole facet it belongs to rather than resync badly.
      coords.length -= coords.length % 9;
      dropped++;
      VERTEX.lastIndex = i;
      continue;
    }
    coords.push(xyz[0], xyz[1], xyz[2]);
    VERTEX.lastIndex = i;
  }

  const whole = coords.length - (coords.length % 9);
  if (whole !== coords.length) dropped++; // a trailing partial facet

  const vertices = new Float32Array(whole);
  for (let i = 0; i < whole; i++) vertices[i] = coords[i];
  for (let i = 0; i < whole; i += 3) b.add(vertices[i], vertices[i + 1], vertices[i + 2]);

  return {
    vertices,
    count: whole / 9,
    min: b.min(),
    max: b.max(),
    format: "ascii",
    name,
    dropped,
  };
}

function isSpace(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12;
}

/** A guess at the model's units, and how sure it is. */
export interface UnitSuggestion {
  /** Model units → mm. 1 for millimetres, 25.4 for inches. */
  scale: number;
  /** False when the bounds are consistent with either reading. */
  confident: boolean;
}

/**
 * Guess whether an STL was authored in millimetres or inches.
 *
 * The format records no units, and the two readings differ by 25.4×, so a wrong
 * guess is a part the wrong size by a factor nothing in the file can reveal. This
 * therefore only picks the DEFAULT — the import dialog states the resulting size
 * in mm beside the control, because the user knows how big the part should be and
 * no heuristic does.
 *
 * Millimetres is the default because it is what essentially all mesh tooling
 * emits. The one honest signal the other way is a model that is implausibly tiny
 * read as mm: under 25 mm on its longest edge is a fingernail, whereas the same
 * figure read as inches is a sensible 100–600 mm workpiece. That is reported as
 * NOT confident rather than flipped, because plenty of real parts genuinely are
 * that small — the dialog then shows what the other reading would give.
 */
export function suggestUnitScale(mesh: STLMesh): UnitSuggestion {
  const longest = Math.max(
    mesh.max.x - mesh.min.x,
    mesh.max.y - mesh.min.y,
    mesh.max.z - mesh.min.z,
  );
  if (!(longest > 0)) return { scale: 1, confident: false };
  return { scale: 1, confident: longest >= 25 };
}
