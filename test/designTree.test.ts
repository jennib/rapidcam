// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from "vitest";
import { CADDocument, ORIGIN_ENTITY_ID } from "../src/model/document";
import { CircleEntity, LineEntity, PolylineEntity, RectEntity } from "../src/model/entities";
import { makeDimension } from "../src/model/dimensions";
import { CONSTRAINT_GLYPH, makeConstraint } from "../src/model/constraints";
import { solveStatusLabel } from "../src/ui/statusBar";
import type { SolveResult } from "../src/solver/solver";
import {
  constraintSubject,
  DesignTreePanel,
  describeDimension,
  describeEntity,
  shortLabels,
} from "../src/ui/designTree";

/**
 * Cover for the design tree, whose whole job is to be a faithful view of the
 * document and whose controls mutate model state that the canvas, the solver
 * and the file format all read.
 *
 * The interesting failures here are not rendering ones:
 *
 *  - **A control that shows but doesn't bite.** `visible` and `locked` are new
 *    entity fields; an eye icon that dims a row while `hitTest` still returns
 *    the entity is worse than no eye icon at all. Every hide/lock assertion is
 *    therefore made against the *document's* pick and delete paths, not against
 *    a CSS class, and each is paired with a positive control on an untouched
 *    sibling so it can't pass by the operation doing nothing at all.
 *  - **State that doesn't survive undo.** Undo restores a snapshot, so anything
 *    the tree sets that `snapshot()`/`restore()` don't carry is silently wiped
 *    by the next Ctrl+Z. Round-tripped explicitly below.
 *
 * The panel is driven by clicking its real DOM, so these exercise the same path
 * a user does. Note happy-dom has no layout engine — see MEMORY: a green run
 * here does not prove the panel is reachable on screen.
 */

/** Let the panel's rAF-coalesced rebuild run. */
const flush = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => resolve()));

interface Harness {
  panel: DesignTreePanel;
  doc: CADDocument;
  host: HTMLElement;
  pushHistory: ReturnType<typeof vi.fn>;
  onDeleteSelection: ReturnType<typeof vi.fn>;
  hoveredConstraints: (string | null)[];
}

function mount(doc: CADDocument, open = true): Harness {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const pushHistory = vi.fn();
  // Stands in for App.deleteSelected: the panel selects a row's subject and then
  // asks the app to delete the selection, so the fake does exactly that much.
  const onDeleteSelection = vi.fn(() => {
    if (doc.selectedConstraintId) doc.removeConstraint(doc.selectedConstraintId);
    else if (doc.selectedDimensionId) doc.removeDimension(doc.selectedDimensionId);
    else doc.removeSelected();
  });
  const hoveredConstraints: (string | null)[] = [];
  const panel = new DesignTreePanel({
    container: host,
    doc,
    onHoverEntity: () => {},
    onHoverDimension: () => {},
    onHoverConstraint: (id) => hoveredConstraints.push(id),
    pushHistory,
    onDeleteSelection,
  });
  if (open) panel.setOpen(true);
  return { panel, doc, host, pushHistory, onDeleteSelection, hoveredConstraints };
}

/** Every row label currently rendered, in tree order. */
const labels = (h: Harness): string[] =>
  [...h.host.querySelectorAll(".tree-label")].map((el) => el.textContent ?? "");

/** The row whose label contains `text`. */
function row(h: Harness, text: string): HTMLElement {
  const found = [...h.host.querySelectorAll<HTMLElement>(".tree-row")].find((r) =>
    r.querySelector(".tree-label")?.textContent?.includes(text),
  );
  if (!found) throw new Error(`no row matching "${text}" in: ${labels(h).join(" | ")}`);
  return found;
}

/** The eye / lock button on a row, by tooltip. */
function action(r: HTMLElement, title: RegExp): HTMLButtonElement {
  const btn = [...r.querySelectorAll<HTMLButtonElement>(".tree-action-btn")].find((b) =>
    title.test(b.title),
  );
  if (!btn) throw new Error(`no action matching ${title} (had: ${r.textContent})`);
  return btn;
}

let doc: CADDocument;
let line: LineEntity;
let circle: CircleEntity;

