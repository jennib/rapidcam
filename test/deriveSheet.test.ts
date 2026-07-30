import { describe, expect, test } from "vitest";
import { CADDocument, deriveSheet, SHEET_MARGIN } from "../src/model/document";

/**
 * The sheet is generated from the stock; the stock is never generated from
 * anything. That direction is the whole point — what the user types as stock
 * size stays exactly what they typed.
 */

const flat = (w: number, h: number) => {
  const doc = new CADDocument({ width: 1, height: 1 }, "mm");
  doc.stockRect = { x: 0, y: 0, width: w, height: h };
  return doc;
};

describe("deriveSheet", () => {
  test("with no bed, the sheet is the stock plus a margin all round", () => {
    // The margin is not decoration: clamps overhang the stock edge and are drawn
    // as geometry, so there must be sheet outside the blank to draw them on.
    expect(deriveSheet(flat(300, 200), null)).toEqual({
      width: 300 + SHEET_MARGIN * 2,
      height: 200 + SHEET_MARGIN * 2,
    });
  });

  test("with a bed configured, the sheet IS the bed", () => {
    expect(deriveSheet(flat(300, 200), { width: 800, height: 400 })).toEqual({
      width: 800,
      height: 400,
    });
  });

  test("a bed smaller than the stock still wins — it is the real table", () => {
    // Not clamped to the stock: the sheet represents the machine. A part too big
    // for it is a real problem, and the travel check is what reports it.
    expect(deriveSheet(flat(900, 900), { width: 400, height: 300 })).toEqual({
      width: 400,
      height: 300,
    });
  });

  test("a junk bed is ignored rather than producing a zero-sized sheet", () => {
    expect(deriveSheet(flat(300, 200), { width: 0, height: 400 })).toEqual({
      width: 400,
      height: 300,
    });
  });

  test("stock is never altered by deriving the sheet", () => {
    const doc = flat(300, 200);
    deriveSheet(doc, { width: 800, height: 400 });
    expect(doc.stockRect).toEqual({ x: 0, y: 0, width: 300, height: 200 });
  });

  test("a ROTARY document has no derivable sheet — its canvas is the cylinder", () => {
    // The wrapped dimension is locked to π·⌀, which is already derived from the
    // stock. Callers must leave rotary alone; null says so explicitly.
    const doc = flat(300, 200);
    doc.machineKind = "mill-rotary";
    doc.rotary = { axisWord: "A", diameter: 60, wrapAxis: "y" };
    expect(deriveSheet(doc, { width: 800, height: 400 })).toBeNull();
    expect(deriveSheet(doc, null)).toBeNull();
  });

  test("with no explicit stock, the whole sheet is the stock (legacy shape)", () => {
    // stockRect null has always meant "stock fills the sheet"; deriving from that
    // grows the sheet by the margin, which is the documented consequence of
    // opening an older design.
    const doc = new CADDocument({ width: 200, height: 150 }, "mm");
    expect(deriveSheet(doc, null)).toEqual({
      width: 200 + SHEET_MARGIN * 2,
      height: 150 + SHEET_MARGIN * 2,
    });
  });
});
