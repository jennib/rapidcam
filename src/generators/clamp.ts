/**
 * Clamp — a hold-down placed against an edge of the blank.
 *
 * Workholding was authorable before this only as raw geometry: draw a closed
 * shape, find the layers panel, flag the layer 🗜, type a height. That is a CAD
 * gesture for what is a machinist's decision — nobody setting up a job thinks
 * "I'll add a rectangle", they think "toe clamp, middle of the left edge". This
 * generator is that sentence.
 *
 * It is the first `placement: "stock"` generator: it reads {@link Sketch.stock}
 * and draws itself in absolute document coordinates on the chosen edge, so the
 * runner must not centre it (see generators/index.ts). The same property is what
 * makes it FOLLOW the blank — every rebuild re-derives the position from the
 * current stock, so resizing the material in Settings slides the clamps along
 * with it instead of leaving them describing a workpiece that no longer exists.
 *
 * The footprint deliberately straddles the stock edge: `overhang` sits on the
 * material (that is the bit doing the holding) and the rest sits on the sheet
 * outside it. That is also why the sheet is grown past the blank on all four
 * sides — see the New Project margin.
 *
 * Height goes on the ENTITY, not the layer, so several clamps of different
 * heights share one "Workholding" layer. An unset height is not "flat", it is
 * "unknown", and pre-flight treats unknown as blocking every pass.
 */

import type { Generator } from "./index";
import type { Handle, Sketch } from "./sketch";

/** Which edge of the blank the clamp grips. Values are stored on the feature. */
const EDGE_CHOICES = [
  { value: 0, label: "Left" },
  { value: 1, label: "Right" },
  { value: 2, label: "Front (bottom)" },
  { value: 3, label: "Back (top)" },
];

/** The workholding layer every clamp lands on. Amber, matching COLORS.fixture. */
const LAYER = { name: "Workholding", color: "#e0a555" };

export const clamp: Generator = {
  id: "clamp",
  name: "Clamp",
  placement: "stock",
  build(s: Sketch): Handle[] {
    const edge = s.param("edge", 0, {
      int: true,
      label: "Edge of blank",
      choices: EDGE_CHOICES,
    });
    // Distance along the edge, measured from its start (bottom for a side edge,
    // left for a front/back edge) to the clamp's CENTRE. Defaults to the middle
    // of the edge, which is where a single hold-down usually goes.
    const along = s.param("along", 0, { unit: "len", label: "Offset along edge (0 = centred)" });
    const width = s.param("width", 60, { unit: "len", min: 1, label: "Width (along the edge)" });
    const reach = s.param("reach", 40, { unit: "len", min: 1, label: "Reach (across the edge)" });
    // How far the clamp sits ON the material. The rest of `reach` lies outside
    // the blank, on the sheet, where the fixture is actually bolted down.
    const overhang = s.param("overhang", 12, { unit: "len", min: 0, label: "Overhang onto stock" });
    const height = s.param("height", 20, {
      unit: "len",
      min: 0.1,
      label: "Height above stock top",
    });

    const stock = s.stock;
    if (stock.width <= 0 || stock.height <= 0) {
      // No blank to grip. Emitting a clamp at the origin would be a fixture in
      // the wrong place, which is worse than none: it would silently fail the
      // pre-flight against geometry that means nothing.
      s.note("This document has no stock to clamp against — set a stock size in Settings first.");
      return [];
    }

    // A clamp that reaches further onto the material than it is long is not a
    // clamp, it is a plate lying on the part. Clamp rather than reject, so the
    // dialog stays usable while the number is being typed.
    const onStock = Math.min(overhang, reach);
    if (overhang > reach) {
      s.note(`Overhang can't exceed reach (${s.len(reach)}) — using ${s.len(onStock)}.`);
    }

    // Left/right run along Y and reach across X; front/back are the transpose.
    const vertical = edge === 0 || edge === 1;
    // The edge the clamp sits ON: where its face is, and which way is "into the
    // material" from there.
    const facePos = vertical
      ? edge === 0
        ? stock.x
        : stock.x + stock.width
      : edge === 2
        ? stock.y
        : stock.y + stock.height;
    const inward = edge === 0 || edge === 2 ? 1 : -1;

    // Along the edge: `along` shifts the clamp's CENTRE from the edge's midpoint.
    const edgeLen = vertical ? stock.height : stock.width;
    const edgeMin = vertical ? stock.y : stock.x;
    const alongLo = edgeMin + edgeLen / 2 + along - width / 2;

    if (width > edgeLen) {
      s.note(`Clamp is wider than the ${s.len(edgeLen, 0)} edge it sits on.`);
    } else if (alongLo < edgeMin || alongLo + width > edgeMin + edgeLen) {
      s.note("Clamp hangs off the end of that edge — it grips less material than its width.");
    }

    // Across the edge: `onStock` inboard of the face, the balance outboard on the
    // sheet. min/max because `inward` flips the sense on the far edges.
    const inboard = facePos + inward * onStock;
    const outboard = facePos - inward * (reach - onStock);
    const acrossLo = Math.min(inboard, outboard);
    const across = Math.abs(inboard - outboard);

    const corner = vertical ? { x: acrossLo, y: alongLo } : { x: alongLo, y: acrossLo };
    const size = vertical ? { w: across, h: width } : { w: width, h: across };

    s.layer(LAYER.name, LAYER.color, { fixture: true, fixtureHeight: height });
    // Keyed so the clamp keeps its id across parameter edits and stock resizes —
    // anything a user attached to it (a dimension holding it to the part, say)
    // survives. Unkeyed, every rebuild would hand it a new id.
    s.key("clamp");
    const body = s.rect(corner, size);
    s.layer(); // back to the default layer

    // No `suggestOp`: workholding is never machined. Saying nothing here is the
    // point — the "Create toolpaths" checkbox does not even appear.
    s.note(
      `Pre-flight will flag any move that crosses this clamp below ${height}mm above the stock top.`,
    );
    return [body];
  },
};