beforeEach(() => {
  document.body.innerHTML = "";
  doc = new CADDocument({ width: 200, height: 150 }, "mm");
  line = doc.add(new LineEntity({ x: 0, y: 0 }, { x: 40, y: 0 }));
  circle = doc.add(new CircleEntity({ x: 100, y: 100 }, 10));
});

describe("tree structure", () => {
  test("lists entities under their layer and omits the WCS origin", () => {
    const h = mount(doc);
    expect(labels(h)).toEqual(["Default", "Line 40.00 mm", "Circle ⌀20.00 mm"]);
    // Positive control for the omission: the origin really is in the document.
    expect(doc.entities.some((e) => e.id === ORIGIN_ENTITY_ID)).toBe(true);
  });

  test("groups its members into a feature folder", async () => {
    doc.groups.push({ id: "grp-1", name: "Hinge Cup", entityIds: [line.id] });
    const h = mount(doc);
    await flush();

    const group = row(h, "Hinge Cup");
    expect(group.classList.contains("tree-folder-row")).toBe(true);
    // The grouped line moved under the folder; the loose circle did not.
    expect(group.parentElement?.querySelector(".tree-children")?.textContent).toContain("Line");
    expect(group.parentElement?.querySelector(".tree-children")?.textContent).not.toContain(
      "Circle",
    );
  });

  test("clicking a feature folder selects every entity in it", () => {
    const other = doc.add(new RectEntity({ x: 0, y: 0 }, { x: 10, y: 10 }));
    doc.groups.push({ id: "grp-1", name: "Hinge Cup", entityIds: [line.id, circle.id] });
    const h = mount(doc);

    row(h, "Hinge Cup").querySelector<HTMLElement>(".tree-label-group")?.click();

    expect(line.selected).toBe(true);
    expect(circle.selected).toBe(true);
    expect(other.selected).toBe(false);
  });

  test("lists driving dimensions but not the parametric engine's hidden ones", () => {
    doc.addDimension(makeDimension("diameter", { entities: [circle.id], value: 20, offset: 0 }));
    doc.addDimension(
      makeDimension("distance", { entities: [line.id], value: 40, offset: 0, hidden: true }),
    );
    const h = mount(doc);

    expect(labels(h)).toContain("Diameter 20.00 mm");
    expect(labels(h)).not.toContain("Distance 40.00 mm");
  });
});

describe("visibility", () => {
  test("hiding takes the entity out of hit-testing and snapping", () => {
    const h = mount(doc);
    // Positive controls: reachable before the click.
    expect(doc.hitTest({ x: 20, y: 0 }, 1)?.id).toBe(line.id);
    expect(doc.snapPoints().some((p) => p.entityId === line.id)).toBe(true);

    action(row(h, "Line 40.00 mm"), /Hide/).click();

    expect(line.visible).toBe(false);
    expect(doc.hitTest({ x: 20, y: 0 }, 1)).toBeNull();
    expect(doc.snapPoints().some((p) => p.entityId === line.id)).toBe(false);
    // The untouched sibling still is, so the guard isn't just disabling everything.
    expect(doc.hitTest({ x: 110, y: 100 }, 1)?.id).toBe(circle.id);
    expect(h.pushHistory).toHaveBeenCalledTimes(1);
  });

  test("hiding deselects, so nothing invisible stays in the selection", () => {
    line.selected = true;
    const h = mount(doc);
    action(row(h, "Line 40.00 mm"), /Hide/).click();
    expect(line.selected).toBe(false);
  });

  test("Select All skips hidden entities but takes locked ones", () => {
    line.visible = false;
    circle.locked = true;
    const rect = doc.add(new RectEntity({ x: 0, y: 0 }, { x: 10, y: 10 }));

    for (const e of doc.entities) if (doc.isPickable(e)) e.selected = true;

    expect(rect.selected).toBe(true); // positive control
    expect(line.selected).toBe(false);
    // Locked is SolidWorks-flavoured: still selectable, just immovable.
    expect(circle.selected).toBe(true);
  });

  test("a group's eye hides every member at once", async () => {
    doc.groups.push({ id: "grp-1", name: "Hinge Cup", entityIds: [line.id, circle.id] });
    const h = mount(doc);
    await flush();

    action(row(h, "Hinge Cup"), /Hide/).click();
    expect(line.visible).toBe(false);
    expect(circle.visible).toBe(false);

    await flush();
    action(row(h, "Hinge Cup"), /Show/).click();
    expect(line.visible).toBe(true);
    expect(circle.visible).toBe(true);
  });
});

