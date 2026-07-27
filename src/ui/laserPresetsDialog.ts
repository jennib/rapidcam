/**
 * Manager for saved laser material recipes — rename, retune, delete.
 *
 * Recipes are *created* from the toolpath dialog ("Save as preset…"), because
 * that is where you have just dialled in numbers that worked. This dialog is for
 * housekeeping afterwards, so it deliberately has no "new preset" button: an
 * empty recipe invented in a manager is exactly the untested guess this feature
 * exists to avoid.
 */

import {
  loadPresets,
  removePreset,
  savePresets,
  type LaserPresetKind,
} from "../cam/laserPresets";
import { confirmDialog, registerModal } from "./modal";
import { formatFeed, formatLength, toMM, type Unit } from "../core/units";

const KIND_LABELS: Record<LaserPresetKind, string> = {
  cut: "Cut",
  engrave: "Engrave",
  score: "Score",
};

export function openLaserPresetsDialog(unit: Unit): void {
  document.getElementById("lpre-backdrop")?.remove();

  let presets = loadPresets();

  const backdrop = document.createElement("div");
  backdrop.id = "lpre-backdrop";
  backdrop.className = "tp-backdrop";
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });

  const dialog = document.createElement("div");
  dialog.className = "tp-dialog lpre-dialog";
  dialog.style.width = "560px";
  dialog.style.maxWidth = "90vw";
  dialog.addEventListener("click", (e) => e.stopPropagation());
  backdrop.appendChild(dialog);

  const hdr = document.createElement("div");
  hdr.className = "tp-dialog-header";
  const titleEl = document.createElement("h3");
  titleEl.textContent = "Laser Material Presets";
  hdr.appendChild(titleEl);
  const closeBtn = document.createElement("button");
  closeBtn.className = "tp-dialog-close";
  closeBtn.innerHTML = "&#x2715;";
  closeBtn.addEventListener("click", () => close());
  hdr.appendChild(closeBtn);
  dialog.appendChild(hdr);

  const body = document.createElement("div");
  body.className = "tp-dialog-body";
  dialog.appendChild(body);

  const list = document.createElement("div");
  list.className = "lpre-list";
  body.appendChild(list);

  /** Commit the in-memory list to storage and repaint. */
  const persist = (): void => {
    savePresets(presets);
    render();
  };

  const numberField = (
    label: string,
    value: number,
    toView: (v: number) => string,
    onCommit: (v: number) => void,
  ): HTMLElement => {
    const inp = document.createElement("input");
    inp.type = "number";
    inp.step = "any";
    inp.className = "dim";
    inp.style.width = "78px";
    inp.value = toView(value);
    inp.addEventListener("change", () => {
      const v = parseFloat(inp.value);
      if (Number.isFinite(v)) {
        onCommit(v);
        persist();
      } else {
        inp.value = toView(value); // reject junk, restore what was there
      }
    });
    const wrap = document.createElement("label");
    wrap.className = "lpre-num";
    wrap.style.cssText = "display:flex;flex-direction:column;gap:2px;font-size:11px;";
    const cap = document.createElement("span");
    cap.style.opacity = "0.65";
    cap.textContent = label;
    wrap.append(cap, inp);
    return wrap;
  };

  function render(): void {
    list.innerHTML = "";

    if (presets.length === 0) {
      const empty = document.createElement("div");
      empty.className = "lpre-empty";
      empty.style.cssText = "padding:18px 4px;font-size:12px;color:var(--text-dim);line-height:1.6;";
      // Deliberately points at measurement rather than offering starter numbers:
      // power/speed are specific to this machine, tube age, lens and material.
      empty.textContent =
        "No presets yet. Laser power and speed depend on your machine and material, " +
        "so there are no useful defaults to ship. Run a Material Test, find the cell " +
        "that cut or engraved cleanly, then use “Save as preset…” in the toolpath dialog.";
      list.appendChild(empty);
      return;
    }

    for (const p of presets) {
      const rowEl = document.createElement("div");
      rowEl.className = "lpre-item";
      rowEl.style.cssText =
        "display:flex;flex-direction:column;gap:6px;padding:10px;margin-bottom:8px;" +
        "border:1px solid var(--border);border-radius:6px;background:var(--panel);";

      const top = document.createElement("div");
      top.style.cssText = "display:flex;align-items:center;gap:8px;";

      const nameInp = document.createElement("input");
      nameInp.type = "text";
      nameInp.className = "dim lpre-name";
      nameInp.style.flex = "1";
      nameInp.value = p.name;
      nameInp.addEventListener("change", () => {
        const next = nameInp.value.trim();
        if (!next) {
          nameInp.value = p.name; // a nameless preset is unpickable
          return;
        }
        p.name = next;
        persist();
      });

      const kindBadge = document.createElement("span");
      kindBadge.className = "lpre-kind";
      kindBadge.style.cssText =
        "font-size:10px;text-transform:uppercase;letter-spacing:0.04em;padding:2px 6px;" +
        "border-radius:3px;background:var(--panel-2);color:var(--text-dim);";
      kindBadge.textContent = KIND_LABELS[p.kind];

      const delBtn = document.createElement("button");
      delBtn.className = "btn lpre-delete";
      delBtn.textContent = "Delete";
      delBtn.addEventListener("click", async () => {
        const ok = await confirmDialog({
          title: "Delete preset",
          message: `Delete “${p.name}”? This cannot be undone.`,
          confirmLabel: "Delete",
          danger: true,
        });
        if (!ok) return;
        removePreset(p.id);
        presets = loadPresets();
        render();
      });

      top.append(nameInp, kindBadge, delBtn);
      rowEl.appendChild(top);

      const nums = document.createElement("div");
      nums.className = "lpre-nums";
      nums.style.cssText = "display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;";
      nums.append(
        numberField("Power (%)", p.laserPower, String, (v) => {
          p.laserPower = Math.min(100, Math.max(0, v));
        }),
        numberField("Passes", p.laserPasses, String, (v) => {
          p.laserPasses = Math.max(1, Math.round(v));
        }),
        numberField(
          `Feed (${unit}/min)`,
          p.feedrate,
          (v) => formatFeed(v, unit),
          (v) => {
            p.feedrate = Math.max(1, toMM(v, unit));
          },
        ),
      );

      // Kerf is a cut-only compensation, and only cut recipes carry one — an
      // engrave preset showing a kerf box would invite setting a value that is
      // never applied.
      if (p.kind === "cut") {
        nums.appendChild(
          numberField(
            `Kerf (${unit})`,
            p.kerfWidth ?? 0,
            (v) => formatLength(v, unit),
            (v) => {
              p.kerfWidth = Math.max(0, toMM(v, unit));
            },
          ),
        );
      }

      // Air assist rides with the recipe because it changes the cut as much as
      // power does — the same numbers with the blower off char and catch.
      const airChk = document.createElement("input");
      airChk.type = "checkbox";
      airChk.className = "settings-checkbox lpre-air";
      airChk.checked = p.airAssist ?? false;
      airChk.addEventListener("change", () => {
        p.airAssist = airChk.checked;
        persist();
      });
      const airWrap = document.createElement("label");
      airWrap.style.cssText =
        "display:flex;align-items:center;gap:5px;font-size:11px;padding-bottom:4px;";
      const airCap = document.createElement("span");
      airCap.style.opacity = "0.65";
      airCap.textContent = "Air assist";
      airWrap.append(airChk, airCap);
      nums.appendChild(airWrap);

      rowEl.appendChild(nums);
      list.appendChild(rowEl);
    }
  }

  const footer = document.createElement("div");
  footer.className = "tp-dialog-footer";
  const doneBtn = document.createElement("button");
  doneBtn.className = "btn tp-apply-btn";
  doneBtn.textContent = "Done";
  doneBtn.addEventListener("click", () => close());
  footer.appendChild(doneBtn);
  dialog.appendChild(footer);

  render();
  document.body.appendChild(backdrop);

  const unregister = registerModal(backdrop, () => close());
  function close(): void {
    unregister();
    backdrop.remove();
  }
}

/** Exported for the toolpath dialog's kind badge, so the label lives in one place. */
export { KIND_LABELS as LASER_PRESET_KIND_LABELS };
