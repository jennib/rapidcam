# RapidCAM

**A web-based parametric 2D CAD editor designed as the front-end for a CNC CAM pipeline.**

Draw geometry, add geometric constraints and driving dimensions, then generate G-code — all in the browser, no install required.

**Live demo:** [https://rapidcam.mycnc.app](https://rapidcam.mycnc.app)

---

## Screenshots

<!-- To add screenshots: run `npm run dev`, capture the UI, and save to docs/screenshots/. -->

| Sketch editor | Constraint solver | CAM toolpaths |
|---|---|---|
| ![Sketch editor](docs/screenshots/editor.png) | ![Constraints](docs/screenshots/constraints.png) | ![CAM](docs/screenshots/cam.png) |

---

## Feature overview

### Drawing tools

| Tool | Key | Description |
|------|-----|-------------|
| Select | `V` | Click/drag to select; move, resize, or rotate selected entities |
| Line | `L` | Click two points; chains automatically |
| Rectangle | `R` | Click two corners |
| Circle | `C` | Click centre then a point on the circumference |
| Arc | `A` | Click centre, start, end |
| Slot | `U` | Click two centre points; auto-constrains the two arc caps |
| Polygon | `N` | Click centre then a vertex; `[`/`]` change side count |
| Polyline | `P` | Click vertices; `Enter` to close; open or closed |
| Bezier | `B` | Click four control points (cubic) |
| Text | `X` | Click to place; double-click any text entity to edit in place |
| Dimension | `D` | Click an entity to annotate; drag the witness line |
| Offset | `O` | Click an entity to offset inward or outward |
| Fillet | `F` | Click a sharp corner to round it with a user-typed radius |
| Chamfer | — | Click a sharp corner to bevel it with a user-typed distance |
| Trim | `T` | Click the segment to remove at an intersection |
| Mirror | `M` | Reflect selected entities across a picked axis line |
| Rotate | `Q` | Rotate selected entities by angle around a pivot |
| Scale | `S` | Scale selected entities by factor around a pivot |

### Parametric constraint solver

RapidCAM uses a **Levenberg-Marquardt** solver with Tikhonov regularisation. Non-pinned degrees of freedom are always anchored so that editing a driving dimension produces a minimal-movement solution (no unexpected rotations).

**Available constraints** (applied from the constraint bar or automatically by tools):

- Coincident — two points share the same location
- Horizontal / Vertical — line is axis-aligned
- Parallel / Perpendicular / Collinear — angular relationships between lines
- Equal — two lengths or radii are equal
- Symmetric — entity mirrored about a line
- Midpoint — point lies at the midpoint of a line
- Fixed — entity is locked to the world frame
- Tangent — circle/arc is tangent to a line or another arc
- Point on Line / Point on Arc / Point on Circle
- Concentric
- Angle — angular constraint between two lines

**DOF-based entity colouring:** After each solve, every entity is coloured by its constraint status — **blue** = under-defined (free DOFs remain), **normal** = fully defined, **red** = over-constrained or conflicting. The analysis uses RREF null-space decomposition so that mutual dependencies between entities are handled correctly.

### Driving dimensions vs. reference dimensions

Driving dimensions change the geometry when edited (shown in cyan). Reference (driven) dimensions display the measured value in grey, wrapped in parentheses: `(50.00 mm)`. Toggle between the two modes in the dimension inspector.

### Variables

Named variables (`pitch`, `diameter`, …) can be defined in the Variables panel and used in any dimension value field. Expressions like `pitch * 2` are evaluated at solve time.

### Parametric patterns

- **Linear pattern** — copies geometry in an X/Y grid; spacing fields accept variable expressions
- **Circular pattern** — copies geometry around a centre point; editable count and total angle
- Both patterns store a regeneratable definition; re-opening the dialog lets you update the parameters and regenerate the copies

### Layers

Entities live on named, coloured, show/hide layers. Construction geometry (dashed) is kept on separate layers and excluded from CAM operations.

### CAM

| Feature | Details |
|---------|---------|
| Profile cut | Contour-follows any closed chain; lead-in / lead-out arcs |
| Pocket clearing | Adaptive contour-parallel clearing (default) — concentric offset loops that wrap islands with helical entry and no per-row lifting — or classic zig-zag raster; both respect islands and flood-fill region picking |
| Tabs / bridges | Automatic tab insertion on profile cuts |
| Tool library | Named tool definitions with diameter, flute count, feed/speed presets |
| G-code export | GRBL and LinuxCNC post-processors |
| WebGL toolpath preview | 3D preview of the cut paths |

> **Open vs. closed geometry:** Engrave cuts follow any path on its centreline, including standalone arcs and beziers (emitted as native `G2`/`G3` arcs where possible). Profile and pocket operations require *closed* geometry — a lone arc, line, open polyline, or bezier is skipped with an explanatory `; NOTE:` in the G-code rather than silently dropped. Combine segments into a closed loop (or use a closed polyline / region pick) to profile or pocket them.

### File I/O

- **Native project format** — JSON snapshot with full document state (undo history preserved across sessions)
- **SVG import/export** — round-trips clean paths; exported SVG preserves layer colours
- **Drag-and-drop** — drop an SVG file onto the canvas to import

---

## Architecture

```
src/
├── app.ts              # Application shell — wires everything together
├── main.ts             # Entry point
├── style.css           # Dark-theme CSS
│
├── core/               # Pure math utilities
│   ├── vec2.ts         # 2-D vector operations
│   ├── units.ts        # mm ↔ display-unit conversion
│   ├── expr.ts         # Variable expression evaluator
│   ├── transform.ts    # Translate / rotate / scale helpers
│   └── fontManager.ts  # opentype.js wrapper
│
├── model/              # Document data model (no rendering, no DOM)
│   ├── document.ts     # CADDocument class — entities, constraints, dimensions, undo
│   ├── entities.ts     # Entity classes (Line, Circle, Arc, Polyline, …)
│   ├── constraints.ts  # Constraint definitions and residual functions
│   ├── dimensions.ts   # Dimension layout and residuals
│   ├── variables.ts    # Named variable evaluation
│   ├── patterns.ts     # PatternDef — linear & circular parametric patterns
│   └── history.ts      # Snapshot-based undo / redo
│
├── solver/             # Geometric constraint solver
│   ├── solver.ts       # Levenberg-Marquardt + DOF status computation
│   └── linalg.ts       # Gaussian elimination, RREF, matrixRank
│
├── view/               # Canvas rendering (no model mutation)
│   ├── renderer.ts     # Main draw loop — entities, dimensions, constraints
│   ├── viewport.ts     # World ↔ screen transform, zoom/pan
│   ├── colors.ts       # Central colour palette
│   ├── grid.ts         # Adaptive grid
│   └── overlay.ts      # Transient visuals (snap, preview, selection rect)
│
├── input/              # User input
│   └── snapping.ts     # Snap engine (endpoints, midpoints, intersections, grid)
│
├── tools/              # One file per drawing/editing tool
│   ├── tool.ts         # Tool interface + ToolManager
│   ├── selectTool.ts
│   ├── lineTool.ts     # … (one file per tool)
│   └── icons.ts        # Inline SVG icons (24×24)
│
├── ui/                 # UI panels — toolbar, bars, dialogs
│   ├── toolPalette.ts
│   ├── constraintBar.ts
│   ├── camBar.ts
│   ├── statusBar.ts
│   └── …
│
├── cam/                # CAM operations
│   ├── types.ts        # CamOperation, ToolDef
│   ├── pocket.ts       # Pocket clearing
│   ├── offset.ts       # Contour offsetting (via Clipper2)
│   ├── tabs.ts         # Tab/bridge insertion
│   ├── gcode.ts        # G-code builder
│   ├── toolLibrary.ts
│   └── postprocessors/ # GRBL, LinuxCNC
│
└── io/                 # File I/O
    ├── fileio.ts
    ├── svgImport.ts
    ├── svgExport.ts
    └── projectManager.ts
```

**Coordinate system:** All geometry is stored in millimetres with Y-up (standard mathematical convention). The renderer flips Y when converting to screen space.

**Internal units:** The solver and all constraint residuals always work in mm. Display units (mm / inch) are applied only at the UI layer.

---

## Getting started

### Prerequisites

- [Node.js](https://nodejs.org/) 18 or later
- npm (bundled with Node)

### Install and run

```bash
git clone https://github.com/your-org/rapidcam.git
cd rapidcam
npm install
npm run dev        # starts Vite dev server at http://localhost:5173
```

### Other scripts

```bash
npm run typecheck  # TypeScript type check (no emit)
npm run build      # type check + Vite production build → dist/
npm run preview    # serve the dist/ build locally
```

---

## Privacy & analytics

RapidCAM can collect anonymous usage analytics (via PostHog) to help guide development, but **only with your explicit consent**:

- On first visit you'll see a small banner; nothing is sent unless you choose **Allow analytics**.
- Browsers with **Do Not Track** enabled are never tracked and never shown the banner.
- Your choice is stored locally and can be cleared at any time (clear site data, or remove the `rapidcam_analytics_consent` localStorage key) to be asked again.
- Your geometry, G-code, and project files never leave the browser — analytics only records coarse interaction events (e.g. "tool activated", "g-code generated").

The self-hosted build collects nothing unless you wire up your own PostHog key.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide. The short version:

1. Fork the repo and create a feature branch.
2. Make your changes — keep them focused and minimal.
3. Run `npm run typecheck` and confirm it passes with no errors.
4. Open a pull request against `main`.

**License note:** This project is licensed under [CC BY-NC-SA 4.0](LICENSE). Contributions are accepted under the same licence. Commercial forks are not permitted without prior written agreement.

---

## License

[![CC BY-NC-SA 4.0](https://licensebuttons.net/l/by-nc-sa/4.0/88x31.png)](https://creativecommons.org/licenses/by-nc-sa/4.0/)

RapidCAM is licensed under the **Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International** licence.

You are free to share and adapt the material for **non-commercial purposes**, provided you give appropriate credit and distribute your contributions under the same licence.

See [LICENSE](LICENSE) for the full legal text.