describe("locking", () => {
  test("locking stops movement but not selection — the SolidWorks rule", () => {
    const h = mount(doc);
    expect(doc.isMovable(line)).toBe(true); // positive control

    action(row(h, "Line 40.00 mm"), /Lock/).click();

    expect(line.locked).toBe(true);
    expect(doc.isMovable(line)).toBe(false);
    // Still reachable: you can click it, dimension to it, snap to it.
    expect(doc.hitTest({ x: 20, y: 0 }, 1)?.id).toBe(line.id);
    expect(doc.isPickable(line)).toBe(true);
    // The unlocked sibling is unaffected, so this isn't just a blanket refusal.
    expect(doc.isMovable(circle)).toBe(true);
  });

  test("locking leaves snapping alone — a locked datum is still a datum", () => {
    const h = mount(doc);
    action(row(h, "Line 40.00 mm"), /Lock/).click();
    expect(doc.snapPoints().some((p) => p.entityId === line.id)).toBe(true);
  });

  test("locking keeps the entity selected rather than dropping it", () => {
    line.selected = true;
    const h = mount(doc);
    action(row(h, "Line 40.00 mm"), /Lock/).click();
    expect(line.selected).toBe(true);
  });

  test("a `fixed` constraint makes an entity immovable too, without locking it", () => {
    doc.addConstraint({ id: "c1", type: "fixed", points: [], entities: [circle.id] });
    expect(doc.isMovable(circle)).toBe(false);
    expect(circle.locked).toBe(false); // the two reasons stay distinguishable
    expect(doc.isMovable(line)).toBe(true);
  });

  test("a locked entity survives Delete while its unlocked neighbour goes", () => {
    const h = mount(doc);
    action(row(h, "Line 40.00 mm"), /Lock/).click();

    line.selected = true;
    circle.selected = true;
    doc.removeSelected();

    expect(doc.entities.map((e) => e.id)).toContain(line.id);
    expect(doc.entities.map((e) => e.id)).not.toContain(circle.id);
  });

  test("the row redraws as unlockable, and unlocking restores picking", async () => {
    const h = mount(doc);
    action(row(h, "Line 40.00 mm"), /Lock/).click();

    await flush(); // the rebuild is what turns the 🔓 button into a 🔒 one
    action(row(h, "Line 40.00 mm"), /Unlock/).click();

    expect(line.locked).toBe(false);
    expect(doc.hitTest({ x: 20, y: 0 }, 1)?.id).toBe(line.id);
  });
});

describe("naming", () => {
  test("double-click renames, and Enter commits it", async () => {
    const h = mount(doc);
    const label = row(h, "Line 40.00 mm").querySelector<HTMLElement>(".tree-label")!;
    label.dispatchEvent(new Event("dblclick", { bubbles: true }));

    const input = h.host.querySelector<HTMLInputElement>(".tree-rename-input")!;
    input.value = "Hinge axis";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(line.name).toBe("Hinge axis");
    await flush();
    expect(labels(h)).toContain("Hinge axis");
  });

  test("Escape abandons the edit", () => {
    const h = mount(doc);
    const label = row(h, "Line 40.00 mm").querySelector<HTMLElement>(".tree-label")!;
    label.dispatchEvent(new Event("dblclick", { bubbles: true }));

    const input = h.host.querySelector<HTMLInputElement>(".tree-rename-input")!;
    input.value = "discarded";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(line.name).toBeUndefined();
  });

  test("clearing the name falls back to the geometric description", async () => {
    line.name = "Hinge axis";
    const h = mount(doc);
    const label = row(h, "Hinge axis").querySelector<HTMLElement>(".tree-label")!;
    label.dispatchEvent(new Event("dblclick", { bubbles: true }));

    const input = h.host.querySelector<HTMLInputElement>(".tree-rename-input")!;
    input.value = "  ";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(line.name).toBeUndefined();
    await flush();
    expect(labels(h)).toContain("Line 40.00 mm");
  });

  test("renaming a group writes through to the group definition", async () => {
    doc.groups.push({ id: "grp-1", name: "Group", entityIds: [line.id] });
    const h = mount(doc);
    await flush();

    const label = row(h, "Group").querySelector<HTMLElement>(".tree-label")!;
    label.dispatchEvent(new Event("dblclick", { bubbles: true }));
    const input = h.host.querySelector<HTMLInputElement>(".tree-rename-input")!;
    input.value = "Cabinet hinge bore";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(doc.groups[0].name).toBe("Cabinet hinge bore");
  });
});

