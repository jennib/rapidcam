import { test, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { PolylineEntity } from "../src/model/entities";
import { makeConstraint, segmentRef } from "../src/model/constraints";
import { solve } from "../src/solver/solver";
import { serializeDoc, applyFile } from "../src/io/fileio";

const P = (x: number, y: number) => ({ x, y });

test("a fresh polyline's vertex ids default to its indices (legacy keys resolve)", () => {
  const pl = new PolylineEntity([P(0, 0), P(10, 0), P(10, 10), P(0, 10)], true);
  expect(pl.vertexIds).toEqual(["0", "1", "2", "3"]);
  // v<index> keys (as written by older files) still address the right vertex.
  expect(pl.getPoint("v2")).toEqual(P(10, 10));
  expect(pl.getPoint("mid_0")).toEqual(P(5, 0)); // midpoint of segment starting at v0
});

test("a vertex keeps its id — and its constrained point — when an edit inserts vertices ahead of it", () => {
  const pl = new PolylineEntity([P(0, 0), P(10, 0), P(10, 10), P(0, 10)], true);
  const v3 = pl.getPoint("v3"); // the last corner, id "3"

  // Simulate a chamfer at corner 0: replace vertex 0 with two new vertices.
  pl.spliceVertices(0, 1, P(2, 0), P(0, 2));

  // Indices shifted (v3 is now physically at index 4), but the id "3" still
  // resolves to the SAME physical corner — the whole point of stable ids.
  expect(pl.points.length).toBe(5);
  expect(pl.getPoint("v3")).toEqual(v3);
  // The two inserted vertices got fresh, non-colliding ids.
  expect(pl.vertexIds).toEqual(["4", "5", "1", "2", "3"]);
  // A naive index reader would now get the wrong point:
  expect(pl.points[3]).not.toEqual(v3);
});

test("a segment ref by start-vertex id follows the edge across an edit", () => {
  const pl = new PolylineEntity([P(0, 0), P(10, 0), P(10, 10), P(0, 10)], true);
  const segBefore = pl.segmentByStartVertexId("2"); // edge from corner 2 → 3
  expect(segBefore).toEqual([P(10, 10), P(0, 10)]);

  pl.spliceVertices(0, 1, P(2, 0), P(0, 2)); // shift indices
  // Same id → same physical edge, even though its index changed.
  expect(pl.segmentByStartVertexId("2")).toEqual(segBefore);
});

test("a constraint on a late segment still binds that edge after an edit ahead of it", () => {
  const doc = new CADDocument({ width: 200, height: 200 });
  const pl = doc.add(
    new PolylineEntity([P(0, 0), P(100, 5), P(100, 100), P(0, 100)], true),
  ) as PolylineEntity;
  // Make the edge starting at vertex id "1" vertical.
  doc.addConstraint(makeConstraint("vertical", { entities: [segmentRef(pl.id, "1")] }));

  // Edit ahead of that edge: chamfer corner 0 (insert two vertices at the front).
  pl.spliceVertices(0, 1, P(5, 0), P(0, 5));

  const r = solve(doc);
  expect(r.converged).toBe(true);
  // The originally-constrained edge (now at a shifted index) is the one made vertical.
  const seg = pl.segmentByStartVertexId("1")!;
  expect(Math.abs(seg[0].x - seg[1].x)).toBeLessThan(1e-4);
});

test("vertex ids survive a save/load round-trip", () => {
  const doc = new CADDocument({ width: 200, height: 200 });
  const pl = doc.add(
    new PolylineEntity([P(0, 0), P(10, 0), P(10, 10), P(0, 10)], true),
  ) as PolylineEntity;
  pl.spliceVertices(1, 1, P(10, 3), P(12, 5)); // non-sequential ids now
  const idsBefore = [...pl.vertexIds];

  const file = serializeDoc(doc, "ids");
  const doc2 = new CADDocument({ width: 1, height: 1 });
  applyFile(doc2, file);
  const pl2 = doc2.entities.find((e) => e instanceof PolylineEntity) as PolylineEntity;

  expect(pl2.vertexIds).toEqual(idsBefore);
  // And a fresh splice on the loaded entity mints an id past every existing one
  // (no reuse), proving the id counter was restored, not reset to length.
  pl2.spliceVertices(0, 0, P(-1, -1));
  expect(pl2.vertexIds[0]).toBe("6"); // max existing id was 5 → next is 6, never reused
});

test("a snapshot without vertexIds (an older file) defaults ids to indices", () => {
  const doc = new CADDocument({ width: 100, height: 100 });
  const pl = doc.add(new PolylineEntity([P(0, 0), P(10, 0), P(10, 10)], true)) as PolylineEntity;
  // Emulate a legacy file: a snapshot whose polyline omits vertexIds entirely.
  const snap = doc.snapshot();
  const poly = snap.entities.find((e) => e.type === "polyline")!;
  delete (poly as { vertexIds?: string[] }).vertexIds;

  const doc2 = new CADDocument({ width: 1, height: 1 });
  doc2.restore(snap);
  const pl2 = doc2.entities.find((e) => e instanceof PolylineEntity) as PolylineEntity;
  expect(pl2.vertexIds).toEqual(["0", "1", "2"]);
  expect(pl2.getPoint("v2")).toEqual(pl.getPoint("v2"));
});
