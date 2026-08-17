/**
 * The roughing half of a 3-D Relief job: its own tool, stepdown/stepover, and the
 * allowance left for the finish pass. Its tool gets a SEPARATE event bus, so the
 * finish's "force a V-bit / ball-nose" coercion never reaches the roughing tool.
 */
import type { CADDocument } from "../../../../model/document";
import { type OpState, OpDialogEvents } from "../opDialogState";
import { buildToolSection } from "./toolSection";
import { dSection, dField, paramRow } from "../dialogDom";

export interface ReliefRoughSectionController {
  root: HTMLElement;
  update: () => void;
}

export function buildReliefRoughSection(
  doc: CADDocument,
  state: OpState,
  isNew: boolean,
): ReliefRoughSectionController {
  const sec = dSection("Roughing");
  // Marks the whole stage so a lookup can say which half of the dialog it means.
  // Every row in here duplicates a label that also exists on the finishing side
  // (Tool Type, Diameter, Stepdown, Stepover), and the rows exist in the DOM even
  // while the stage is hidden — so "the Stepover field" is ambiguous without this.
  sec.dataset.stage = "rough";
  const roughEvents = new OpDialogEvents();
  const rr = state.reliefRough;

  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = state.includeRough;
  cb.addEventListener("change", () => {
    state.includeRough = cb.checked;
    update();
  });
  sec.appendChild(dField("Roughing pass", cb));

  const body = document.createElement("div");
  sec.appendChild(body);

  if (rr) {
    body.appendChild(
      buildToolSection(doc, rr, roughEvents, isNew, "Roughing Tool", "rough-tool-type-select"),
    );
    body.appendChild(
      paramRow(
        doc,
        rr,
        "stepdown",
        `Stepdown (${doc.displayUnit})`,
        () => rr.stepdown,
        (v) => (rr.stepdown = v),
        "len",
      ).el,
    );
    body.appendChild(
      paramRow(
        doc,
        rr,
        "stepover",
        "Stepover (0–1)",
        () => rr.stepover,
        (v) => (rr.stepover = v),
      ).el,
    );
    body.appendChild(
      paramRow(
        doc,
        rr,
        "finishAllowance",
        `Leave for finish (${doc.displayUnit})`,
        () => rr.finishAllowance,
        (v) => (rr.finishAllowance = v),
        "len",
      ).el,
    );
    const ramp = paramRow(
      doc,
      rr,
      "rampAngle",
      "Ramp angle (°)",
      () => rr.rampAngle ?? 0,
      (v) => (rr.rampAngle = v),
    );
    ramp.inp.placeholder = "auto";
    body.appendChild(ramp.el);
  }

  const update = () => {
    const show = state.combo === "relief";
    sec.style.display = show ? "" : "none";
    // The type dropdown can flip `includeRough` (a relief defaults to roughing
    // on), so re-sync the checkbox instead of reading it only at build time.
    cb.checked = state.includeRough;
    body.style.display = show && state.includeRough ? "" : "none";
  };
  update();
  return { root: sec, update };
}