describe("selection sync", () => {
  test("clicking a row selects on the canvas, replacing the previous selection", () => {
    circle.selected = true;
    const h = mount(doc);

    row(h, "Line 40.00 mm").querySelector<HTMLElement>(".tree-label-group")?.click();

    expect(line.selected).toBe(true);
    expect(circle.selected).toBe(false);
  });

  test("Ctrl+click adds to the selection instead of replacing it", () => {
    circle.selected = true;
    const h = mount(doc);

    row(h, "Line 40.00 mm")
      .querySelector<HTMLElement>(".tree-label-group")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));

    expect(line.selected).toBe(true);
    expect(circle.selected).toBe(true);
  });

  test("a canvas selection shows up in the tree", async () => {
    const h = mount(doc);
    circle.selected = true;
    doc.emitChange();
    await flush();

    expect(row(h, "Circle ⌀20.00 mm").classList.contains("selected")).toBe(true);
    expect(row(h, "Line 40.00 mm").classList.contains("selected")).toBe(false);
  });
});

describe("persistence", () => {
  test("name, visibility and lock survive a snapshot round-trip (i.e. undo)", () => {
    line.name = "Hinge axis";
    line.visible = false;
    circle.locked = true;

    const snap = doc.snapshot();
    const fresh = new CADDocument({ width: 200, height: 150 }, "mm");
    fresh.restore(snap);

    const restoredLine = fresh.entities.find((e) => e.id === line.id)!;
    const restoredCircle = fresh.entities.find((e) => e.id === circle.id)!;
    expect(restoredLine.name).toBe("Hinge axis");
    expect(restoredLine.visible).toBe(false);
    expect(restoredLine.locked).toBe(false);
    expect(restoredCircle.locked).toBe(true);
    expect(restoredCircle.visible).toBe(true);
  });

  test("untouched entities write none of the three fields", () => {
    const snap = doc.snapshot();
    for (const es of snap.entities) {
      expect(es).not.toHaveProperty("name");
      expect(es).not.toHaveProperty("visible");
      expect(es).not.toHaveProperty("locked");
    }
    // Positive control: they DO appear once set, so the assertion above is
    // testing omission and not just a snapshot that drops them entirely.
    line.name = "x";
    line.visible = false;
    line.locked = true;
    const after = doc.snapshot().entities.find((e) => e.id === line.id)!;
    expect(after).toMatchObject({ name: "x", visible: false, locked: true });
  });

  test("a file with no design-tree fields loads visible and unlocked", () => {
    const snap = doc.snapshot();
    for (const es of snap.entities) {
      delete (es as { visible?: boolean }).visible;
      delete (es as { locked?: boolean }).locked;
    }
    const fresh = new CADDocument({ width: 200, height: 150 }, "mm");
    fresh.restore(snap);
    for (const e of fresh.entities) {
      expect(e.visible).toBe(true);
      expect(e.locked).toBe(false);
    }
  });
});

describe("open / close", () => {
  test("stays empty while closed and fills in on open", async () => {
    const h = mount(doc, false);
    expect(labels(h)).toEqual([]);

    doc.add(new RectEntity({ x: 0, y: 0 }, { x: 10, y: 10 }));
    await flush();
    expect(labels(h)).toEqual([]); // closed panels don't rebuild

    h.panel.setOpen(true);
    expect(labels(h)).toContain("Rectangle 10.00 mm × 10.00 mm");
  });

  test("toggle flips the open state and the body class the palette button reads", () => {
    const h = mount(doc, false);
    expect(h.panel.isOpen).toBe(false);

    h.panel.toggle();
    expect(h.panel.isOpen).toBe(true);
    expect(document.body.classList.contains("design-tree-open")).toBe(true);

    h.panel.toggle();
    expect(h.panel.isOpen).toBe(false);
    expect(document.body.classList.contains("design-tree-open")).toBe(false);
  });
});

