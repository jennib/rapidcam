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

import { type Unit, parseLength, parseAngle, formatLength, formatAngle } from "../core/units";
import type { Dimension } from "../model/dimensions";
import { evalExpr, validateExpr, type VarMap } from "../core/expr";

/** Return true to close the editor; false to flash red and keep it open. */
export type CommitFn = (value: number, expr?: string) => boolean;

interface OpenOptions {
  dim: Dimension;
  container: HTMLElement;
  screenPos: { x: number; y: number };
  displayUnit: Unit;
  vars?: VarMap;
  onCommit: CommitFn;
  /**
   * Say WHY a commit was refused. Four unrelated failures — an unparseable
   * number, a syntax error, a reference to a variable that does not exist, and
   * a value the solver could not satisfy — all used to surface as the same
   * wordless red flash, leaving no way to tell a typo from an
   * over-constrained sketch.
   */
  onError?: (message: string) => void;
  /**
   * Why the last onCommit refused, when the caller can be specific — an
   * exhausted sketch and an unreachable value need different fixes. Falls back
   * to a generic message.
   */
  commitFailureReason?: () => string | null;
}

export class DimEditor {
  private el: HTMLInputElement | null = null;
  private datalist: HTMLDataListElement | null = null;
  private errEl: HTMLElement | null = null;

  get isOpen(): boolean {
    return this.el !== null;
  }

  open(opts: OpenOptions): void {
    this.close();

    const {
      dim,
      container,
      screenPos,
      displayUnit,
      vars = new Map(),
      onCommit,
      onError,
      commitFailureReason,
    } = opts;

    const input = document.createElement("input");
    input.type = "text";
    input.className = "dim-edit";

    // Show expression string when re-editing a formula-driven dimension
    input.value =
      dim.type !== "angle" && dim.expr
        ? dim.expr
        : dim.type === "angle"
          ? formatAngle(dim.value)
          : formatLength(dim.value, displayUnit);

    input.style.left = `${screenPos.x - 36}px`;
    input.style.top = `${screenPos.y - 11}px`;

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

    /** Refuse the commit, flash, and say why. */
    const reject = (reason: string) => {
      this.flash(input);
      input.title = reason; // also readable on hover
      this.showError(container, screenPos, reason);
      onError?.(reason);
    };
    /** Why `raw` could not be turned into a usable value. */
    const explain = (raw: string): string => {
      if (!raw) return "Enter a value";
      const bad = validateExpr(raw, vars);
      // e.g. "Unknown variable: Cup_to_Bottom", "Missing closing parenthesis".
      if (bad) return bad;
      return "Value must be greater than zero"; // parsed fine, so it was <= 0
    };
    const solverRefused = (): string =>
      commitFailureReason?.() ??
      "That value can't be solved — the sketch may be over-constrained";

    const commit = () => {
      if (this.el !== input) return; // guard against double-commit on blur after close
      const raw = input.value.trim();

      if (dim.type === "angle") {
        const v = parseAngle(raw);
        if (v === null || v <= 0) {
          reject(raw ? "Enter an angle greater than zero" : "Enter an angle");
          return;
        }
        if (!onCommit(v)) {
          reject(solverRefused());
          return;
        }
        this.close();
        return;
      }

      // Try parseLength first — converts display-unit numbers correctly
      // (e.g. "24" in an inches project → 609.6 mm, not 24 mm).
      const lenVal = parseLength(raw, displayUnit);
      if (lenVal !== null && lenVal > 0) {
        if (!onCommit(lenVal, undefined)) {
          reject(solverRefused());
          return;
        }
        this.close();
        return;
      }

      // Fall back to expression evaluator for variable references / arithmetic
      // (e.g. "width * 2"). Variable values are already in internal mm units.
      const exprVal = evalExpr(raw, vars);
      if (exprVal === null || exprVal <= 0) {
        reject(explain(raw));
        return;
      }
      if (!onCommit(exprVal, raw)) {
        reject(solverRefused());
        return;
      }
      this.close();
    };

    // Drop a stale reason as soon as the user starts fixing the input.
    input.addEventListener("input", () => {
      input.title = "";
      this.clearError();
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") commit();
      // First Escape dismisses the error, keeping the text you were fixing;
      // a second one abandons the edit.
      else if (e.key === "Escape" && this.errEl) this.clearError();
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
    this.clearError();
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

  /**
   * Show why the edit was refused, until dismissed. A transient status-bar
   * flash was unreadable in practice ("goes away too quickly and I cannot read
   * it"), so this sits by the input and waits: closed by its ×, by Escape, by
   * editing the value, or when the editor closes. It never takes focus — the
   * input has to stay ready for the correction.
   */
  private showError(container: HTMLElement, screenPos: { x: number; y: number }, msg: string): void {
    this.clearError();
    const box = document.createElement("div");
    box.className = "dim-error";
    box.setAttribute("role", "alert");

    const text = document.createElement("span");
    text.textContent = msg;
    box.appendChild(text);

    const close = document.createElement("button");
    close.className = "dim-error-close";
    close.type = "button";
    close.textContent = "×";
    close.setAttribute("aria-label", "Dismiss");
    close.tabIndex = -1; // never steal focus from the value being corrected
    close.addEventListener("mousedown", (e) => e.preventDefault()); // don't blur-commit
    close.addEventListener("click", () => this.clearError());
    box.appendChild(close);

    box.style.left = `${screenPos.x - 36}px`;
    box.style.top = `${screenPos.y + 16}px`;
    container.appendChild(box);
    this.errEl = box;

    // Nudge back inside if the bubble would hang off the right or bottom edge.
    const host = container.getBoundingClientRect();
    const r = box.getBoundingClientRect();
    if (r.right > host.right - 4) {
      box.style.left = `${Math.max(4, screenPos.x - 36 - (r.right - host.right + 4))}px`;
    }
    if (r.bottom > host.bottom - 4) box.style.top = `${screenPos.y - 16 - r.height}px`;
  }

  private clearError(): void {
    this.errEl?.remove();
    this.errEl = null;
  }

  private flash(input: HTMLInputElement): void {
    input.style.color = "#e05555";
    setTimeout(() => {
      if (this.el === input) input.style.color = "";
    }, 600);
  }
}
