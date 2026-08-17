/**
 * Tool section: library load/save, tool type, diameter, feeds/speeds, conditional V-bit/drill fields.
 */
import type { CADDocument } from "../../../../model/document";
import { promptDialog } from "../../../modal";
import {
  type ToolDef,
  type ToolType,
  TOOL_TYPE_LABELS,
  DEFAULTS,
} from "../../../../cam/types";
import { loadLibrary, addTool } from "../../../../cam/toolLibrary";
import type { ToolState, OpDialogEvents } from "../opDialogState";
import {
  dSection,
  dField,
  paramRow,
  lenU,
} from "../dialogDom";

export function buildToolSection(
  doc: CADDocument,
  state: ToolState,
  events: OpDialogEvents,
  isNew: boolean,
  title = "Tool",
): HTMLElement {
  const toolSec = dSection(title);
  const toolSectionTitle = toolSec.querySelector(".tp-dialog-section-title") as HTMLElement;
  const toolArrow = document.createElement("span");
  toolArrow.style.cssText = "float:right;margin-left:6px;font-style:normal;";
  toolSectionTitle.style.cursor = "pointer";
  toolSectionTitle.appendChild(toolArrow);

  const toolContent = document.createElement("div");
  toolContent.style.cssText = "display:flex;flex-direction:column;gap:7px;";

  let toolExpanded = isNew;
  const applyToolCollapse = () => {
    toolContent.style.display = toolExpanded ? "" : "none";
    toolArrow.textContent = toolExpanded ? "▲" : "▼";
  };
  toolSectionTitle.addEventListener("click", () => {
    toolExpanded = !toolExpanded;
    applyToolCollapse();
  });
  applyToolCollapse();

  // --- library row ---
  const libRow = document.createElement("div");
  libRow.style.cssText = "display:flex;gap:6px;margin-bottom:8px;";
  const loadLibBtn = document.createElement("button");
  loadLibBtn.className = "btn";
  loadLibBtn.style.flex = "1";
  loadLibBtn.textContent = "Load from Library";
  const saveLibBtn = document.createElement("button");
  saveLibBtn.className = "btn";
  saveLibBtn.style.flex = "1";
  saveLibBtn.textContent = "Save to Library";
  libRow.appendChild(loadLibBtn);
  libRow.appendChild(saveLibBtn);
  toolContent.appendChild(libRow);

  const libPicker = document.createElement("div");
  libPicker.style.cssText =
    "display:none;margin-bottom:8px;max-height:140px;overflow-y:auto;" +
    "background:var(--panel);border:1px solid var(--border);border-radius:4px;";
  toolContent.appendChild(libPicker);

  const refreshPicker = () => {
    libPicker.innerHTML = "";
    const tools = loadLibrary();
    if (tools.length === 0) {
      const mt = document.createElement("div");
      mt.style.cssText = "padding:8px;font-size:11px;color:var(--text-dim)";
      mt.textContent = "Library is empty";
      libPicker.appendChild(mt);
      return;
    }
    for (const t of tools) {
      const row = document.createElement("div");
      row.style.cssText =
        "display:flex;align-items:center;gap:6px;padding:5px 8px;cursor:pointer;" +
        "border-bottom:1px solid var(--border);font-size:11px;";
      row.addEventListener("mouseover", () => {
        row.style.background = "var(--panel-2)";
      });
      row.addEventListener("mouseout", () => {
        row.style.background = "";
      });
      const nameSpan = document.createElement("span");
      nameSpan.style.flex = "1";
      nameSpan.textContent = t.name;
      const detailSpan = document.createElement("span");
      detailSpan.style.color = "var(--text-dim)";
      detailSpan.textContent = `⌀${lenU(t.diameter, doc)}`;
      row.appendChild(nameSpan);
      row.appendChild(detailSpan);
      row.addEventListener("click", () => {
        applyToolDef(t);
        libPicker.style.display = "none";
        loadLibBtn.textContent = "Load from Library";
      });
      libPicker.appendChild(row);
    }
  };

  let pickerOpen = false;
  loadLibBtn.addEventListener("click", () => {
    pickerOpen = !pickerOpen;
    if (pickerOpen) {
      refreshPicker();
      libPicker.style.display = "block";
      loadLibBtn.textContent = "▲ Close Library";
    } else {
      libPicker.style.display = "none";
      loadLibBtn.textContent = "Load from Library";
    }
  });

  saveLibBtn.addEventListener("click", async () => {
    const name = await promptDialog({
      title: "Save Tool to Library",
      label: "Tool name",
      initial:
        state.toolType === "v-bit"
          ? `${state.vAngle}° V-Bit ⌀${lenU(state.diameter, doc)}`
          : `⌀${lenU(state.diameter, doc)} ${TOOL_TYPE_LABELS[state.toolType]}`,
      confirmLabel: "Save",
    });
    if (!name) return;
    const def: ToolDef = {
      id: `tool-${Date.now()}`,
      name,
      toolType: state.toolType,
      diameter: state.diameter,
      vAngle: state.vAngle,
      tipAngle: state.tipAngle,
      tipDiameter: state.toolType === "tapered-ball-nose" ? state.tipDiameter : undefined,
      feedrate: state.feedrate,
      plungeRate: state.plungeRate,
      spindleSpeed: state.spindleSpeed,
      safeZ: state.safeZ,
    };
    addTool(def);
    if (pickerOpen) refreshPicker();
  });

  // --- tool type ---
  const toolTypeSelect = document.createElement("select");
  toolTypeSelect.className = "unit";
  toolTypeSelect.dataset.testid = "tool-type-select";
  for (const [v, l] of Object.entries(TOOL_TYPE_LABELS) as [ToolType, string][]) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = l;
    toolTypeSelect.appendChild(o);
  }
  toolTypeSelect.value = state.toolType;
  toolContent.appendChild(dField("Tool Type", toolTypeSelect));

  // Manual edits to any tool-defining field fork the op off its library tool.
  const fork = () => {
    state.toolId = undefined;
  };

  const toolNumRow = paramRow(
    doc,
    state,
    "toolNumber",
    "Tool # (T)",
    () => state.toolNumber,
    (v) => {
      state.toolNumber = v;
    },
    undefined,
    { onFork: fork },
  );
  const diamRow = paramRow(
    doc,
    state,
    "diameter",
    `Diameter (${doc.displayUnit})`,
    () => state.diameter,
    (v) => {
      state.diameter = v;
      events.emitUpdateVBitHint();
    },
    "len",
    { onFork: fork, onChange: () => events.emitUpdateVBitHint() },
  );
  const vAngleRow = paramRow(
    doc,
    state,
    "vAngle",
    "V Angle (°)",
    () => state.vAngle,
    (v) => {
      state.vAngle = v;
      events.emitUpdateVBitHint();
    },
    undefined,
    { onFork: fork, onChange: () => events.emitUpdateVBitHint() },
  );
  const tipAngleRow = paramRow(
    doc,
    state,
    "tipAngle",
    "Tip Angle (°)",
    () => state.tipAngle,
    (v) => {
      state.tipAngle = v;
    },
    undefined,
    { onFork: fork },
  );
  const tipRow = paramRow(
    doc,
    state,
    "tipDiameter",
    `Ball Tip ⌀ (${doc.displayUnit})`,
    () => state.tipDiameter,
    (v) => {
      state.tipDiameter = v;
    },
    "len",
    { onFork: fork },
  );
  const spindleRow = paramRow(
    doc,
    state,
    "spindleSpeed",
    "Spindle (rpm)",
    () => state.spindleSpeed,
    (v) => {
      state.spindleSpeed = v;
    },
    undefined,
    { onFork: fork },
  );
  const feedRow = paramRow(
    doc,
    state,
    "feedrate",
    `Feed (${doc.displayUnit}/min)`,
    () => state.feedrate,
    (v) => {
      state.feedrate = v;
    },
    "feed",
    { onFork: fork },
  );
  const plungeRow = paramRow(
    doc,
    state,
    "plungeRate",
    `Plunge (${doc.displayUnit}/min)`,
    () => state.plungeRate,
    (v) => {
      state.plungeRate = v;
    },
    "feed",
    { onFork: fork },
  );
  const safeZRow = paramRow(
    doc,
    state,
    "safeZ",
    `Safe Z (${doc.displayUnit})`,
    () => state.safeZ,
    (v) => {
      state.safeZ = v;
    },
    "len",
    { onFork: fork },
  );

  toolContent.appendChild(toolNumRow.el);
  toolContent.appendChild(diamRow.el);
  toolContent.appendChild(vAngleRow.el);
  toolContent.appendChild(tipAngleRow.el);
  toolContent.appendChild(tipRow.el);
  toolContent.appendChild(spindleRow.el);
  toolContent.appendChild(feedRow.el);
  toolContent.appendChild(plungeRow.el);
  toolContent.appendChild(safeZRow.el);
  toolSec.appendChild(toolContent);

  const updateToolTypeVisibility = () => {
    const tt = state.toolType;
    vAngleRow.el.style.display = tt === "v-bit" || tt === "tapered-ball-nose" ? "" : "none";
    tipRow.el.style.display = tt === "tapered-ball-nose" ? "" : "none";
    tipAngleRow.el.style.display = tt === "drill" ? "" : "none";
  };

  const applyToolDef = (t: ToolDef) => {
    state.toolId = t.id;
    // Embed (upsert) the tool in the document so the file is self-contained
    // and a single tool can drive multiple operations.
    const existingIdx = doc.tools.findIndex((x) => x.id === t.id);
    if (existingIdx >= 0) doc.tools[existingIdx] = { ...t };
    else doc.tools.push({ ...t });
    state.toolType = t.toolType;
    state.diameter = t.diameter;
    state.vAngle = t.vAngle ?? DEFAULTS.vAngle;
    state.tipAngle = t.tipAngle ?? DEFAULTS.tipAngle;
    state.tipDiameter = t.tipDiameter ?? DEFAULTS.tipDiameter;
    state.feedrate = t.feedrate;
    state.plungeRate = t.plungeRate;
    state.spindleSpeed = t.spindleSpeed;
    state.safeZ = t.safeZ;
    toolTypeSelect.value = t.toolType;
    diamRow.setValue(t.diameter);
    vAngleRow.setValue(state.vAngle);
    tipAngleRow.setValue(state.tipAngle);
    tipRow.setValue(state.tipDiameter);
    spindleRow.setValue(t.spindleSpeed);
    feedRow.setValue(t.feedrate);
    plungeRow.setValue(t.plungeRate);
    safeZRow.setValue(t.safeZ);
    updateToolTypeVisibility();
    events.emitUpdateVBitHint();
    // Picking a library tool sets the select's value directly, which fires no
    // `change` — so the notification has to be sent by hand or sections gated on
    // the tool type miss the library route entirely.
    events.emitToolTypeChanged(state.toolType);
  };

  updateToolTypeVisibility();
  toolTypeSelect.addEventListener("change", () => {
    fork();
    state.toolType = toolTypeSelect.value as ToolType;
    // A tapered ball-nose's tip is a BALL; leaving it 0 would make it a sharp
    // cone (i.e. a v-bit). Seed a real ball tip on first switch so the default is
    // never silently the wrong shape.
    if (state.toolType === "tapered-ball-nose" && !(state.tipDiameter > 0)) {
      state.tipDiameter = 1;
      tipRow.setValue(state.tipDiameter);
    }
    updateToolTypeVisibility();
    events.emitUpdateVBitHint();
    events.emitToolTypeChanged(state.toolType);
  });

  events.onSetToolType((t: ToolType) => {
    if (toolTypeSelect.value === t) return;
    toolTypeSelect.value = t;
    toolTypeSelect.dispatchEvent(new Event("change"));
  });

  return toolSec;
}
