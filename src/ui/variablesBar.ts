import type { CADDocument } from "../model/document";
import { makeVariable, isValidName, isDuplicateName, varMap } from "../model/variables";
import { parseLength } from "../core/units";
import { evalExpr } from "../core/expr";

export class VariablesBar {
  private content!: HTMLElement;
  private listEl!: HTMLElement;
  private isCollapsed = false;

  constructor(
    private host: HTMLElement,
    private doc: CADDocument,
    private runSolve: () => void,
    private pushHistory: () => void,
  ) {
    this.build();
    this.doc.onChange(() => this.render());
    this.render();
  }

  private build(): void {
    this.host.innerHTML = "";

    const header = document.createElement("div");
    header.className = "vars-header";

    const title = document.createElement("div");
    title.className = "vars-title";
    title.textContent = "Variables";
    header.appendChild(title);

    const toggleBtn = document.createElement("button");
    toggleBtn.className = "vars-toggle";
    toggleBtn.textContent = "›";
    toggleBtn.title = "Collapse/Expand";
    toggleBtn.addEventListener("click", () => this.toggleCollapse());
    header.appendChild(toggleBtn);

    this.host.appendChild(header);

    this.content = document.createElement("div");
    this.content.className = "vars-content";

    this.listEl = document.createElement("div");
    this.listEl.style.cssText = "display:flex;flex-direction:column;gap:4px;margin-bottom:8px;";
    this.content.appendChild(this.listEl);

    const addBtn = document.createElement("button");
    addBtn.className = "btn";
    addBtn.textContent = "+ Add variable";
    addBtn.style.width = "100%";
    addBtn.onclick = () => this.addVariable();
    this.content.appendChild(addBtn);

    this.host.appendChild(this.content);
  }

  private toggleCollapse(): void {
    this.isCollapsed = !this.isCollapsed;
    this.host.classList.toggle("collapsed", this.isCollapsed);
    this.host.addEventListener(
      "transitionend",
      () => {
        window.dispatchEvent(new Event("resize"));
      },
      { once: true },
    );
  }

