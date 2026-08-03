// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from "vitest";
import { CADDocument, ORIGIN_ENTITY_ID } from "../src/model/document";
import { CircleEntity, LineEntity, RectEntity } from "../src/model/entities";
import { makeDimension } from "../src/model/dimensions";
import { DesignTreePanel, describeDimension, describeEntity } from "../src/ui/designTree";

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
}

function mount(doc: CADDocument, open = true): Harness {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const pushHistory = vi.fn();
  const panel = new DesignTreePanel({
    container: host,
    doc,
    onHoverEntity: () => {},
    onHoverDimension: () => {},
    onHoverConstraint: () => {},
    pushHistory,
  });
  if (open) panel.setOpen(true);
  return { panel, doc, host, pushHistory };
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

  test("Select All skips hidden and locked entities", () => {
    line.visible = false;
    circle.locked = true;
    const rect = doc.add(new RectEntity({ x: 0, y: 0 }, { x: 10, y: 10 }));

    for (const e of doc.entities) if (doc.isPickable(e)) e.selected = true;

    expect(rect.selected).toBe(true); // positive control
    expect(line.selected).toBe(false);
    expect(circle.selected).toBe(false);
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
  test("locking stops the entity being picked", () => {
    const h = mount(doc);
    expect(doc.hitTest({ x: 20, y: 0 }, 1)?.id).toBe(line.id); // positive control

    action(row(h, "Line 40.00 mm"), /Lock/).click();

    expect(line.locked).toBe(true);
    expect(doc.hitTest({ x: 20, y: 0 }, 1)).toBeNull();
    expect(doc.hitTest({ x: 110, y: 100 }, 1)?.id).toBe(circle.id);
  });

  test("locking leaves snapping alone — a locked datum is still a datum", () => {
    const h = mount(doc);
    action(row(h, "Line 40.00 mm"), /Lock/).click();
    expect(doc.snapPoints().some((p) => p.entityId === line.id)).toBe(true);
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
