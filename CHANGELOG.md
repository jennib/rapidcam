# Changelog

All notable changes to RapidCAM are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [Unreleased]

### Added
- **DOF-based entity colouring** — entities are coloured blue (under-defined) or their normal colour (fully defined) after each solve. Over-constrained / conflicting sketches are highlighted red. Analysis uses RREF null-space decomposition so that mutual dependencies between entities are handled correctly.
- **Driven (reference) dimension UI** — non-driving dimensions now display their value in parentheses `(50.00 mm)` in a muted colour, matching the SolidWorks / FreeCAD convention.
- **Chamfer tool** — trims two meeting line ends by a user-typed distance and inserts a straight bevel line with coincident constraints at both ends. Mirrors the fillet tool workflow.
- **Over-constrained feedback** — extends the existing status-bar warning with per-entity red colouring when the solver fails to converge.
- **Slot tool** (`U`) — two-click slot geometry with arc caps and parallel sides, fully constrained by coincident and equal-radius constraints.
- **Polygon tool** (`N`) — regular polygon with configurable side count (`[` / `]`); produces a closed polyline.
- **Linear Pattern** — parametric array of geometry in an X/Y grid; spacing fields accept variable expressions.
- **Circular Pattern** — parametric array around a centre point with configurable count and total angle.
- **Text entity system** — full OpenType font support; double-click any text entity to edit in place.
- **CAM: Pocket clearing** — raster or contour strategy with island support.
- **CAM: Lead-in / lead-out arcs** — tangential entry/exit for profile cuts.
- **CAM: Tabs / bridges** — automatic tab insertion to hold parts during cutting.
- **CAM: Tool Library Manager** — named tool definitions with diameter, flute count, feed/speed presets.
- **CAM: WebGL toolpath preview** — 3D preview of generated cut paths.
- **SVG export improvements** — exports clean paths with layer colour preservation.

### Fixed
- Constraint solver: under-constrained geometry no longer rotates unexpectedly when a driving dimension value is changed. Non-pinned DOFs are always anchored (Tikhonov regularisation, weight 1e-3) so the solver picks the minimum-displacement solution in all situations, not just during drag.

---

## [0.1.0] — 2026-06-03

### Added
- Initial parametric 2D CAD editor with Levenberg-Marquardt constraint solver.
- Drawing tools: Line, Rectangle, Circle, Arc, Polyline, Bezier, Offset, Fillet, Trim, Mirror, Rotate, Scale.
- Geometric constraints: Coincident, Horizontal, Vertical, Parallel, Perpendicular, Equal, Fixed, Tangent, Point-on-entity, Concentric, Angle, Symmetric, Midpoint, Collinear.
- Driving dimensions with variable expressions.
- Named variables panel.
- Layered document with show/hide.
- Snapshot-based undo / redo.
- SVG import / export.
- Native `.rapidcam` JSON project format.
- CAM: Profile cut with G-code output (GRBL and LinuxCNC post-processors).
- Dark-theme canvas UI built with TypeScript and Vite.