describe("constraints section", () => {
  /** A rectangle-ish sketch: two lines, plus the circle from beforeEach. */
  function withTwoLines(): LineEntity {
    return doc.add(new LineEntity({ x: 0, y: 20 }, { x: 40, y: 20 }));
  }

  test("names what each constraint joins, so same-type rows differ", async () => {
    const line2 = withTwoLines();
    doc.addConstraint(
      makeConstraint("perpendicular", { entities: [line.id, line2.id] }),
    );
    doc.addConstraint(makeConstraint("horizontal", { entities: [line2.id] }));
    const h = mount(doc);
    await flush();

    // The whole point: two rows that would otherwise read identically.
    expect(row(h, "Perpendicular").textContent).toContain("Line 1 · Line 2");
    expect(row(h, "Horizontal").textContent).toContain("Line 2");
    expect(row(h, "Horizontal").textContent).not.toContain("Line 1");
  });

  test("uses a custom name over the ordinal, without renumbering the rest", async () => {
    const line2 = withTwoLines();
    line.name = "Hinge axis";
    doc.addConstraint(makeConstraint("parallel", { entities: [line.id, line2.id] }));
    const h = mount(doc);
    await flush();

    // Ordinals are positional, so naming the first line does NOT promote the
    // second to "Line 1" — a label that shifts under you when you rename
    // something else is worse than no label.
    expect(row(h, "Parallel").textContent).toContain("Hinge axis · Line 2");
  });

  test("names WHICH point it holds, so same-entity rows differ", () => {
    const labels = shortLabels(doc);
    const atStart = makeConstraint("fixedPoint", { points: [{ entityId: line.id, key: "a" }] });
    const atEnd = makeConstraint("fixedPoint", { points: [{ entityId: line.id, key: "b" }] });

    // The two pins are on the same line; without the point they read identically.
    expect(constraintSubject(atStart, labels)).toBe("Line 1 start");
    expect(constraintSubject(atEnd, labels)).toBe("Line 1 end");
  });

  test("names an entity once, collapsing several of its points to a count", () => {
    const labels = shortLabels(doc);
    const con = makeConstraint("fixedPoint", {
      points: [
        { entityId: line.id, key: "a" },
        { entityId: line.id, key: "b" },
      ],
    });
    // Not "Line 1 start · Line 1 end": a row must not grow without bound.
    expect(constraintSubject(con, labels)).toBe("Line 1 (2 points)");
  });

  test("resolves a polyline vertex id back to its position", () => {
    const poly = doc.add(
      new PolylineEntity([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], false),
    );
    const labels = shortLabels(doc);
    const geo = (id: string) => doc.entities.find((e) => e.id === id);
    const con = makeConstraint("fixedPoint", {
      points: [{ entityId: poly.id, key: `v${poly.vertexIds[2]}` }],
    });
    // The key is a stable id, which is unreadable; the row shows the position.
    expect(constraintSubject(con, labels, geo)).toBe("Polyline 1 vertex 3");
  });

  test("names a polyline segment reference as an edge", () => {
    const poly = doc.add(
      new PolylineEntity([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], false),
    );
    const labels = shortLabels(doc);
    const geo = (id: string) => doc.entities.find((e) => e.id === id);
    const con = makeConstraint("horizontal", {
      entities: [`${poly.id}#${poly.vertexIds[1]}`],
    });
    expect(constraintSubject(con, labels, geo)).toBe("Polyline 1 edge 2");
  });

  test("names the document's own datums, which are not in `entities`", () => {
    const labels = shortLabels(doc);
    const con = makeConstraint("coincident", {
      points: [
        { entityId: line.id, key: "a" },
        { entityId: "__origin__", key: "p" },
      ],
    });
    // The origin's key names nothing useful — the entity IS the point.
    expect(constraintSubject(con, labels)).toBe("Line 1 start · Origin");
    expect(labels.get("__stock__")).toBe("Stock");
  });

  test("falls back to the bare entity when a key has no readable name", () => {
    const labels = shortLabels(doc);
    const con = makeConstraint("coincident", {
      points: [{ entityId: circle.id, key: "wat" }],
    });
    expect(constraintSubject(con, labels)).toBe("Circle 1");
  });

  test("resolves a polyline segment reference back to its polyline", () => {
    const poly = doc.add(
      new PolylineEntity([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], false),
    );
    const labels = shortLabels(doc);
    const con = makeConstraint("horizontal", {
      entities: [`${poly.id}#${poly.vertexIds[0]}`],
    });
    expect(constraintSubject(con, labels)).toBe("Polyline 1");
  });

  test("shows a locked angle's target, which is its entire content", async () => {
    const line2 = withTwoLines();
    doc.addConstraint(
      makeConstraint("angle", { entities: [line.id, line2.id], params: [Math.PI / 4] }),
    );
    const h = mount(doc);
    await flush();
    expect(labels(h).some((l) => l === "Lock angle 45.00°")).toBe(true);
  });

  test("carries the same glyph the canvas badge draws", async () => {
    const line2 = withTwoLines();
    doc.addConstraint(makeConstraint("parallel", { entities: [line.id, line2.id] }));
    const h = mount(doc);
    await flush();
    expect(row(h, "Parallel").querySelector(".tree-constraint-glyph")?.textContent).toBe(
      CONSTRAINT_GLYPH.parallel,
    );
  });

  test("clicking a row selects the constraint", async () => {
    const line2 = withTwoLines();
    const con = doc.addConstraint(makeConstraint("parallel", { entities: [line.id, line2.id] }));
    const h = mount(doc);
    await flush();

    row(h, "Parallel").click();
    expect(doc.selectedConstraintId).toBe(con.id);
  });

  test("hovering a row asks the canvas to highlight that constraint", async () => {
    const line2 = withTwoLines();
    const con = doc.addConstraint(makeConstraint("parallel", { entities: [line.id, line2.id] }));
    const h = mount(doc);
    await flush();

    const r = row(h, "Parallel");
    r.dispatchEvent(new Event("mouseenter"));
    expect(h.hoveredConstraints.at(-1)).toBe(con.id);
    r.dispatchEvent(new Event("mouseleave"));
    expect(h.hoveredConstraints.at(-1)).toBeNull();
  });

  test("the bin removes that constraint and leaves its neighbour alone", async () => {
    const line2 = withTwoLines();
    const perp = doc.addConstraint(
      makeConstraint("perpendicular", { entities: [line.id, line2.id] }),
    );
    const horiz = doc.addConstraint(makeConstraint("horizontal", { entities: [line2.id] }));
    const h = mount(doc);
    await flush();

    const del = [...row(h, "Perpendicular").querySelectorAll<HTMLButtonElement>(".tree-action-btn")].find(
      (b) => /Delete/.test(b.title),
    );
    expect(del).toBeDefined();
    del!.click();

    expect(doc.constraints.map((c) => c.id)).toEqual([horiz.id]);
    expect(doc.constraints.map((c) => c.id)).not.toContain(perp.id);
    // Routed through the app's delete rather than removing anything itself, so
    // history, the toolpath warning and the re-solve all come for free.
    expect(h.onDeleteSelection).toHaveBeenCalledTimes(1);
    // The row is gone from under the pointer, so the canvas highlight must go
    // too — otherwise a deleted constraint stays lit until the next mouse move.
    expect(h.hoveredConstraints.at(-1)).toBeNull();
  });

  test("the section disappears when the last constraint is deleted", async () => {
    const line2 = withTwoLines();
    doc.addConstraint(makeConstraint("parallel", { entities: [line.id, line2.id] }));
    const h = mount(doc);
    await flush();
    expect(labels(h)).toContain("Parallel");

    doc.removeConstraint(doc.constraints[0].id);
    await flush();
    expect(labels(h)).not.toContain("Parallel");
  });
});

