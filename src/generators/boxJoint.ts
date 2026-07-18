/**
 * Box-joint panel generator — the first worked generator against the Sketch
 * vocabulary. Produces a rectangular panel whose TOP edge is combed into finger
 * joints: `fingers` equal-width fingers alternate between a tab (flush with the
 * panel top) and a slot cut down by the material `thickness`, so two such panels
 * mesh at a right angle. The result is a single closed polyline outline.
 *
 * All parameters are declared through `s.param`, so a host can render an editor
 * and re-run with new values — the whole point of the parametric feature model.
 */

import type { Generator } from "./index";

export const boxJoint: Generator = {
  id: "box-joint",
  name: "Box Joint Panel",
  build(s) {
    const width = s.param("width", 120, { min: 1, label: "Width" });
    const height = s.param("height", 50, { min: 1, label: "Height" });
    const thickness = s.param("thickness", 6, { min: 0.1, label: "Material thickness" });
    const fingers = s.param("fingers", 6, { min: 1, int: true, label: "Fingers" });
    // Clamped so a boundary can never cross the middle of a run's neighbour —
    // at c = w the two shifts at a boundary (±c/2 each) would meet, degenerating
    // a tab/slot to zero width; 0.9 keeps a visible margin short of that.
    const clearance = s.param("clearance", 0, { min: 0, label: "Joint clearance" });

    const w = width / fingers;
    const c = Math.min(clearance, (w / 2) * 0.9);
    const top = height;

    // Boundary x-positions between runs, nominally k·w. Clearance shifts each
    // INTERIOR boundary (k = 1…fingers-1) by c/2 into whichever neighbour is a
    // tab, so every slot widens by c/2 per mating face and tabs narrow to match
    // (a snugger printed/cut fit compensates for kerf/tolerance). Run k-1 lies
    // left of boundary k; it's a tab when (k-1) is even, i.e. k is odd — shift
    // left (into the tab) by c/2. When k is even the left run is a slot — shift
    // right (still into the tab on the right) by c/2. Panel ends never move.
    const boundary = (k: number): number => {
      const x = k * w; // same expression the un-shifted code used, for c = 0 exactness
      if (k <= 0 || k >= fingers) return x; // panel ends never move
      return k % 2 === 1 ? x - c / 2 : x + c / 2;
    };

    // Top profile, left → right. Each finger is a horizontal run at its own y;
    // the y change between adjacent fingers forms the vertical step of the comb.
    const topProfile: { x: number; y: number }[] = [];
    for (let i = 0; i < fingers; i++) {
      const y = i % 2 === 0 ? top : top - thickness;
      topProfile.push({ x: boundary(i), y });
      topProfile.push({ x: boundary(i + 1), y });
    }

    // Closed outline: bottom edge, right edge, combed top (right → left), then
    // the left edge closes back to the origin.
    const outline = [
      { x: 0, y: 0 },
      { x: width, y: 0 },
      ...topProfile.slice().reverse(),
    ];

    const panel = s.polyline(outline, { closed: true });
    // A through profile cut; dog-bone relief so the slots' square inside
    // corners accept the mating panel's square fingers.
    s.suggestOp({
      name: "Panel — Profile (outside)",
      kind: "profile-outside",
      targets: [panel],
      depth: "through",
      cornerStyle: "dogbone",
    });
    return [panel];
  },
};
