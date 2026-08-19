/**
 * What each toolpath type IS — one table, read by everything that names a type.
 *
 * Before this existed the same set of names was written out three times: the
 * dropdown's labels in `opDialog.ts`, `autoName`'s prefix chain, and the
 * `AUTO_NAME_RE` that has to match what `autoName` produces. Adding `face` in
 * f2aa2e0 updated one of them, so a facing op arrived called **"Drill 1"**.
 * That is this codebase's signature defect — one fact written twice with nothing
 * making the copies agree — so a fourth copy for the picker was not an option.
 *
 * ## The blurbs are claims about the generator
 *
 * `blurb` and `pairsWith` are shown to someone deciding what to cut, so every
 * sentence here has to be true of `cam/gcode.ts` as it actually is. The in-app
 * help once confidently documented `Math.*` functions and keybindings that had
 * never existed (4889763), which is what a description written from intent
 * rather than from the code looks like a year later. `test/opTypeInfo.test.ts`
 * pins the claims that are mechanically checkable; the rest were read off the
 * emitter and are cited below where it isn't obvious.
 */

import type { OpCombo } from "../camBarHelpers";

export type MachineKindFor = "mill" | "laser";

export interface OpTypeInfo {
  combo: OpCombo;
  /**
   * Short name for auto-generated op names ("Pocket 2"). Kept SEPARATE from
   * `label` because it ends up in saved documents — `AUTO_NAME_RE` is how the
   * dialog decides a name is still an untouched default, so renaming one of
   * these silently orphans every op named under the old spelling.
   */
  name: string;
  /** Heading in the picker and the dropdown. */
  label: string;
  /** Heading when the document is a laser, where the same op is spoken of differently. */
  laserLabel?: string;
  /** One sentence: what this toolpath does to the material. */
  blurb: string;
  /** Set only when the op does NOT stand alone — the thing that has to accompany it. */
  pairsWith?: string;
  /** Which machine kinds offer it, in the order they should be listed. */
  machines: readonly MachineKindFor[];
}

/**
 * In dropdown/picker order. Mill order matches the list this replaced, so the
 * dropdown a user knows does not reshuffle under them.
 */
export const OP_TYPES: readonly OpTypeInfo[] = [
  {
    combo: "profile-outside",
    name: "Profile (outside)",
    label: "Profile (outside)",
    laserLabel: "Cut (outside)",
    blurb:
      "Cuts around a shape with the tool on the outside of the line, so the part keeps the size you drew.",
    machines: ["mill", "laser"],
  },
  {
    combo: "profile-inside",
    name: "Profile (inside)",
    label: "Profile (inside)",
    laserLabel: "Cut (inside)",
    blurb:
      "Cuts around a shape with the tool on the inside of the line — for a hole or opening that has to keep its size.",
    machines: ["mill", "laser"],
  },
  {
    combo: "pocket",
    name: "Pocket",
    label: "Pocket (interior clear)",
    blurb: "Clears out everything inside a closed shape, down to depth, in stepped passes.",
    machines: ["mill"],
  },
  {
    combo: "chamfer",
    name: "Chamfer",
    label: "Chamfer (V-bevel edge)",
    // gcode.ts refuses this op with a NOTE when toolType !== "v-bit".
    blurb: "Runs a V-bit along an edge to break the corner with a bevel. Needs a V-bit.",
    machines: ["mill"],
  },
  {
    combo: "vcarve",
    name: "V-Carve",
    label: "V-Carve (text/shape)",
    blurb:
      "Carves a shape with a V-bit so the groove widens where the shape is wide and comes to a point where it narrows — the sign-lettering look. Needs a V-bit.",
    machines: ["mill"],
  },
  {
    combo: "inlay",
    name: "Inlay",
    label: "V-Carve Inlay (two boards)",
    // The male is the complement of the pocket: same design, field cleared, plug
    // mirrored so it flips and seats — with a glue gap the user can feel.
    blurb:
      "V-carves a design into one board as a pocket and a mirrored plug into a second board, so the plug flips and seats in the pocket with a glue gap. Needs a V-bit.",
    machines: ["mill"],
  },
  {
    combo: "engrave",
    name: "Engrave",
    label: "Engrave",
    laserLabel: "Engrave (centreline)",
    blurb:
      "Traces a line at a fixed depth — and, on a laser, engraves a raster image by modulating power per dot.",
    machines: ["mill", "laser"],
  },
  {
    combo: "relief",
    name: "3-D Relief",
    label: "3-D Relief (image)",
    // One job, two stages: it writes a relief-rough pass and an engrave finish on
    // the same image, sharing one depth/invert/tone-curve model.
    blurb:
      "Carves a greyscale image or STL heightfield as a 3-D surface: a roughing pass clears the bulk with a coarse flat tool, then a ball-nose finish cuts the surface. One model, two tools.",
    machines: ["mill"],
  },
  {
    combo: "drill",
    name: "Drill",
    label: "Drill",
    // isValidFor() accepts only CircleEntity for drill.
    blurb: "Plunges a hole at the centre of each selected circle. Can peck to clear chips.",
    machines: ["mill"],
  },
  {
    combo: "face",
    name: "Facing",
    label: "Facing (skim a surface flat)",
    // Takes its extent from the blank or the bed — isValidFor() returns false
    // for every entity, and the op carries no entityIds.
    blurb:
      "Skims the top of the blank flat, or surfaces the spoilboard. Takes its own extent, so it needs no geometry selected.",
    machines: ["mill"],
  },
  {
    combo: "score",
    name: "Score / Fold",
    label: "Score / Fold (low power)",
    blurb: "A low-power pass that scores a fold line into the material without cutting through.",
    machines: ["laser"],
  },
] as const;

/** Lookup by combo. Total over `OpCombo` — the drift guard asserts it. */
export const OP_TYPE_BY_COMBO: Readonly<Record<OpCombo, OpTypeInfo>> = Object.fromEntries(
  OP_TYPES.map((t) => [t.combo, t]),
) as Record<OpCombo, OpTypeInfo>;

/** The types a document of this machine kind offers, in listing order. */
export function opTypesFor(kind: MachineKindFor): readonly OpTypeInfo[] {
  return OP_TYPES.filter((t) => t.machines.includes(kind));
}

/** The heading to show for `info` on this machine kind. */
export function labelFor(info: OpTypeInfo, kind: MachineKindFor): string {
  return kind === "laser" && info.laserLabel ? info.laserLabel : info.label;
}
