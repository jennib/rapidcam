/**
 * Align toolbar. A small always-visible strip of centring actions that operate
 * on the current selection (the item(s) to move + the shape to centre them in).
 * Buttons enable only when the selection qualifies. Each fires the app's centre
 * command, which adds a live directional `center` constraint (see centerCommand).
 */

import type { CADDocument } from "../model/document";
import type { CenterAxis } from "../tools/centerCommand";
import { canCenter } from "../tools/centerCommand";

interface AlignButton {
  label: string;
  title: string;
  axis: CenterAxis;
}

const BUTTONS: AlignButton[] = [
  { label: "Center H", title: "Center horizontally in the selected shape", axis: "h" },
  { label: "Center V", title: "Center vertically in the selected shape", axis: "v" },
  { label: "Center", title: "Center in the selected shape (both axes)", axis: "both" },
];

export class AlignBar {
  private buttons: HTMLButtonElement[] = [];

  constructor(
    private host: HTMLElement,
    private doc: CADDocument,
    private onCenter: (axis: CenterAxis) => void,
  ) {
    this.build();
    this.doc.onChange(() => this.refresh());
    this.refresh();
  }

  private build(): void {
    const label = document.createElement("span");
    label.className = "cb-label";
    label.textContent = "Align";
    this.host.appendChild(label);

    for (const b of BUTTONS) {
      const btn = document.createElement("button");
      btn.className = "cbtn";
      btn.textContent = b.label;
      btn.title = b.title;
      btn.addEventListener("click", () => this.onCenter(b.axis));
      this.host.appendChild(btn);
      this.buttons.push(btn);
    }

    const hint = document.createElement("span");
    hint.className = "cb-msg";
    hint.textContent = "Select an item + the shape to centre it in";
    this.host.appendChild(hint);
    this.hint = hint;
  }

  private hint!: HTMLElement;

  private refresh(): void {
    const ok = canCenter(this.doc);
    for (const btn of this.buttons) btn.disabled = !ok;
    this.hint.style.display = ok ? "none" : "";
  }
}
