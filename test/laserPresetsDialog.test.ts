// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from "vitest";
import { openLaserPresetsDialog } from "../src/ui/laserPresetsDialog";
import { addPreset, loadPresets, type LaserPreset } from "../src/cam/laserPresets";

/**
 * The preset manager's housekeeping paths — rename, retune, delete.
 *
 * These matter more than they look: every editor here writes straight through to
 * localStorage on `change`, so a mis-wired field silently corrupts a saved
 * recipe, and the numbers it corrupts are laser power. The delete path in
 * particular goes through `confirmDialog`, so "the button removed the row" and
 * "the store actually dropped it" are separate claims and both are asserted.
 */

function preset(over: Partial<LaserPreset> = {}): LaserPreset {
  return {
    id: "p1",
    name: "3mm ply",
    kind: "cut",
    feedrate: 300,
    laserPower: 100,
    laserPasses: 2,
    ...over,
  };
}

const items = () => [...document.querySelectorAll(".lpre-item")] as HTMLElement[];
const nameInput = (i = 0) => items()[i].querySelector(".lpre-name") as HTMLInputElement;
/** The manager's numeric editors are labelled; find one by its caption. */
function numInput(itemIdx: number, caption: string): HTMLInputElement {
  const field = [...items()[itemIdx].querySelectorAll(".lpre-num")].find((f) =>
    f.querySelector("span")?.textContent?.startsWith(caption),
  );
  if (!field) throw new Error(`no "${caption}" editor on item ${itemIdx}`);
  return field.querySelector("input") as HTMLInputElement;
}
function commit(inp: HTMLInputElement, value: string): void {
  inp.value = value;
  inp.dispatchEvent(new Event("change"));
}
const stored = (id = "p1") => loadPresets().find((p) => p.id === id);

beforeEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
});

describe("laser preset manager", () => {
  test("empty state explains where presets come from instead of offering numbers", () => {
    openLaserPresetsDialog("mm");
    const empty = document.querySelector(".lpre-empty");
    expect(empty).toBeTruthy();
    expect(empty?.textContent).toMatch(/Material Test/);
    expect(items()).toHaveLength(0);
  });

  test("lists a row per preset, tagged with the job kind it was tuned for", () => {
    addPreset(preset({ id: "a", name: "ply", kind: "cut" }));
    addPreset(preset({ id: "b", name: "slate", kind: "engrave" }));
    openLaserPresetsDialog("mm");

    expect(items()).toHaveLength(2);
    expect([...document.querySelectorAll(".lpre-kind")].map((k) => k.textContent)).toEqual([
      "Cut",
      "Engrave",
    ]);
  });

  test("renaming writes through to the store", () => {
    addPreset(preset());
    openLaserPresetsDialog("mm");

    commit(nameInput(), "3mm birch ply");
    expect(stored()?.name).toBe("3mm birch ply");
  });

  test("a blank name is refused — an unnamed recipe is unpickable", () => {
    addPreset(preset());
    openLaserPresetsDialog("mm");

    commit(nameInput(), "   ");
    expect(stored()?.name).toBe("3mm ply");
    expect(nameInput().value).toBe("3mm ply"); // and the field is put back
  });

  test("power is clamped to 0–100 rather than stored as typed", () => {
    addPreset(preset());
    openLaserPresetsDialog("mm");

    commit(numInput(0, "Power"), "150");
    expect(stored()?.laserPower).toBe(100);
    commit(numInput(0, "Power"), "-20");
    expect(stored()?.laserPower).toBe(0);
  });

  test("passes are rounded and never drop below one", () => {
    addPreset(preset());
    openLaserPresetsDialog("mm");

    commit(numInput(0, "Passes"), "2.6");
    expect(stored()?.laserPasses).toBe(3);
    commit(numInput(0, "Passes"), "0");
    expect(stored()?.laserPasses).toBe(1);
  });

  test("junk in a number field is rejected and the previous value restored", () => {
    addPreset(preset());
    openLaserPresetsDialog("mm");

    const power = numInput(0, "Power");
    commit(power, "abc");
    expect(stored()?.laserPower).toBe(100);
    expect(power.value).toBe("100");
  });

  test("feed entered in inches is stored as mm", () => {
    addPreset(preset());
    openLaserPresetsDialog("in");

    // 20 in/min = 508 mm/min. The store is always mm; only the editor converts.
    commit(numInput(0, "Feed"), "20");
    expect(stored()?.feedrate).toBeCloseTo(508, 4);
  });

  test("kerf is editable on a cut recipe and absent from an engrave one", () => {
    addPreset(preset({ id: "cut", kind: "cut" }));
    addPreset(preset({ id: "eng", kind: "engrave" }));
    openLaserPresetsDialog("mm");

    commit(numInput(0, "Kerf"), "0.2");
    expect(stored("cut")?.kerfWidth).toBeCloseTo(0.2, 6);
    // An engrave op never applies kerf, so offering the box would be a lie.
    expect(() => numInput(1, "Kerf")).toThrow();
  });

  test("air assist toggles through to the store", () => {
    addPreset(preset({ airAssist: false }));
    openLaserPresetsDialog("mm");

    const air = items()[0].querySelector(".lpre-air") as HTMLInputElement;
    air.checked = true;
    air.dispatchEvent(new Event("change"));
    expect(stored()?.airAssist).toBe(true);
  });

  test("delete asks first, and confirming drops it from the store", async () => {
    addPreset(preset({ id: "a", name: "ply" }));
    addPreset(preset({ id: "b", name: "acrylic" }));
    openLaserPresetsDialog("mm");

    (items()[0].querySelector(".lpre-delete") as HTMLButtonElement).click();
    const confirm = document.querySelector(".tp-danger-btn") as HTMLButtonElement;
    expect(confirm, "delete must ask before destroying a recipe").toBeTruthy();
    confirm.click();
    await Promise.resolve();

    // Both claims: the store dropped it, and only it.
    expect(loadPresets().map((p) => p.id)).toEqual(["b"]);
    await vi.waitFor(() => {
      expect(items()).toHaveLength(1);
    });
    expect(nameInput().value).toBe("acrylic");
  });

  test("cancelling the delete keeps the recipe", async () => {
    addPreset(preset({ id: "a", name: "ply" }));
    openLaserPresetsDialog("mm");

    (items()[0].querySelector(".lpre-delete") as HTMLButtonElement).click();
    // Scope to the CONFIRM's own footer: the manager has a footer too ("Done"),
    // and it comes first in document order, so an unscoped query closes the
    // manager instead of cancelling the delete.
    const danger = document.querySelector(".tp-danger-btn") as HTMLElement;
    const cancel = [...danger.closest(".tp-dialog-footer")!.querySelectorAll("button")].find(
      (b) => !b.classList.contains("tp-danger-btn"),
    ) as HTMLButtonElement;
    cancel.click();
    await Promise.resolve();

    expect(loadPresets().map((p) => p.id)).toEqual(["a"]);
    expect(items()).toHaveLength(1);
  });
});
