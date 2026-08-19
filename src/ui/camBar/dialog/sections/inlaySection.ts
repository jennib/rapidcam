/**
 * V-carve inlay fit section — the four numbers that make a plug seat in a
 * pocket, plus the radial-clearance readout (the glue gap the part actually
 * feels, which is what a Vectric user thinks in).
 */

import { radialClearance } from "../../../../cam/inlay";
import type { CADDocument } from "../../../../model/document";
import { dSection, lenU, paramRow } from "../dialogDom";
import type { OpDialogEvents, OpState } from "../opDialogState";

export interface InlaySectionController {
  root: HTMLElement;
  update: () => void;
}

export function buildInlaySection(
  doc: CADDocument,
  state: OpState,
  events: OpDialogEvents,
): InlaySectionController {
  const du = doc.displayUnit;
  const sec = dSection("Inlay fit");

  // The radial clearance is what the glue gap actually IS between the parts — a
  // Vectric user thinks in this number, so it reads out beside the gap.
  const clearance = document.createElement("div");
  clearance.style.cssText = "font-size:11px;color:var(--accent);padding:2px 0 6px 0;";

  const updateClearance = (): void => {
    const r = radialClearance(state.glueGap, state.vAngle);
    clearance.textContent = `${state.glueGap}${du} gap on a ${state.vAngle}° bit = ${lenU(r, doc)} of glue space per side`;
  };

  const pocketRow = paramRow(
    doc,
    state,
    "pocketDepth",
    `Pocket depth (${du})`,
    () => state.pocketDepth,
    (v) => {
      state.pocketDepth = v;
    },
    "len",
  );

  const glueRow = paramRow(
    doc,
    state,
    "glueGap",
    `Glue gap (${du})`,
    () => state.glueGap,
    (v) => {
      state.glueGap = v;
      updateClearance();
    },
    "len",
    { onChange: updateClearance },
  );

  const sawRow = paramRow(
    doc,
    state,
    "sawAllowance",
    `Saw allowance (${du})`,
    () => state.sawAllowance,
    (v) => {
      state.sawAllowance = v;
    },
    "len",
  );

  const marginRow = paramRow(
    doc,
    state,
    "inlayMargin",
    `Boundary margin (${du})`,
    () => state.inlayMargin,
    (v) => {
      state.inlayMargin = v;
    },
    "len",
  );

  sec.appendChild(pocketRow.el);
  sec.appendChild(glueRow.el);
  sec.appendChild(clearance);
  sec.appendChild(sawRow.el);
  sec.appendChild(marginRow.el);

  // The readout depends on the V-bit angle chosen in the tool section, so it
  // refreshes when that changes too.
  events.onUpdateVBitHint(updateClearance);
  updateClearance();

  const update = (): void => {
    sec.style.display = state.combo === "inlay" ? "" : "none";
    if (state.combo === "inlay") updateClearance();
  };

  return { root: sec, update };
}
