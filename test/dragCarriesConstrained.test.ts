import { describe, expect, test } from "vitest";
import { CADDocument } from "../src/model/document";
import { CircleEntity, type Entity, LineEntity } from "../src/model/entities";
import { makeConstraint } from "../src/model/constraints";
import { solve, type PinMap } from "../src/solver/solver";

/**
 * Dragging geometry must CARRY whatever is constrained to it.
 *
 * It used to do nothing at all: drag a line a circle sits on, and the line
 * sprang back to where it started. Both outcomes satisfy the constraint —
 * carry the circle, or refuse to move the line — and the solver chose the
 * second, because a drag pin is weighted two orders below the anchor holding
 * the circle still. "The constraint was honoured" was true and beside the
 * point; the gesture was silently discarded.
 *
 * Fixed by translating the attached geometry too, before solving: a rigid
 * translation preserves every positional constraint exactly, so the solver
 * starts satisfied and has nothing to undo. Deliberately NOT fixed by
 * re-weighting the pin, which would have traded this away against the
 * unreachable-drag case those weights were tuned for.
 */

/** Exactly what SelectTool's drag does: translate, carry, solve with pins. */
function drag(doc: CADDocument, sel: Entity[], d: { x: number; y: number }) {
  for (const e of sel) e.selected = true;
  const moving = sel.filter((e) => doc.isMovable(e));
  for (const e of moving) e.translate(d);
  for (const e of doc.carriedBy(moving)) e.translate(d);
  const pins: PinMap = new Map();
  for (const e of moving) for (const p of e.dofPoints()) pins.set(`${e.id}:${p.key}`, p.pos);
  solve(doc, pins);
}

/** A vertical and a horizontal line, with a circle pinned to their crossing. */
function scene() {
  const doc = new CADDocument({ width: 200, height: 150 }, "mm");
  const vert = doc.add(new LineEntity({ x: 60, y: 30 }, { x: 60, y: 140 }));
  const horiz = doc.add(new LineEntity({ x: 20, y: 75 }, { x: 180, y: 75 }));
  const circle = doc.add(new CircleEntity({ x: 60, y: 75 }, 15));
  doc.addConstraint(makeConstraint("vertical", { entities: [vert.id] }));
  doc.addConstraint(makeConstraint("horizontal", { entities: [horiz.id] }));
  for (const l of [vert, horiz])
    doc.addConstraint(
      makeConstraint("pointOnLine", {
        points: [{ entityId: circle.id, key: "c" }],
        entities: [l.id],
      }),
    );
  return { doc, vert, horiz, circle };
}

describe("a drag carries what is constrained to it", () => {
  test("the dragged line actually moves, and the circle comes with it", () => {
    const { doc, horiz, circle } = scene();
    drag(doc, [horiz], { x: 0, y: 40 });

    expect(horiz.a.y, "the line went where it was dragged").toBeCloseTo(115, 1);
    expect(circle.center.y, "and the circle followed").toBeCloseTo(115, 1);
    // The circle's OTHER constraint still holds: it slides along the vertical
    // line rather than being dragged off it.
    expect(circle.center.x, "still on the vertical line").toBeCloseTo(60, 1);
  });

  test("carries transitively", () => {
    const { doc, horiz, circle } = scene();
    const outer = doc.add(new CircleEntity({ x: 60, y: 75 }, 30));
    doc.addConstraint(makeConstraint("concentric", { entities: [circle.id, outer.id] }));

    drag(doc, [horiz], { x: 0, y: 30 });
    expect(outer.center.y, "the concentric circle came too").toBeCloseTo(105, 1);
  });

  test("does NOT carry through an orientation-only constraint", () => {
    // Two parallel lines a long way apart are related, but moving one must not
    // move the other — following those links would drag half the sketch.
    const doc = new CADDocument({ width: 300, height: 200 }, "mm");
    const a = doc.add(new LineEntity({ x: 10, y: 20 }, { x: 100, y: 20 }));
    const b = doc.add(new LineEntity({ x: 10, y: 150 }, { x: 100, y: 150 }));
    doc.addConstraint(makeConstraint("parallel", { entities: [a.id, b.id] }));

    expect(doc.carriedBy([a])).toHaveLength(0);
    drag(doc, [a], { x: 0, y: 25 });
    expect(b.a.y, "the parallel line stayed put").toBeCloseTo(150, 1);
  });

  test("does not carry immovable geometry", () => {
    const { doc, horiz, circle } = scene();
    circle.locked = true;
    expect(doc.carriedBy([horiz]).map((e) => e.id)).not.toContain(circle.id);
  });
});
