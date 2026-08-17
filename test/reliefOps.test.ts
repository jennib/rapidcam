/**
 * The shared-image pairing behind relief roughing + finishing (cam/reliefOps.ts):
 * the derived link the lint, the gouge warning, and (Phase 2) the merged dialog
 * and grouped op list all hang off.
 */
import { test, expect } from "vitest";
import { CADDocument } from "../src/model/document";
import { RasterImageEntity, CircleEntity } from "../src/model/entities";
import {
  reliefImageIds,
  sharedReliefImageIds,
  shareReliefImage,
  findReliefPair,
} from "../src/cam/reliefOps";
import type { CAMOperation } from "../src/cam/types";

function baseOp(type: CAMOperation["type"], entityIds: string[]): CAMOperation {
  const rough = type === "relief-rough";
  return {
    id: rough ? "r" : "f",
    name: rough ? "Rough" : "Finish",
    type,
    entityIds,
    side: "outside",
    toolType: rough ? "end-mill" : "ball-nose",
    toolNumber: 1,
    diameter: rough ? 6 : 3,
    feedrate: 1500,
    plungeRate: 300,
    spindleSpeed: 18000,
    safeZ: 5,
    depth: -8,
    stepdown: 2,
    stepover: 0.4,
  };
}

test("reliefImageIds: only the image entities an op targets", () => {
  const doc = new CADDocument({ width: 100, height: 80 });
  const img = doc.add(new RasterImageEntity("img", { x: 10, y: 10 }, 40, 40, 0));
  const c = doc.add(new CircleEntity({ x: 50, y: 50 }, 10));
  expect(reliefImageIds(baseOp("relief-rough", [img.id]), doc)).toEqual([img.id]);
  expect(reliefImageIds(baseOp("engrave", [img.id]), doc)).toEqual([img.id]);
  expect(reliefImageIds(baseOp("engrave", [c.id]), doc)).toEqual([]);
});

test("shareReliefImage: the same image pairs; geometry does not", () => {
  const doc = new CADDocument({ width: 100, height: 80 });
  const img = doc.add(new RasterImageEntity("img", { x: 10, y: 10 }, 40, 40, 0));
  const c = doc.add(new CircleEntity({ x: 50, y: 50 }, 10));
  const rough = baseOp("relief-rough", [img.id]);
  expect(shareReliefImage(rough, baseOp("engrave", [img.id]), doc)).toBe(true);
  expect(shareReliefImage(rough, baseOp("engrave", [c.id]), doc)).toBe(false);
  // sharedReliefImageIds returns the image id, not just a boolean.
  expect(sharedReliefImageIds(rough, baseOp("engrave", [img.id]), doc)).toEqual([img.id]);
});

test("findReliefPair: rough and finish on the same image find each other", () => {
  const doc = new CADDocument({ width: 100, height: 80 });
  const img = doc.add(new RasterImageEntity("img", { x: 10, y: 10 }, 40, 40, 0));
  const rough = baseOp("relief-rough", [img.id]);
  const finish = baseOp("engrave", [img.id]);
  doc.operations.push(rough, finish);
  expect(findReliefPair(rough, doc)).toBe(finish);
  expect(findReliefPair(finish, doc)).toBe(rough);
});

test("findReliefPair: nearest in job order, skipping a line engrave", () => {
  const doc = new CADDocument({ width: 100, height: 80 });
  const img = doc.add(new RasterImageEntity("img", { x: 10, y: 10 }, 40, 40, 0));
  const c = doc.add(new CircleEntity({ x: 50, y: 50 }, 10));
  const rough = baseOp("relief-rough", [img.id]);
  const line = baseOp("engrave", [c.id]); // engrave on geometry, not the image
  const finish = baseOp("engrave", [img.id]);
  doc.operations.push(rough, line, finish);
  expect(findReliefPair(rough, doc)).toBe(finish);
});

test("findReliefPair: no pair for a lone finish or a non-relief op", () => {
  const doc = new CADDocument({ width: 100, height: 80 });
  const img = doc.add(new RasterImageEntity("img", { x: 10, y: 10 }, 40, 40, 0));
  const finish = baseOp("engrave", [img.id]);
  doc.operations.push(finish);
  expect(findReliefPair(finish, doc)).toBeNull();
  expect(findReliefPair(baseOp("profile", [img.id]), doc)).toBeNull();
});
