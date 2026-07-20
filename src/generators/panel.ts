/**
 * Panel — the plainest resizable primitive: a rectangular blank with an optional
 * recessed inner panel. This is the on-ramp the editor's Rectangle tool can't be:
 * the tool emits four independent lines (so each edge stays separately
 * constrainable — an intentional decision), which leaves a new user with no
 * single object carrying a Width/Height they can drive from one number. A Panel
 * feature is that object — one {@link RectEntity} (whole-shape Width/Height in the
 * properties panel, every param expression-drivable and re-editable), so "make me
 * a 400×300 door and let me resize it" is one insert plus one field.
 *
 * With `panelInset > 0` it also draws an inset inner rectangle on its own layer —
 * the classic cabinet-door-with-a-recessed-panel — suggested as a pocket at
 * `panelDepth`, while the outer stays a through profile cut. Square corners keep
 * both shapes as clean RectEntities; rounded corners are a separate follow-up.
 *
 * All parameters go through `s.param`, so the generator dialog renders an editor
 * and a re-run reproduces the geometry — the point of the parametric feature model.
 */

import type { Generator } from "./index";
import type { Handle } from "./sketch";

export const panel: Generator = {
  id: "panel",
  name: "Panel",
  build(s) {
    const width = s.param("width", 150, { min: 1, label: "Width" });
    const height = s.param("height", 100, { min: 1, label: "Height" });
    // 0 = a plain blank (no inner panel). >0 insets the recessed panel by that
    // margin from every outer edge.
    const panelInset = s.param("panelInset", 0, { min: 0, label: "Panel inset (0 = none)" });
    const panelDepth = s.param("panelDepth", 6, { min: 0, label: "Panel depth" });

    // Outer blank: one whole-shape rectangle with its bottom-left at the origin
    // (the runner centres it on the work area). Keyed so a CAM op or constraint
    // attached to it survives parameter edits.
    s.key("outer");
    const outer = s.rect({ x: 0, y: 0 }, { w: width, h: height });

    // Inner recessed panel, inset on all sides. Only when it stays positive —
    // an inset ≥ half the smaller side would collapse or invert it, so omit it
    // and say why rather than emit a degenerate rectangle.
    const iw = width - 2 * panelInset;
    const ih = height - 2 * panelInset;
    let inner: Handle | null = null;
    if (panelInset > 0) {
      if (iw > 0 && ih > 0) {
        s.layer("Panel", "#6366f1");
        s.key("panel");
        inner = s.rect({ x: panelInset, y: panelInset }, { w: iw, h: ih });
        s.layer(); // back to the default layer
        s.note("Inner panel is a pocket; the outer edge is a through profile cut.");
      } else {
        s.note("Panel inset is too large for the panel size — inner panel omitted.");
      }
    }

    // CAM intent: the outer is a through outside profile (hold-down tabs on by
    // default); the recessed panel is a pocket at panelDepth. A zero depth means
    // the user wants only the scribe line, so skip the pocket op then.
    s.suggestOp({
      name: "Panel — Profile (outside)",
      kind: "profile-outside",
      targets: [outer],
      depth: "through",
    });
    if (inner && panelDepth > 0) {
      s.suggestOp({
        name: "Recessed panel — Pocket",
        kind: "pocket",
        targets: [inner],
        depth: -panelDepth,
      });
    }

    return inner ? [outer, inner] : [outer];
  },
};
