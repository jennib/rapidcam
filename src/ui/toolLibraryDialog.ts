import { loadLibrary, saveLibrary, removeTool } from "../cam/toolLibrary";
import { type ToolDef, type ToolType, TOOL_TYPE_LABELS } from "../cam/types";
import { buildToolDiagram } from "./toolDiagram";
import { registerModal, confirmDialog } from "./modal";
import { type Unit, formatLength, formatFeed, toMM } from "../core/units";

export function openToolLibraryDialog(unit: Unit): void {
  document.getElementById("tlib-backdrop")?.remove();

  const lenView = (mm: number) => formatLength(mm, unit);
  const feedView = (mmPerMin: number) => formatFeed(mmPerMin, unit);

  let tools = loadLibrary();
  let selectedId: string | null = tools.length > 0 ? tools[0].id : null;
  // Deep copy for editing state
  let currentEdit: ToolDef | null = selectedId
    ? JSON.parse(JSON.stringify(tools.find((t) => t.id === selectedId)!))
    : null;

  const backdrop = document.createElement("div");
  backdrop.id = "tlib-backdrop";
  backdrop.className = "tp-backdrop";
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });

  const dialog = document.createElement("div");
  dialog.className = "tp-dialog tlib-dialog";
  dialog.style.width = "600px";
  dialog.style.height = "450px";
  dialog.style.maxWidth = "90vw";
  dialog.addEventListener("click", (e) => e.stopPropagation());
  backdrop.appendChild(dialog);

  // header
  const hdr = document.createElement("div");
  hdr.className = "tp-dialog-header";
  const titleEl = document.createElement("h3");
  titleEl.textContent = "Tool Library Manager";
  hdr.appendChild(titleEl);
  const closeBtn = document.createElement("button");
  closeBtn.className = "tp-dialog-close";
  closeBtn.innerHTML = "&#x2715;";
  closeBtn.addEventListener("click", () => close());
  hdr.appendChild(closeBtn);
  dialog.appendChild(hdr);

  // body (split layout)
  const body = document.createElement("div");
  body.className = "tp-dialog-body tlib-body-split";
  body.style.padding = "0";
  body.style.display = "flex";
  body.style.flexDirection = "row";
  dialog.appendChild(body);

  // sidebar
  const sidebar = document.createElement("div");
  sidebar.className = "tlib-sidebar";
  sidebar.style.width = "220px";
  sidebar.style.borderRight = "1px solid var(--border)";
  sidebar.style.display = "flex";
  sidebar.style.flexDirection = "column";
  sidebar.style.flex = "0 0 auto";
  body.appendChild(sidebar);

  const listEl = document.createElement("div");
  listEl.className = "tlib-list";
  listEl.style.flex = "1 1 auto";
  listEl.style.overflowY = "auto";
  sidebar.appendChild(listEl);

  const sidebarFooter = document.createElement("div");
  sidebarFooter.style.padding = "10px";
  sidebarFooter.style.borderTop = "1px solid var(--border)";
  sidebarFooter.style.flex = "0 0 auto";
  sidebar.appendChild(sidebarFooter);

  const addNewTool = () => {
    saveCurrentEdit(); // save anything currently being edited
    const newId = `tool-${Date.now()}`;
    const newTool: ToolDef = {
      id: newId,
      name: "New Tool",
      toolType: "end-mill",
      diameter: 6.35,
      feedrate: 1000,
      plungeRate: 300,
      spindleSpeed: 18000,
      safeZ: 5,
    };
    tools.push(newTool);
    saveLibrary(tools);
    selectedId = newId;
    currentEdit = JSON.parse(JSON.stringify(newTool));
    render();
  };

  const addBtn = document.createElement("button");
  addBtn.className = "cam-add-btn";
  addBtn.textContent = "+ New Tool";
  addBtn.addEventListener("click", addNewTool);
  sidebarFooter.appendChild(addBtn);

  // editor
  const editorWrap = document.createElement("div");
  editorWrap.style.flex = "1 1 auto";
  editorWrap.style.display = "flex";
  editorWrap.style.flexDirection = "column";
  editorWrap.style.overflowY = "auto";
  editorWrap.style.padding = "14px 16px";
  editorWrap.style.gap = "10px";
  body.appendChild(editorWrap);

  const saveCurrentEdit = () => {
    if (!currentEdit || !selectedId) return;
    const idx = tools.findIndex((t) => t.id === selectedId);
    if (idx >= 0) {
      tools[idx] = JSON.parse(JSON.stringify(currentEdit));
      saveLibrary(tools);
    }
  };

  const renderList = () => {
    listEl.innerHTML = "";
    if (tools.length === 0) {
      const empty = document.createElement("div");
      empty.style.padding = "12px";
      empty.style.color = "var(--text-dim)";
      empty.style.fontSize = "12px";
      empty.style.fontStyle = "italic";
      empty.style.textAlign = "center";
      empty.textContent = "Library is empty";
      listEl.appendChild(empty);
      return;
    }
    for (const t of tools) {
      const item = document.createElement("div");
      item.className = "tlib-list-item";
      item.style.padding = "8px 12px";
      item.style.cursor = "pointer";
      item.style.borderBottom = "1px solid var(--border)";
      item.style.fontSize = "12px";
      item.style.display = "flex";
      item.style.flexDirection = "column";
      item.style.gap = "2px";

      if (t.id === selectedId) {
        item.style.background = "var(--accent-dim)";
        item.style.color = "#fff";
      } else {
        item.addEventListener("mouseover", () => {
          item.style.background = "var(--panel-2)";
        });
        item.addEventListener("mouseout", () => {
          item.style.background = "transparent";
        });
        item.addEventListener("click", () => {
          saveCurrentEdit();
          selectedId = t.id;
          currentEdit = JSON.parse(JSON.stringify(t));
          render();
        });
      }

      const nameSpan = document.createElement("div");
      nameSpan.style.fontWeight = "600";
      nameSpan.textContent = t.name;
      item.appendChild(nameSpan);

      const descSpan = document.createElement("div");
      descSpan.style.fontSize = "11px";
      descSpan.style.opacity = "0.8";
      descSpan.textContent = `⌀${lenView(t.diameter)}${unit} ${TOOL_TYPE_LABELS[t.toolType]}`;
      item.appendChild(descSpan);

      listEl.appendChild(item);
    }
  };

  const renderEditor = () => {
    editorWrap.innerHTML = "";
    if (!currentEdit) {
      const empty = document.createElement("div");
      empty.style.color = "var(--text-dim)";
      empty.style.fontStyle = "italic";
      empty.textContent = "Select a tool to edit.";
      editorWrap.appendChild(empty);
      return;
    }

    const t = currentEdit;

    // Header actions
    const headerRow = document.createElement("div");
    headerRow.style.display = "flex";
    headerRow.style.justifyContent = "flex-end";
    headerRow.style.marginBottom = "4px";

    const delBtn = document.createElement("button");
    delBtn.className = "btn";
    delBtn.textContent = "Delete Tool";
    delBtn.style.color = "var(--danger)";
    delBtn.addEventListener("click", async () => {
      const ok = await confirmDialog({
        title: "Delete tool?",
        message: `Delete "${t.name}" from the tool library?`,
        confirmLabel: "Delete",
        danger: true,
      });
      if (ok) {
        removeTool(t.id);
        tools = loadLibrary();
        selectedId = tools.length > 0 ? tools[0].id : null;
        currentEdit = selectedId ? JSON.parse(JSON.stringify(tools[0])) : null;
        render();
      }
    });
    headerRow.appendChild(delBtn);
    editorWrap.appendChild(headerRow);

    const makeField = (label: string, control: HTMLElement) => {
      const f = document.createElement("div");
      f.className = "tp-field";
      const l = document.createElement("label");
      l.textContent = label;
      f.appendChild(l);
      f.appendChild(control);
      return f;
    };

    // Name
    const nameInp = document.createElement("input");
    nameInp.type = "text";
    nameInp.className = "dim";
    nameInp.value = t.name;
    nameInp.addEventListener("input", () => {
      t.name = nameInp.value;
      renderList();
    });
    editorWrap.appendChild(makeField("Name", nameInp));

    // Type
    const typeSel = document.createElement("select");
    typeSel.className = "unit";
    for (const [v, l] of Object.entries(TOOL_TYPE_LABELS) as [ToolType, string][]) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = l;
      typeSel.appendChild(o);
    }
    typeSel.value = t.toolType;
    typeSel.addEventListener("change", () => {
      t.toolType = typeSel.value as ToolType;
      render();
    });
    editorWrap.appendChild(makeField("Tool Type", typeSel));

    // Labelled diagram of the current tool. Rebuilt on type change (full
    // re-render) and redrawn live as the geometry fields are typed.
    const diagramBox = document.createElement("div");
    diagramBox.className = "tlib-diagram";
    diagramBox.style.cssText =
      "background:var(--panel-2);border:1px solid var(--border);border-radius:6px;" +
      "padding:6px 8px 4px;display:flex;flex-direction:column;align-items:center";
    const caption = document.createElement("div");
    caption.textContent = "Angle to scale · diameters labelled, not to scale";
    caption.style.cssText = "font-size:10px;color:var(--text-dim);margin-top:2px;text-align:center";
    const redrawDiagram = () => {
      diagramBox.replaceChildren(buildToolDiagram(t), caption);
    };
    editorWrap.appendChild(diagramBox);

    // Numeric inputs helper. `live` fields also redraw the diagram as you type.
    const numField = (
      label: string,
      get: () => number | undefined,
      set: (v: number) => void,
      live = false,
      unitConv?: "len" | "feed"
    ) => {
      const inp = document.createElement("input");
      inp.type = "number";
      inp.className = "dim";
      inp.step = "any";

      const toView = (v: number): string =>
        unitConv === "feed" ? feedView(v) : unitConv === "len" ? lenView(v) : String(v);
      const toModel = (v: number) => (unitConv ? toMM(v, unit) : v);

      const current = get();
      inp.value = current !== undefined ? toView(current) : "";

      inp.addEventListener("change", () => {
        const v = parseFloat(inp.value);
        if (Number.isFinite(v)) set(toModel(v));
      });
      if (live)
        inp.addEventListener("input", () => {
          const v = parseFloat(inp.value);
          if (Number.isFinite(v)) {
            set(toModel(v));
            redrawDiagram();
          }
        });
      return makeField(label, inp);
    };

    editorWrap.appendChild(
      numField(
        `Diameter (${unit})`,
        () => t.diameter,
        (v) => {
          t.diameter = v;
          renderList();
        },
        true,
        "len",
      ),
    );

    if (t.toolType === "v-bit" || t.toolType === "tapered-ball-nose") {
      editorWrap.appendChild(
        numField(
          "V Angle (°)",
          () => t.vAngle,
          (v) => {
            t.vAngle = v;
          },
          true,
        ),
      );
      editorWrap.appendChild(
        numField(
          `Tip Diam (${unit})`,
          () => t.tipDiameter,
          (v) => {
            t.tipDiameter = v;
          },
          true,
          "len",
        ),
      );
    }
    if (t.toolType === "drill") {
      editorWrap.appendChild(
        numField(
          "Tip Angle (°)",
          () => t.tipAngle,
          (v) => {
            t.tipAngle = v;
          },
          true,
        ),
      );
    }

    redrawDiagram();

    editorWrap.appendChild(
      numField(
        "Spindle (rpm)",
        () => t.spindleSpeed,
        (v) => {
          t.spindleSpeed = Math.round(v);
        },
      ),
    );
    editorWrap.appendChild(
      numField(
        `Feed (${unit}/min)`,
        () => t.feedrate,
        (v) => {
          t.feedrate = v;
        },
        false,
        "feed",
      ),
    );
    editorWrap.appendChild(
      numField(
        `Plunge (${unit}/min)`,
        () => t.plungeRate,
        (v) => {
          t.plungeRate = v;
        },
        false,
        "feed",
      ),
    );
    editorWrap.appendChild(
      numField(
        `Safe Z (${unit})`,
        () => t.safeZ,
        (v) => {
          t.safeZ = v;
        },
        false,
        "len",
      ),
    );
  };

  const render = () => {
    renderList();
    renderEditor();
  };

  const close = () => {
    saveCurrentEdit();
    unregister();
    backdrop.remove();
  };

  const unregister = registerModal(backdrop, close);
  document.body.appendChild(backdrop);
  render();
}
