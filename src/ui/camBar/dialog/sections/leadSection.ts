/**
 * Lead-in / Lead-out section (profile ops only).
 */
import type { CADDocument } from "../../../../model/document";
import type { LeadType } from "../../../../cam/types";
import type { OpState } from "../opDialogState";
import { dSection, dField, paramRow } from "../dialogDom";

export function buildLeadSection(
  doc: CADDocument,
  state: OpState,
): { root: HTMLElement; update: () => void } {
  const leadSec = dSection("Lead-in / Lead-out");
  const leadTypes: [LeadType, string][] = [
    ["none", "None"],
    ["linear", "Linear"],
    ["arc", "Arc (90°)"],
  ];

  const makeLeadSelect = (get: () => string, set: (v: LeadType) => void) => {
    const sel = document.createElement("select");
    sel.className = "unit";
    for (const [v, l] of leadTypes) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = l;
      sel.appendChild(o);
    }
    sel.value = get();
    sel.addEventListener("change", () => {
      set(sel.value as LeadType);
      update();
    });
    return sel;
  };

  const liSel = makeLeadSelect(
    () => state.leadInType,
    (v) => {
      state.leadInType = v;
    },
  );
  leadSec.appendChild(dField("Lead-in", liSel));
  const liLenRow = paramRow(
    doc,
    state,
    "leadInLen",
    `Lead-in length (${doc.displayUnit})`,
    () => state.leadInLen,
    (v) => {
      state.leadInLen = v;
    },
    "len",
  );
  leadSec.appendChild(liLenRow.el);

  const loSel = makeLeadSelect(
    () => state.leadOutType,
    (v) => {
      state.leadOutType = v;
    },
  );
  leadSec.appendChild(dField("Lead-out", loSel));
  const loLenRow = paramRow(
    doc,
    state,
    "leadOutLen",
    `Lead-out length (${doc.displayUnit})`,
    () => state.leadOutLen,
    (v) => {
      state.leadOutLen = v;
    },
    "len",
  );
  leadSec.appendChild(loLenRow.el);

  const update = () => {
    const isProfile = state.combo.startsWith("profile");
    leadSec.style.display = isProfile ? "" : "none";
    liLenRow.el.style.display = isProfile && state.leadInType !== "none" ? "" : "none";
    loLenRow.el.style.display = isProfile && state.leadOutType !== "none" ? "" : "none";
  };

  update();
  return { root: leadSec, update };
}
