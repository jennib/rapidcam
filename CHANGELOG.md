# Changelog

All notable changes to RapidCAM are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [1.0.0] — 2026-06-21

### Added
- **`.rcam` v2 format** — a published [JSON Schema](public/schema/rcam-v2.schema.json) and [authoring guide](docs/rcam-format-v2.md) document the file format (entity point-key vocabularies, constraint/dimension semantics, CAM operations). A drift-guard test validates every bundled example against the schema. Lets external tools and AIs author `.rcam` files reliably. v2 drops transient editor/selection state from the file (a `.rcam` describes a design, not a session) and **embeds the fonts** used by text entities so a saved job reproduces its glyph outlines — and toolpaths — on any machine. Version-1 files open and are upgraded automatically.
- **DOF-based entity colouring** — entities are coloured blue (under-defined) or their normal colour (fully defined) after each solve. Over-constrained / conflicting sketches are highlighted red. Analysis uses RREF null-space decomposition so that mutual dependencies between entities are handled correctly.
- **Driven (reference) dimension UI** — non-driving dimensions now display their value in parentheses `(50.00 mm)` in a muted colour, matching the SolidWorks / FreeCAD convention.
- **Chamfer tool** — trims two meeting line ends by a user-typed distance and inserts a straight bevel line with coincident constraints at both ends. Mirrors the fillet tool workflow.
- **Over-constrained feedback** — extends the existing status-bar warning with per-entity red colouring when the solver fails to converge.
- **Slot tool** (`U`) — two-click slot geometry with arc caps and parallel sides, fully constrained by coincident and equal-radius constraints.
- **Polygon tool** (`N`) — regular polygon with configurable side count (`[` / `]`); produces a closed polyline.
- **Linear Pattern** — parametric array of geometry in an X/Y grid; spacing fields accept variable expressions.
- **Circular Pattern** — parametric array around a centre point with configurable count and total angle.
- **Text entity system** — full OpenType font support; double-click any text entity to edit in place.
- **CAM: Pocket clearing** — adaptive contour-parallel clearing (default; concentric offset loops that wrap islands with no per-row lifting and ramped entry) or classic zig-zag raster, selectable per operation; both respect islands and flood-fill region picking.
- **CAM: Line-type constraints on polyline segments** — apply horizontal/vertical/parallel/perpendicular/collinear/equal/angle/tangent/point-on-line to an individual polyline segment (click it in the select tool) without exploding the polyline.
- **CAM: Engrave arcs** — standalone arcs now produce real `G2`/`G3` toolpaths; profile/pocket of an open arc/line/bezier emits an explanatory `; NOTE:` instead of silently dropping it.
- **CAM: Lead-in / lead-out arcs** — tangential entry/exit for profile cuts.
- **CAM: Tabs / bridges** — automatic tab insertion to hold parts during cutting.
- **CAM: Tool Library Manager** — named tool definitions with diameter, flute count, feed/speed presets.
- **CAM: WebGL toolpath preview** — 3D preview of generated cut paths.
- **CAM: Finishing pass** — optional per-operation finishing pass (profile + pocket) leaves a thin radial allowance (`finishAllowance`, default 0.2 mm) on the walls during stepdown roughing and removes it in a final full-depth wall lap, cleaning the ridges left between depth levels.
- **CAM: Drill pecking** — optional `peckDepth` drills holes in increments with full retract between pecks (G83-style) to clear chips.
- **CAM: Coolant** — per-operation coolant (off / mist `M7` / flood `M8`, `M9` off), gated behind a machine-wide "has coolant" capability so non-coolant machines are never prompted.
- **CAM: End-of-program park** — optional `endPosition` rapids the tool to a work-coordinate position (e.g. 0,0) at safe Z before `M30`.
- **CAM: Export selected toolpaths** — tick a subset of toolpaths and export them to a single G-code file (e.g. all the operations that share a tool).
- **CAM: Chamfer (V-bevel) operation** — bevels an edge with a V-bit by specifying the bevel **width**; the plunge depth is derived from the bit angle (`depth = width / tan(½·vAngle)`), with a live depth/angle readout. `chamferSide` (`on`/`outside`/`inside`) places the bevel relative to the edge. Optional **Sharpen corners** pulls the tip up into each sharp inside corner (tapering the bevel to the surface at the vertex) so corners come to a crisp point instead of a rounded fillet. Targets closed contours (pocket boundaries, profiles) and open edges; mirrored in the 3D preview. Designed for Shaker-style pocket chamfers.
- **CAM: V-carving** — variable-depth carving with a V-bit. The cut depth tracks each point's distance from the region wall (offset-peeling), so strokes taper to a sharp medial-axis spine and bottom out flat once they reach the set max depth. Carves text (letter counters are recognised as holes), directly-selected closed shapes, and **flood-fill-picked regions with islands**; the radial pass pitch (`vStep`) sets floor smoothness. Mirrored in the 3D preview.
- **Toolpath dialog placement** — the Add/Edit Toolpath dialog opens on the right side of the screen and remembers its last dragged position across sessions.
- **Privacy-respecting analytics** — usage analytics are sent only after explicit consent (banner), Do-Not-Track is honoured, and nothing is captured otherwise.
- **SVG export improvements** — exports clean paths with layer colour preservation.

### Changed
- Test suite unified under Vitest (`npm test`) and run in CI; three known solver drag-drift cases are documented as expected failures.
- CamBar's monolithic `openDialog` split into focused section builders; pure CAM helpers extracted to `camBarHelpers.ts`.
- **CAM: Profile lead entry point** — when a lead-in/out is configured, profiles now anchor the lead (and plunge) at the **midpoint of the longest edge** instead of a corner, for a gentler entry and a witness mark on a flat run. Plain profiles with no lead are unchanged (still start at the natural corner).
- **CAM: Circular pockets** now clear with smooth concentric `G2` arcs and a true **helical (`G2`+Z) entry**, replacing the old straight-plunge raster — smoother walls and a gentler descent.
- **CAM: 3D preview fidelity** — the stock simulation now mirrors lead-in/out moves (and the mid-side start), so the preview matches the generated G-code; tabs were already shown. Machine configuration (post-processor, tool changer, coolant capability, custom start/end G-code) is consolidated into a single top-bar **Settings** dialog instead of being split across panels.
- **CAM: Profile arc-fitting** — tool-compensated profiles now post curved runs as smooth `G2`/`G3` arcs instead of many short `G1` facets (fitted within a 0.05 mm tolerance; swept-angle capped so a circle splits into a few well-conditioned arcs). Straight-edged profiles are byte-identical to before.

### Fixed
- Constraint solver: under-constrained geometry no longer rotates unexpectedly when a driving dimension value is changed. Non-pinned DOFs are always anchored (Tikhonov regularisation, weight 1e-3) so the solver picks the minimum-displacement solution in all situations, not just during drag.
- **Pocket region picking** now recognises closed outlines made of mixed curves (lines + arcs/beziers), e.g. a rectangle with a filleted corner — previously such shapes couldn't be hovered or picked.
- **Pocket offset direction** is now winding-independent — a clockwise outline no longer inverts inside/outside.
- **Pocket pass ordering** — each depth level is fully cleared (rough then finish walls) before descending, instead of roughing all depths then re-cutting shallow walls.
- Tangent-to-arc constraints whose contact point falls outside the arc's sweep now raise a non-blocking warning.
- Contiguous-chain selection no longer mistakes a line's midpoint for an endpoint, so chained line segments link correctly.

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
