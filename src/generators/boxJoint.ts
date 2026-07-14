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
    const fingers = Math.max(1, Math.round(s.param("fingers", 6, { min: 1, label: "Fingers" })));

    const w = width / fingers;
    const top = height;

    // Top profile, left → right. Each finger is a horizontal run at its own y;
    // the y change between adjacent fingers forms the vertical step of the comb.
    const topProfile: { x: number; y: number }[] = [];
    for (let i = 0; i < fingers; i++) {
      const y = i % 2 === 0 ? top : top - thickness;
      topProfile.push({ x: i * w, y });
      topProfile.push({ x: (i + 1) * w, y });
    }

    // Closed outline: bottom edge, right edge, combed top (right → left), then
    // the left edge closes back to the origin.
    const outline = [
      { x: 0, y: 0 },
      { x: width, y: 0 },
      ...topProfile.slice().reverse(),
    ];

    return [s.polyline(outline, { closed: true })];
  },
};
