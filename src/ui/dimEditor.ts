/**
 * Floating inline editor for dimension values.
 *
 * Owns the DOM element and input lifecycle. Business logic (solve, history,
 * validation) is delegated to the caller via `onCommit`, which returns true
 * on success (editor closes) or false on failure (editor flashes red and stays).
 *
 * Supports plain numbers ("25"), unit suffixes ("25mm"), and variable
 * expressions ("width * 2"). Expressions referencing variable names are
 * passed back to the caller as the optional `expr` argument on `onCommit`.
 */

import { Unit, parseLength, parseAngle, formatLength, formatAngle } from "../core/units";
import { Dimension } from "../model/dimensions";
import { evalExpr, exprUsesVars, VarMap } from "../core/expr";

/** Return true to close the editor; false to flash red and keep it open. */
export type CommitFn = (value: number, expr?: string) => boolean;

interface OpenOptions {
  dim: Dimension;
  container: HTMLElement;
  screenPos: { x: number; y: number };
  displayUnit: Unit;
  vars?: VarMap;
  onCommit: CommitFn;
}

export class DimEditor {
  private el: HTMLInputElement | null = null;
  private datalist: HTMLDataListElement | null = null;

  get isOpen(): boolean {
    return this.el !== null;
  }

  open(opts: OpenOptions): void {
    this.close();

    const { dim, container, screenPos, displayUnit, vars = new Map(), onCommit } = opts;

    const input = document.createElement("input");
    input.type = "text";
    input.className = "dim-edit";

    // Show expression string when re-editing a formula-driven dimension
    input.value = (dim.type !== "angle" && dim.expr)
      ? dim.expr
      : dim.type === "angle"
        ? formatAngle(dim.value)
        : formatLength(dim.value, displayUnit);

    input.style.left = `${screenPos.x - 36}px`;
    input.style.top  = `${screenPos.y - 11}px`;

    // Variable name autocomplete via native <datalist>
    if (vars.size > 0) {
      const dl = document.createElement("datalist");
      dl.id = `_dim-vars-${Math.random().toString(36).slice(2)}`;
      for (const name of vars.keys()) {
        const opt = document.createElement("option");
        opt.value = name;
        dl.appendChild(opt);
      }
      container.appendChild(dl);
      input.setAttribute("list", dl.id);
      this.datalist = dl;
    }

    const commit = () => {
      if (this.el !== input) return; // guard against double-commit on blur after close
      const raw = input.value.trim();

      if (dim.type === "angle") {
        const v = parseAngle(raw);
        if (v !== null && v > 0) {
          const ok = onCommit(v);
          if (!ok) { this.flash(input); return; }
        }
        this.close();
        return;
      }

      // Try expression evaluator first (handles variable references + arithmetic)
      const exprVal = evalExpr(raw, vars);
      if (exprVal !== null && exprVal > 0) {
        const expr = exprUsesVars(raw) ? raw : undefined;
        const ok = onCommit(exprVal, expr);
        if (!ok) { this.flash(input); return; }
        this.close();
        return;
      }

      // Fallback: plain number with optional unit suffix (e.g. "25mm", "1in")
      const lenVal = parseLength(raw, displayUnit);
      if (lenVal !== null && lenVal > 0) {
        const ok = onCommit(lenVal, undefined);
        if (!ok) { this.flash(input); return; }
        this.close();
        return;
      }

      this.flash(input);
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") commit();
      else if (e.key === "Escape") this.close();
      e.stopPropagation();
    });
    input.addEventListener("blur", commit);

    container.appendChild(input);
    this.el = input;
    input.focus();
    input.select();
  }

  close(): void {
    if (this.el) {
      const el = this.el;
      this.el = null;
      el.remove();
    }
    if (this.datalist) {
      this.datalist.remove();
      this.datalist = null;
    }
  }

  private flash(input: HTMLInputElement): void {
    input.style.color = "#e05555";
    setTimeout(() => { if (this.el === input) input.style.color = ""; }, 600);
  }
}