describe("solve status on the Constraints folder", () => {
  /** A SolveResult in one of the three states the status bar distinguishes. */
  const result = (state: "over" | "under" | "full"): SolveResult => ({
    hasConstraints: true,
    converged: state !== "over",
    residualNorm: state === "over" ? 1 : 0,
    dof: state === "under" ? 5 : 0,
    variables: 8,
    equations: state === "under" ? 3 : 8,
  });

  /** A doc with one constraint, so the folder exists to carry the badge. */
  function withConstraint(): void {
    const line2 = doc.add(new LineEntity({ x: 0, y: 20 }, { x: 40, y: 20 }));
    doc.addConstraint(makeConstraint("parallel", { entities: [line.id, line2.id] }));
  }

  const badge = (h: Harness): HTMLElement | null =>
    h.host.querySelector<HTMLElement>(".tree-solve-badge");

  test.each(["over", "under", "full"] as const)(
    "renders exactly what solveStatusLabel says, for %s-constrained",
    async (state) => {
      withConstraint();
      const h = mount(doc);
      const label = solveStatusLabel(result(state))!;

      h.panel.setSolveStatus(label);
      await flush();

      // Not "a red warning appears" — the SAME strings the status bar paints
      // from the SAME helper. That is what makes disagreement impossible.
      expect(badge(h)?.textContent).toBe(label.short);
      expect(badge(h)?.style.color).toBe(label.color);
      expect(badge(h)?.title).toBe(label.tooltip);
    },
  );

  test("the three states are actually distinguishable", () => {
    // Guards the test above: if `short` were the same string for every state it
    // would still pass, while telling the user nothing.
    const shorts = (["over", "under", "full"] as const).map(
      (s) => solveStatusLabel(result(s))!.short,
    );
    expect(new Set(shorts).size).toBe(3);
    expect(shorts[0]).toMatch(/⚠/); // over-constrained is the one that must shout
  });

  test("shows nothing when there is no status to report", async () => {
    withConstraint();
    const h = mount(doc);
    h.panel.setSolveStatus(solveStatusLabel(result("under"))!);
    await flush();
    expect(badge(h)).not.toBeNull(); // positive control

    h.panel.setSolveStatus(null);
    await flush();
    expect(badge(h)).toBeNull();
  });

  test("an unchanged status does not rebuild the tree", async () => {
    withConstraint();
    const h = mount(doc);
    const label = solveStatusLabel(result("under"))!;
    h.panel.setSolveStatus(label);
    await flush();

    // Solves run on every frame of a drag, so a repeated identical status must
    // not cost a full rebuild — node identity is the observable for that.
    const before = badge(h);
    h.panel.setSolveStatus(solveStatusLabel(result("under"))!);
    await flush();
    expect(badge(h)).toBe(before);

    // Positive control: a real change does replace it.
    h.panel.setSolveStatus(solveStatusLabel(result("over"))!);
    await flush();
    expect(badge(h)).not.toBe(before);
  });

  test("no Constraints folder means no badge, rather than a stray one", async () => {
    const h = mount(doc); // no constraints in this doc
    h.panel.setSolveStatus(solveStatusLabel(result("over"))!);
    await flush();
    expect(badge(h)).toBeNull();
  });
});

