/**
 * A plain-English glossary for the machining terms the toolpath dialog labels
 * use. Definitions surface as tooltips on the field's row via dialogDom.dField
 * and dialogDom.paramRow's `help` option.
 *
 * Kept to the terms a newcomer actually meets in the dialog — not the whole CAM
 * lexicon — and written in the same one-honest-sentence tone as opTypeInfo.ts.
 * A drift guard in test/camTerms.test.ts fails if a term here is not referenced
 * by a dialog field, so the table cannot quietly go stale.
 */
export const CAM_TERMS = {
  diameter:
    "The cutter's width. Larger tools clear material faster but cannot reach into tight corners.",
  stepdown:
    "How deep the tool cuts in each pass. Smaller steps are gentler on the tool but take more passes.",
  stepover:
    "How far the tool moves sideways between passes when clearing an area. A smaller step overlaps more and leaves a smoother floor.",
  plungeRate:
    "How fast the tool drives straight down into the material.",
  feedRate:
    "How fast the tool moves sideways while cutting.",
  peckDepth:
    "Drill in short plunges, retracting between them, so chips clear and the bit stays cool. 0 drills in one go.",
  finishAllowance:
    "Material left for the finishing pass, so a roughing pass can cut fast without deciding the final surface.",
  finishPass:
    "A final light pass that shaves the surface to its finished size.",
  cornerOvercut:
    "Over-cut an inside corner (a dog-bone or T-bone) so a square-edged mating part seats despite the tool's corner radius.",
  cutDirection:
    "Climb cuts with the tool's rotation; conventional cuts against it. Climb leaves a cleaner edge on rigid machines.",
  rampAngle:
    "Descend into the cut along a slope instead of plunging straight down, to spare the tool. Empty uses a sensible default.",
  tabs:
    "Small bridges left uncut so the part stays attached to the blank until you snap it free.",
  vAngle:
    "The included angle of a V-shaped cutter — it sets how wide a V-carve groove opens for a given depth.",
} as const;