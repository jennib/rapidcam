/**
 * Known shapes, written out as real STL files, for testing the importer and the
 * heightfield rasteriser against a surface whose height is known in closed form.
 *
 * The binary writer's 80-byte header deliberately begins with the word "solid".
 * That is what a great many real writers put there, and it is exactly the trap
 * the keyword-sniffing detection falls into — so any regression from size
 * arithmetic back to the keyword makes these fixtures fail rather than pass
 * quietly on a synthetic file that happens to avoid the issue.
 */

/** One triangle: x0,y0,z0, x1,y1,z1, x2,y2,z2. */
export type Tri = number[];

/**
 * A dome of radius `R` centred on the origin, sitting on the z=0 plane, closed
 * with a flat bottom disc.
 *
 * The bottom disc is there on purpose: it puts a second surface directly beneath
 * every point of the dome, so a rasteriser that keeps the max Z is tested against
 * one that merely keeps the last Z it saw. `z(r) = √(R² − r²)` is the invariant.
 */
export function hemisphere(R = 10, nLat = 24, nLon = 48): Tri[] {
  const p = (theta: number, phi: number): [number, number, number] => [
    R * Math.sin(theta) * Math.cos(phi),
    R * Math.sin(theta) * Math.sin(phi),
    R * Math.cos(theta),
  ];
  const tris: Tri[] = [];
  for (let i = 0; i < nLat; i++) {
    const t0 = (i / nLat) * (Math.PI / 2);
    const t1 = ((i + 1) / nLat) * (Math.PI / 2);
    for (let j = 0; j < nLon; j++) {
      const f0 = (j / nLon) * 2 * Math.PI;
      const f1 = ((j + 1) / nLon) * 2 * Math.PI;
      const a = p(t0, f0),
        b = p(t1, f0),
        c = p(t1, f1),
        d = p(t0, f1);
      tris.push([...a, ...b, ...c], [...a, ...c, ...d]);
    }
  }
  // Flat bottom disc at z = 0.
  for (let j = 0; j < nLon; j++) {
    const f0 = (j / nLon) * 2 * Math.PI;
    const f1 = ((j + 1) / nLon) * 2 * Math.PI;
    tris.push([
      0,
      0,
      0,
      R * Math.cos(f1),
      R * Math.sin(f1),
      0,
      R * Math.cos(f0),
      R * Math.sin(f0),
      0,
    ]);
  }
  return tris;
}

/**
 * A staircase: `steps` treads of equal depth across Y, rising in Z, spanning
 * `width` in X. Every face is axis-aligned, so each tread's height is exact and
 * a rasterised render of it can be read by eye.
 */
export function steppedBlock(width = 30, depth = 30, steps = 3, rise = 2): Tri[] {
  const tris: Tri[] = [];
  const box = (
    x0: number,
    x1: number,
    y0: number,
    y1: number,
    z0: number,
    z1: number,
  ): void => {
    const v = [
      [x0, y0, z0],
      [x1, y0, z0],
      [x1, y1, z0],
      [x0, y1, z0],
      [x0, y0, z1],
      [x1, y0, z1],
      [x1, y1, z1],
      [x0, y1, z1],
    ];
    const quad = (a: number, b: number, c: number, d: number) => {
      tris.push([...v[a], ...v[b], ...v[c]], [...v[a], ...v[c], ...v[d]]);
    };
    quad(0, 3, 2, 1); // bottom
    quad(4, 5, 6, 7); // top
    quad(0, 1, 5, 4);
    quad(1, 2, 6, 5);
    quad(2, 3, 7, 6);
    quad(3, 0, 4, 7);
  };
  const dy = depth / steps;
  for (let s = 0; s < steps; s++) box(0, width, s * dy, (s + 1) * dy, 0, (s + 1) * rise);
  return tris;
}

/** Write triangles as a binary STL. The header starts with "solid" on purpose. */
export function binarySTL(tris: Tri[], header = "solid THIS IS BINARY - do not trust me"): ArrayBuffer {
  const buf = new ArrayBuffer(84 + 50 * tris.length);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < Math.min(80, header.length); i++) bytes[i] = header.charCodeAt(i) & 0x7f;
  view.setUint32(80, tris.length, true);
  tris.forEach((t, i) => {
    let p = 84 + i * 50;
    for (let k = 0; k < 3; k++, p += 4) view.setFloat32(p, 0, true); // normal: zeroed, never read
    for (let k = 0; k < 9; k++, p += 4) view.setFloat32(p, t[k], true);
    view.setUint16(p, 0, true);
  });
  return buf;
}

/** Write triangles as an ASCII STL. */
export function asciiSTL(tris: Tri[], name = "shape"): ArrayBuffer {
  const out: string[] = [`solid ${name}`];
  for (const t of tris) {
    out.push("  facet normal 0 0 0", "    outer loop");
    for (let k = 0; k < 9; k += 3) out.push(`      vertex ${t[k]} ${t[k + 1]} ${t[k + 2]}`);
    out.push("    endloop", "  endfacet");
  }
  out.push(`endsolid ${name}`, "");
  return new TextEncoder().encode(out.join("\n")).buffer as ArrayBuffer;
}

/**
 * A flat plate deliberately tessellated into SLIVERS — long, thin triangles with
 * near-zero area but full-width coordinates.
 *
 * This is the demanding case for the rasteriser's edge tolerance: the normalised
 * rounding error of a barycentric weight grows as `coord² / area`, so a triangle
 * that is 100 mm long and microns thin is where an edge test is most likely to
 * lose a cell that both of its neighbours also disqualify. Every cell inside the
 * plate must be covered by something — a gap is a full-depth pinhole.
 *
 * `thin` is the strip height in mm; the plate is split into strips that thin,
 * each cut corner-to-corner so the shared diagonals are as oblique as possible.
 */
export function sliverPlate(size = 100, thin = 0.002, strips = 400): Tri[] {
  const tris: Tri[] = [];
  for (let i = 0; i < strips; i++) {
    // Strips march up the plate; each is `thin` tall, so its diagonal spans the
    // full width against almost no height.
    const y0 = (i / strips) * size;
    const y1 = y0 + thin;
    tris.push([0, y0, 1, size, y0, 1, size, y1, 1], [0, y0, 1, size, y1, 1, 0, y1, 1]);
    // …and the gap between this strip and the next, as two more slivers.
    const y2 = ((i + 1) / strips) * size;
    if (y2 > y1)
      tris.push([0, y1, 1, size, y1, 1, size, y2, 1], [0, y1, 1, size, y2, 1, 0, y2, 1]);
  }
  return tris;
}
