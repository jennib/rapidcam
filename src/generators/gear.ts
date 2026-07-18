/**
 * Involute spur-gear generator — the second worked generator, chosen to stress
 * the Sketch vocabulary from a very different shape than the box joint: curved
 * involute flanks (many computed points), and MULTI-entity output (the toothed
 * body as a closed polyline plus a bore circle) so the runner's group/feature
 * and work-area centring are exercised over more than one entity.
 *
 * Standard full-depth involute teeth: pitch radius rp = module·N/2, base radius
 * rb = rp·cos(pressure angle), addendum (tip) at rp+module, dedendum (root) at
 * rp−1.25·module. Below the base circle the flank drops radially to the root (a
 * common approximation — no trochoidal fillet). Drawn centred on the origin;
 * the runner places it in the work area.
 */

import type { Generator } from "./index";
import type { Pt } from "./sketch";

export const gear: Generator = {
  id: "spur-gear",
  name: "Spur Gear",
  build(s) {
    const teeth = s.param("teeth", 20, { min: 6, int: true, label: "Teeth" });
    const module = s.param("module", 2, { min: 0.1, label: "Module (mm)" });
    const paDeg = s.param("pressureAngle", 20, { min: 10, max: 30, label: "Pressure angle (°)" });
    const bore = s.param("bore", 6, { min: 0, label: "Bore Ø (mm)" });
    // Below ~17 teeth (for a 20° pressure angle) the involute flank at the base
    // circle undercuts into the root, weakening the tooth root and roughening
    // the profile — a heads-up, not a hard limit (min stays 6, matching before).
    if (teeth < 17) s.note("Below ~17 teeth, involute flanks are undercut — mesh may be rough.");

    const alpha = (paDeg * Math.PI) / 180;
    const rp = (module * teeth) / 2; // pitch radius
    const rb = rp * Math.cos(alpha); // base radius
    const ra = rp + module; // addendum / tip radius
    const rRoot = Math.max(0.1, rp - 1.25 * module); // dedendum / root radius
    const invA = Math.tan(alpha) - alpha; // involute of the pressure angle
    // Angle from a tooth's centreline to its flank, at the base circle.
    const halfBase = Math.PI / (2 * teeth) + invA;

    // Angular offset of a flank from its tooth centre at radius r (≥ rb). The
    // involute narrows the tooth as r grows, so this shrinks toward the tip.
    const flankOffset = (r: number): number => {
      const phi = Math.acos(Math.min(1, rb / r));
      return halfBase - (Math.tan(phi) - phi);
    };

    const rStart = Math.max(rb, rRoot); // where the involute flank begins
    const FLANK = 8,
      TIP = 4,
      ROOT = 4;
    const pts: Pt[] = [];
    const at = (r: number, ang: number) => pts.push({ x: r * Math.cos(ang), y: r * Math.sin(ang) });

    for (let k = 0; k < teeth; k++) {
      const g = (k * 2 * Math.PI) / teeth; // this tooth's centreline angle
      // Radial drop from the base circle down to the root, right flank side.
      if (rRoot < rStart) at(rRoot, g - flankOffset(rStart));
      // Right flank: root → tip.
      for (let i = 0; i <= FLANK; i++) {
        const r = rStart + ((ra - rStart) * i) / FLANK;
        at(r, g - flankOffset(r));
      }
      // Tip land: arc across the top of the tooth.
      const tipR = g - flankOffset(ra),
        tipL = g + flankOffset(ra);
      for (let i = 1; i < TIP; i++) at(ra, tipR + ((tipL - tipR) * i) / TIP);
      // Left flank: tip → root.
      for (let i = 0; i <= FLANK; i++) {
        const r = ra - ((ra - rStart) * i) / FLANK;
        at(r, g + flankOffset(r));
      }
      if (rRoot < rStart) at(rRoot, g + flankOffset(rStart));
      // Root land: arc along the root circle to the next tooth's right flank.
      const nextRight = g + (2 * Math.PI) / teeth - flankOffset(rStart);
      const leftRoot = g + flankOffset(rStart);
      for (let i = 1; i < ROOT; i++) at(rRoot, leftRoot + ((nextRight - leftRoot) * i) / ROOT);
    }

    const body = s.polyline(pts, { closed: true });
    // Through profile cut. NO corner relief: dog-boning the concave involute
    // roots would gouge spurious overcuts into the tooth flanks.
    s.suggestOp({
      name: "Gear — Profile (outside)",
      kind: "profile-outside",
      targets: [body],
      depth: "through",
    });
    const out = [body];
    if (bore > 0) {
      const boreH = s.circle({ x: 0, y: 0 }, bore / 2);
      // Inside profile for the bore. The default 6 mm end mill is degenerate
      // inside a small bore (empty toolpath, silently) — clamp the suggested
      // tool to half the bore so the op cuts out of the box.
      s.suggestOp({
        name: "Bore — Profile (inside)",
        kind: "profile-inside",
        targets: [boreH],
        depth: "through",
        toolDiameter: Math.min(6, bore / 2),
      });
      out.push(boreH);
    }
    return out;
  },
};
