/**
 * Floating inline editor for dimension values.
 *
 * Owns the DOM element and input lifecycle. Business logic (solve, history,
 * validation) is delegated to the caller via `onCommit`, which returns true
 * on success (editor closes) or false on failure (editor flashes red and stays).
 */

import { Vec2 } from "../core/vec2";
import { Unit, parseLength, parseAngle, formatLength, formatAngle } from "../core/units";
import { Dimension } from "../model/dimensions";

/** Return true to close the editor; false to flash red and keep it open. */
type CommitFn = (value: number) => boolean;

interface OpenOptions {
  dim: Dimension;
  container: HTMLElement;
  screenPos: Vec2;
  displayUnit: Unit;
  onCommit: CommitFn;
}

export class DimEditor {
  private el: HTMLInputElement | null = null;

  get isOpen(): boolean {
    return this.el !== null;
  }

  open(opts: OpenOptions): void {
    this.close();

    const { dim, container, screenPos, displayUnit, onCommit } = opts;

    const input = document.createElement("input");
    input.type = "text";
    input.className = "dim-edit";
    input.value = dim.type === "angle"
      ? formatAngle(dim.value)
      : formatLength(dim.value, displayUnit);
    input.style.left = `${screenPos.x - 36}px`;
    input.style.top  = `${screenPos.y - 11}px`;

    const commit = () => {
      if (this.el !== input) return; // guard against double-commit on blur after close
      const raw = input.value;
      const v = dim.type === "angle" ? parseAngle(raw) : parseLength(raw, displayUnit);
      if (v !== null && v > 0) {
        const ok = onCommit(v);
        if (!ok) {
          input.style.color = "#e05555";
          setTimeout(() => { input.style.color = ""; }, 600);
          return;
        }
      }
      this.close();
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
      this.el = null; // set null first so blur handler sees it as already closed
      el.remove();
    }
  }
}
