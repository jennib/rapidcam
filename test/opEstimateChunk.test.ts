import { expect, test } from "vitest";
import { OpEstimateManager } from "../src/ui/camBar/opEstimateManager";
import type { CAMOperation } from "../src/cam/types";

/**
 * How much estimation work one turn takes on.
 *
 * Estimating an op means generating its whole G-code, so ops do NOT cost about
 * the same: a generator-made op carrying one target per opening (kumiko emits up
 * to 1236) is ~120ms by itself, and the old fixed count of 3 would put three of
 * those in a single turn with no repaint in between.
 */

function op(entityIds: number, regions = 0): CAMOperation {
  return {
    entityIds: Array.from({ length: entityIds }, (_, i) => `e${i}`),
    regions: Array.from({ length: regions }, () => ({}) as never),
  } as unknown as CAMOperation;
}

test("small ops still batch three at a time", () => {
  expect(OpEstimateManager.chunkSize([op(2), op(3), op(4), op(5)])).toBe(3);
});

test("never takes more than the whole queue", () => {
  expect(OpEstimateManager.chunkSize([op(1)])).toBe(1);
  expect(OpEstimateManager.chunkSize([op(1), op(1)])).toBe(2);
});

test("a heavy op gets a turn to itself", () => {
  // 1236 targets blows the budget on its own, so the two cheap ops behind it
  // wait rather than riding along.
  expect(OpEstimateManager.chunkSize([op(1236), op(2), op(2)])).toBe(1);
});

test("a heavy op behind a cheap one does not join its turn", () => {
  expect(OpEstimateManager.chunkSize([op(2), op(1236), op(2)])).toBe(2);
  // Positive control: the same shape of queue WITHOUT the heavy op takes all
  // three, so the assertion above is cutting the chunk for the intended reason
  // and not because chunkSize caps at 2.
  expect(OpEstimateManager.chunkSize([op(2), op(2), op(2)])).toBe(3);
});

test("always takes at least one, so an over-budget op cannot stall the queue", () => {
  // Bigger than the budget by itself — must still make progress.
  expect(OpEstimateManager.chunkSize([op(100000), op(1)])).toBe(1);
});

test("regions count toward the budget as well as entityIds", () => {
  // A region-based op (v-carve, pocket-from-region) carries its work in
  // `regions`, so counting only entityIds would let a heavy one through.
  expect(OpEstimateManager.chunkSize([op(0, 500), op(2), op(2)])).toBe(1);
  // Positive control: the same op with the regions removed batches normally.
  expect(OpEstimateManager.chunkSize([op(0, 0), op(2), op(2)])).toBe(3);
});
