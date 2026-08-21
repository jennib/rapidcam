/**
 * Align toolbar. A small always-visible strip of centring actions that operate
 * on the current selection (the item(s) to move + the shape to centre them in).
 * Buttons enable only when the selection qualifies. Each fires the app's centre
 * command, which adds a live directional `center` constraint (see centerCommand).
 */

import type { CADDocument } from "../model/document";
import type { CenterAxis } from "../tools/centerCommand";
import { canCenter } from "../tools/centerCommand";

/** Stroke icons for the three centring actions, matching ui/constraintIcons.ts. */
const wrap = (inner: string): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

const ICONS = {
  centerH: wrap(`<path d="M12 4v16" stroke-dasharray="3 3"/><rect x="3" y="7" width="6" height="10" rx="1"/><rect x="15" y="7" width="6" height="10" rx="1"/>`),
  centerV: wrap(`<path d="M4 12h16" stroke-dasharray="3 3"/><rect x="7" y="3" width="10" height="6" rx="1"/><rect x="7" y="15" width="10" height="6" rx="1"/>`),
  centerBoth: wrap(`<path d="M12 4v16M4 12h16" stroke-dasharray="3 3"/><rect x="8" y="8" width="8" height="8" rx="1"/>`),
} as const;

interface AlignButton {
  ariaLabel: string;
  title: string;
  axis: CenterAxis;
  icon: string;
}

const BUTTONS: AlignButton[] = [
  { ariaLabel: "Center horizontally", title: "Center horizontally in the selected shape", axis: "h", icon: ICONS.centerH },
  { ariaLabel: "Center vertically", title: "Center vertically in the selected shape", axis: "v", icon: ICONS.centerV },
  { ariaLabel: "Center both", title: "Center in the selected shape (both axes)", axis: "both", icon: ICONS.centerBoth },
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
      btn.innerHTML = b.icon;
      btn.title = b.title;
      btn.setAttribute("aria-label", b.ariaLabel);
      btn.addEventListener("click", () => this.onCenter(b.axis));
      this.host.appendChild(btn);
      this.buttons.push(btn);
    }
  }

  private refresh(): void {
    // Disabled buttons already communicate "this needs a selection"; the hint
    // that used to sit here was a permanent line of chrome saying so again.
    const ok = canCenter(this.doc);
    for (const btn of this.buttons) btn.disabled = !ok;
  }
}