describe("deleting from a row", () => {
  const bin = (r: HTMLElement): HTMLButtonElement => {
    const b = [...r.querySelectorAll<HTMLButtonElement>(".tree-action-btn")].find((x) =>
      /Delete|Locked/.test(x.title),
    );
    if (!b) throw new Error(`no bin on row: ${r.textContent}`);
    return b;
  };

  test("an object's bin deletes it and leaves its neighbour", () => {
    const h = mount(doc);
    bin(row(h, "Line 40.00 mm")).click();

    expect(doc.entities.map((e) => e.id)).not.toContain(line.id);
    expect(doc.entities.map((e) => e.id)).toContain(circle.id); // positive control
  });

  test("the bin selects only its own row's object before deleting", () => {
    circle.selected = true; // a pre-existing selection that must NOT be swept up
    const h = mount(doc);
    bin(row(h, "Line 40.00 mm")).click();

    expect(doc.entities.map((e) => e.id)).not.toContain(line.id);
    expect(doc.entities.map((e) => e.id)).toContain(circle.id);
  });

  test("a locked object's bin refuses, and says why", () => {
    line.locked = true;
    const h = mount(doc);
    const b = bin(row(h, "Line 40.00 mm"));

    expect(b.disabled).toBe(true);
    expect(b.title).toMatch(/unlock/i);
    b.click();
    // Deleting a locked entity is a silent no-op at the document level, which is
    // exactly why the button refuses up front rather than appearing to work.
    expect(doc.entities.map((e) => e.id)).toContain(line.id);
    expect(h.onDeleteSelection).not.toHaveBeenCalled();
  });

  test("a dimension's bin removes that dimension", () => {
    const dim = doc.addDimension(
      makeDimension("diameter", { entities: [circle.id], value: 20, offset: 0 }),
    );
    const keep = doc.addDimension(
      makeDimension("radius", { entities: [circle.id], value: 10, offset: 0 }),
    );
    const h = mount(doc);

    bin(row(h, "Diameter 20.00 mm")).click();

    expect(doc.dimensions.map((d) => d.id)).toEqual([keep.id]);
    expect(doc.dimensions.map((d) => d.id)).not.toContain(dim.id);
  });

  test("folders have no bin — too much removed for one stray click", async () => {
    doc.groups.push({ id: "grp-1", name: "Hinge Cup", entityIds: [line.id] });
    const h = mount(doc);
    await flush();

    for (const label of ["Default", "Hinge Cup"]) {
      const buttons = [...row(h, label).querySelectorAll<HTMLButtonElement>(".tree-action-btn")];
      expect(buttons.some((b) => /Delete/.test(b.title))).toBe(false);
      expect(buttons.length).toBeGreaterThan(0); // they DO have eye/lock controls
    }
  });
});