  private render(): void {
    let focusVid: string | null = null;
    let focusField: string | null = null;
    if (document.activeElement instanceof HTMLElement) {
      focusVid = document.activeElement.dataset.vid || null;
      focusField = document.activeElement.dataset.field || null;
    }

    this.listEl.innerHTML = "";

    for (const v of this.doc.variables) {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;gap:4px;";

      // Name input
      const nameInput = document.createElement("input");
      nameInput.className = "dim";
      nameInput.value = v.name;
      nameInput.dataset.vid = v.id;
      nameInput.dataset.field = "name";
      nameInput.style.cssText = "width:72px;flex:0 0 72px;font-family:var(--mono);";
      nameInput.title = "Variable name";

      let selectNameOnMouseUp = false;
      nameInput.addEventListener("focus", () => {
        nameInput.select();
        selectNameOnMouseUp = true;
      });
      nameInput.addEventListener("mouseup", (e) => {
        if (selectNameOnMouseUp) {
          e.preventDefault();
          selectNameOnMouseUp = false;
        }
      });

      const eq = document.createElement("span");
      eq.textContent = "=";
      eq.style.color = "var(--text-muted, #888)";

      // Value/expression input
      const valInput = document.createElement("input");
      valInput.className = "dim";
      valInput.value = v.expr;
      valInput.dataset.vid = v.id;
      valInput.dataset.field = "val";
      valInput.style.cssText = "flex:1;min-width:0;font-family:var(--mono);";
      valInput.title = "Value (number, unit like 50mm, or a formula of other variables)";

      let selectValOnMouseUp = false;
      valInput.addEventListener("focus", () => {
        valInput.select();
        selectValOnMouseUp = true;
      });
      valInput.addEventListener("mouseup", (e) => {
        if (selectValOnMouseUp) {
          e.preventDefault();
          selectValOnMouseUp = false;
        }
      });

      // Flag a formula that no longer resolves (e.g. references a deleted variable).
      if (
        parseLength(v.expr, this.doc.displayUnit) === null &&
        evalExpr(v.expr, varMap(this.doc.variables, this.doc.stockThickness)) === null
      ) {
        valInput.style.borderColor = "var(--danger, #e05555)";
        valInput.title = "⚠ Formula error — unknown variable or invalid expression";
      }

      // Error label
      const errEl = document.createElement("span");
      errEl.style.cssText = "color:var(--danger);font-size:10px;display:none;";

      const showErr = (msg: string) => {
        errEl.textContent = msg;
        errEl.style.display = "inline";
        setTimeout(() => {
          errEl.style.display = "none";
        }, 2000);
      };

      // Commit name change on blur
      nameInput.addEventListener("blur", () => {
        const newName = nameInput.value.trim();
        const oldName = v.name; // capture before updateVariable mutates v
        if (newName === oldName) return;
        if (!isValidName(newName)) {
          showErr("Invalid name");
          nameInput.value = v.name;
          return;
        }
        if (isDuplicateName(newName, this.doc.variables, v.id)) {
          showErr("Duplicate");
          nameInput.value = v.name;
          return;
        }

        setTimeout(() => {
          this.pushHistory();
          this.doc.updateVariable(v.id, { name: newName });
          // Rewrite dimension + pattern expressions referencing the old name.
          this.doc.renameVariableRefs(oldName, newName);
          this.runSolve();
        }, 0);
      });
      nameInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          nameInput.blur();
        }
        e.stopPropagation();
      });

      // Commit value change on blur/enter
      const commitVal = () => {
        let newExpr = valInput.value.trim();
        // Replace commas used as decimal separators, e.g. "922,5" -> "922.5" or "0922,5" -> "0922.5"
        newExpr = newExpr.replace(/(\d+),(\d+)/g, "$1.$2");
        // Strip unnecessary leading zeroes before a non-zero number, e.g. "0922.5" -> "922.5"
        newExpr = newExpr.replace(/\b0+(?=[1-9])/g, "");
        if (newExpr === v.expr) return;
        setTimeout(() => {
          this.pushHistory();
          this.doc.updateVariable(v.id, { expr: newExpr });
          this.runSolve();
        }, 0);
      };
      valInput.addEventListener("blur", commitVal);
      valInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          valInput.blur();
        }
        e.stopPropagation();
      });

      // Delete button
      const delBtn = document.createElement("button");
      delBtn.className = "btn";
      delBtn.textContent = "×";
      delBtn.dataset.vid = v.id;
      delBtn.dataset.field = "del";
      delBtn.title = "Delete variable";
      delBtn.style.cssText = "padding:0 6px;flex:0 0 auto;";
      delBtn.onclick = () => {
        this.pushHistory();
        this.doc.removeVariable(v.id);
        this.runSolve();
      };

      row.appendChild(nameInput);
      row.appendChild(eq);
      row.appendChild(valInput);
      row.appendChild(delBtn);
      row.appendChild(errEl);
      this.listEl.appendChild(row);
    }

    if (focusVid && focusField) {
      setTimeout(() => {
        const toFocus = this.listEl.querySelector(
          `[data-vid="${focusVid}"][data-field="${focusField}"]`,
        ) as HTMLElement;
        if (toFocus) {
          toFocus.focus();
          if (toFocus instanceof HTMLInputElement) toFocus.select();
        }
      }, 0);
    }
  }

  private addVariable(): void {
    this.pushHistory();
    const name = this.uniqueName();
    const v = makeVariable(name, "0", this.doc.displayUnit);
    this.doc.addVariable(v);
    // Focus the name field of the newly added row so user can rename immediately
    setTimeout(() => {
      const inputs = this.listEl.querySelectorAll<HTMLInputElement>("input");
      const last = inputs[inputs.length - 2]; // name input is second-to-last before delete btn
      if (last) {
        last.focus();
        last.select();
      }
    }, 0);
  }

  private uniqueName(): string {
    let i = 1;
    while (isDuplicateName(`var${i}`, this.doc.variables)) i++;
    return `var${i}`;
  }
}
