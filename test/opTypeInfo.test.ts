import { describe, expect, test } from "vitest";
import {
  OP_TYPES,
  OP_TYPE_BY_COMBO,
  labelFor,
  opTypesFor,
} from "../src/ui/camBar/opTypeInfo";
import { AUTO_NAME_RE, autoName, isValidFor, type OpCombo } from "../src/ui/camBarHelpers";
import { CADDocument } from "../src/model/document";
import { CircleEntity, RectEntity } from "../src/model/entities";
import { generateGCode } from "../src/cam/gcode";
import type { CAMOperation } from "../src/cam/types";

/**
 * The op-type table is the single source for every name the CAM UI shows, and
 * its `blurb`/`pairsWith` strings are CLAIMS ABOUT THE GENERATOR shown to
 * someone deciding what to cut.
 *
 * Both halves have burned this codebase before. The names existed in three
 * places and drifted, so a facing op arrived called "Drill 1" (f2aa2e0). And the
 * in-app help documented `Math.*` functions, a `#var` prefix and keybindings
 * that had never existed (4889763) — descriptions written from intent rather
 * than from the code.
 *
 * So: tests here pin the table against the things that can be checked
 * mechanically, and — following `test/helpContent.test.ts` — assert against the
 * CLAIM, not against the wording, so a rephrase doesn't redden and a behaviour
 * change does.
 */

const ALL_COMBOS: OpCombo[] = [
  "profile-outside",
  "profile-inside",
  "pocket",
  "chamfer",
  "vcarve",
  "engrave",
  "relief",
  "drill",
  "face",
  "score",
];

describe("the table is total and consistent", () => {
  test("every OpCombo has an entry, and no entry is orphaned", () => {
    expect([...OP_TYPES.map((t) => t.combo)].sort()).toEqual([...ALL_COMBOS].sort());
  });

  test("every type has a name, a label, a blurb, and at least one machine", () => {
    const bad: string[] = [];
    for (const t of OP_TYPES) {
      if (!t.name.trim()) bad.push(`${t.combo}: empty name`);
      if (!t.label.trim()) bad.push(`${t.combo}: empty label`);
      if (!t.blurb.trim()) bad.push(`${t.combo}: empty blurb`);
      if (t.machines.length === 0) bad.push(`${t.combo}: no machines`);
    }
    expect(bad).toEqual([]);
  });

  test("names are unique — two types sharing one would break auto-naming", () => {
    const names = OP_TYPES.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("the three copies that used to drift now agree", () => {
  test("AUTO_NAME_RE matches what autoName produces, for every type", () => {
    // The drift that shipped: a name the regex misses is treated as user-typed,
    // so the dialog silently stops renaming it when the type changes.
    const doc = new CADDocument({ width: 200, height: 200 });
    const missed = ALL_COMBOS.filter((c) => !AUTO_NAME_RE.test(autoName(c, doc)));
    expect(missed).toEqual([]);
  });

  test("autoName uses the table's name, not a parallel list", () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    const wrong = OP_TYPES.filter((t) => autoName(t.combo, doc) !== `${t.name} 1`).map(
      (t) => t.combo,
    );
    expect(wrong).toEqual([]);
  });

  test("a name that is NOT auto-generated is not matched", () => {
    // Positive control: without this the regex could match everything and the
    // test above would pass vacuously.
    expect(AUTO_NAME_RE.test("Pocket 2")).toBe(true);
    expect(AUTO_NAME_RE.test("My pocket")).toBe(false);
    expect(AUTO_NAME_RE.test("Pocket")).toBe(false);
    expect(AUTO_NAME_RE.test("Roughing pass 2")).toBe(false);
  });
});

describe("machine lists match what the app can actually do", () => {
  test("laser offers exactly the beam-capable types", () => {
    expect(opTypesFor("laser").map((t) => t.combo)).toEqual([
      "profile-outside",
      "profile-inside",
      "engrave",
      "score",
    ]);
  });

  test("score is laser-only and facing is mill-only", () => {
    expect(OP_TYPE_BY_COMBO.score.machines).toEqual(["laser"]);
    expect(OP_TYPE_BY_COMBO.face.machines).toEqual(["mill"]);
  });

  test("a laser reads 'Cut', a mill reads 'Profile', for the same type", () => {
    const p = OP_TYPE_BY_COMBO["profile-outside"];
    expect(labelFor(p, "laser")).toMatch(/^Cut/);
    expect(labelFor(p, "mill")).toMatch(/^Profile/);
  });
});

describe("the blurbs' claims hold against the code", () => {
  test("no op claims to need a partner op — a relief owns both passes", () => {
    // The merged 3-D Relief writes its own roughing + finishing passes, so no
    // type has to say "pairs with …" anymore. If one grows a required pairing
    // again, this fails and someone has to decide whether the card should say
    // so — which is the point.
    expect(OP_TYPES.filter((t) => t.pairsWith).map((t) => t.combo)).toEqual([]);
  });

  test("facing claims to need no geometry — and isValidFor accepts none", () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    const rect = new RectEntity({ x: 0, y: 0 }, { x: 50, y: 50 });
    doc.add(rect);
    expect(isValidFor(rect, "face")).toBe(false);
    expect(OP_TYPE_BY_COMBO.face.blurb).toMatch(/no geometry/i);
  });

  test("drill claims circles — and isValidFor accepts a circle, not a rect", () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    const circle = new CircleEntity({ x: 20, y: 20 }, 5);
    const rect = new RectEntity({ x: 0, y: 0 }, { x: 50, y: 50 });
    doc.add(circle);
    doc.add(rect);
    expect(isValidFor(circle, "drill")).toBe(true);
    expect(isValidFor(rect, "drill")).toBe(false);
    expect(OP_TYPE_BY_COMBO.drill.blurb).toMatch(/circle/i);
  });

  test("chamfer and v-carve claim to need a V-bit — and the emitter refuses without one", () => {
    const doc = new CADDocument({ width: 200, height: 200 });
    const rect = new RectEntity({ x: 10, y: 10 }, { x: 60, y: 60 });
    doc.add(rect);
    const base: CAMOperation = {
      id: "o1",
      name: "x",
      type: "chamfer",
      entityIds: [rect.id],
      side: "outside",
      toolType: "end-mill", // deliberately NOT a v-bit
      toolNumber: 1,
      diameter: 6,
      feedrate: 1000,
      plungeRate: 300,
      spindleSpeed: 18000,
      safeZ: 5,
      depth: -2,
      stepdown: 1,
      stepover: 0.4,
      chamferWidth: 2,
    };
    expect(generateGCode([base], doc)).toMatch(/chamfer requires a V-bit/i);
    expect(OP_TYPE_BY_COMBO.chamfer.blurb).toMatch(/V-bit/);

    const vc = { ...base, id: "o2", type: "vcarve" as const };
    expect(generateGCode([vc], doc)).toMatch(/[Vv].?carve requires a V-bit|requires a V-bit/i);
    expect(OP_TYPE_BY_COMBO.vcarve.blurb).toMatch(/V-bit/);
  });
});