describe("suspension during a gesture", () => {
  test("holds rebuilds while a drag is in flight, then catches up", async () => {
    const h = mount(doc);
    expect(labels(h)).toContain("Line 40.00 mm");

    h.panel.setSuspended(true);
    doc.add(new RectEntity({ x: 0, y: 0 }, { x: 10, y: 10 }));
    await flush();
    // Still the pre-drag view: a scale drag emits per pointer move, and
    // rebuilding thousands of rows each time costs more than the drag itself.
    expect(labels(h)).not.toContain("Rectangle 10.00 mm × 10.00 mm");

    h.panel.setSuspended(false);
    await flush();
    expect(labels(h)).toContain("Rectangle 10.00 mm × 10.00 mm");
  });

  test("resuming with nothing changed does not force a rebuild", async () => {
    const h = mount(doc);
    await flush();
    const before = row(h, "Line 40.00 mm");

    h.panel.setSuspended(true);
    h.panel.setSuspended(false);
    await flush();

    // Node identity: a pointer-down/up that changed nothing (a plain click)
    // must not repaint the whole panel.
    expect(row(h, "Line 40.00 mm")).toBe(before);
  });

  test("a suspended panel that is also closed still catches up on open", async () => {
    const h = mount(doc, false);
    h.panel.setSuspended(true);
    doc.add(new RectEntity({ x: 0, y: 0 }, { x: 10, y: 10 }));
    h.panel.setSuspended(false);
    await flush();
    expect(labels(h)).toEqual([]); // closed: still nothing rendered

    h.panel.setOpen(true);
    expect(labels(h)).toContain("Rectangle 10.00 mm × 10.00 mm");
  });

  test("colors tree item icons based on setEntityStatus", async () => {
    const h = mount(doc, true);
    // Deliberately the SAME map, mutated — the app is free to reuse one, and the
    // panel must not miss a change by holding the caller's reference.
    const map = new Map<string, "defined" | "under-defined" | "conflict">();
    map.set(line.id, "under-defined");
    h.panel.setEntityStatus(map);
    await flush();

    const icon = row(h, "Line 40.00 mm").querySelector(".tree-icon") as HTMLElement;
    expect(icon.getAttribute("title")).toBe("Under-constrained (loose)");

    map.set(line.id, "defined");
    h.panel.setEntityStatus(map);
    await flush();
    const icon2 = row(h, "Line 40.00 mm").querySelector(".tree-icon") as HTMLElement;
    expect(icon2.getAttribute("title")).toBe("Fully constrained");
  });
});

describe("descriptions", () => {
  test("read as geometry, in the document's display unit", () => {
    expect(describeEntity(new LineEntity({ x: 0, y: 0 }, { x: 40, y: 0 }))).toBe("Line 40.00 mm");
    expect(describeEntity(new CircleEntity({ x: 0, y: 0 }, 17.5))).toBe("Circle ⌀35.00 mm");
    expect(describeEntity(new LineEntity({ x: 0, y: 0 }, { x: 25.4, y: 0 }), "in")).toBe(
      "Line 1.000 in",
    );
  });

  test("dimensions show their kind and value, angles in degrees", () => {
    expect(describeDimension(makeDimension("diameter", { value: 35, offset: 0 }))).toBe(
      "Diameter 35.00 mm",
    );
    expect(describeDimension(makeDimension("angle", { value: Math.PI / 4, offset: 0 }))).toBe(
      "Angle 45.00°",
    );
  });
});
