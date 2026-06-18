# Example projects

Sample `.rcam` projects to help you learn RapidCAM. Open one from the **Examples**
section of the welcome screen, or via **File → Examples** (or drag a file onto the
canvas), then try editing the dimensions. They're arranged as a progression — start
at the top and work down.

> Writing `.rcam` files by hand or with tooling? These files are the canonical,
> schema-tested references for the v2 format. See the
> [format authoring guide](../docs/rcam-format-v2.md) and
> [JSON Schema](../public/schema/rcam-v2.schema.json).

### Tier 1 — first contact (drawing + dimensions)

| File | What it shows |
|------|---------------|
| [keychain-tag.rcam](keychain-tag.rcam) | The smallest complete part: a tag body, a keyring hole, and editable **text**. Double-click the text to type a name; double-click the **Ø6** to resize the hole. Introduces the text tool and driving dimensions. |
| [mounting-plate.rcam](mounting-plate.rcam) | A fully-constrained 120 × 80 mm plate with four Ø8 corner holes. Double-click the **120** / **80** dimension and the holes track their corners; double-click the **Ø8** and all four holes resize together. |

### Tier 2 — constraints, variables & patterns

| File | What it shows |
|------|---------------|
| [bracket.rcam](bracket.rcam) | An L-shaped profile driven entirely to **"Fully constrained"** with per-segment horizontal/vertical constraints and four dimensions. Edit any dimension and the whole outline reflows while staying square. |
| [bolt-circle.rcam](bolt-circle.rcam) | A 6-hole bolt flange driven by **variables**. The Variables panel defines `pcd` (pitch-circle diameter) and `holeDia`; the source hole's position and size reference them. The other five holes are a **circular pattern**. Change `pcd` in the Variables panel, then Edit → Regenerate Patterns to spread the bolt circle. The green hole is the parametric master; the blue ones are pattern copies (regenerated geometry, not constraint-solved — so they read as under-defined, which is expected). |

### Tier 3 — full CAM pipeline (draw → G-code)

| File | What it shows |
|------|---------------|
| [mounting-plate-cam.rcam](mounting-plate-cam.rcam) | The mounting plate with two ready-to-run toolpaths — drill the holes, profile-cut the outline with tabs. |
| [enclosure-lid.rcam](enclosure-lid.rcam) | A pocketed lid: an **adaptive contour-parallel pocket** that clears a recess around a central boss (island), then a tabbed profile cut of the outline. Showcases flood-fill region picking and island handling. |

## mounting-plate.rcam — guided tour

A first-contact example for the parametric workflow:

- **Rectangle** plate, pinned at its bottom-left corner and sized by a horizontal
  (120 mm) and vertical (80 mm) **driving dimension**.
- **Construction centrelines** (dashed) held at the plate centre by midpoint
  constraints, so they re-centre whenever the plate is resized.
- **Four corner holes**, all kept equal in size by `equal` constraints and mirrored
  across the centrelines by `symmetric` constraints. Only one hole is positioned
  directly (15 mm in from the bottom-left corner); the other three follow.
- A **diameter dimension** (Ø8) drives every hole through the equal constraints.

The sketch reports **"Fully constrained"** in the status bar — every entity is
green. Try double-clicking any dimension value: the geometry reflows instantly
while the design intent (centred pattern, equal holes, fixed corner inset) is
preserved.

## mounting-plate-cam.rcam — adding toolpaths

This is the same sketch as above, plus two ready-to-run operations so you can
take it all the way to G-code:

1. **Drill holes** (T1, Ø8 drill) — plunges at each of the four hole centres.
2. **Profile outline** (T2, Ø6 end mill) — contours the outside of the plate in
   multiple depth passes, with an arc lead-in/out and four **tabs** so the part
   stays attached to the stock until you're done.

Both cut to Z−12 — 2 mm past the 10 mm stock for clean breakthrough into the
spoilboard. The plate sits inside a 170 × 130 mm stock so the outside profile has
room to run. Edit the geometry and the toolpaths follow it; hit **Generate
G-code** to export (the project is set to the GRBL post-processor).

> **⚠️ Feeds & speeds are example values, not a recipe.** They're set as
> conservative starting points for **plywood or MDF on a small hobby router**
> (Ø6 end mill: 900 mm/min, 250 mm/min plunge, 2 mm per pass, 18 000 rpm;
> Ø8 drill: 120 mm/min plunge, 6 000 rpm). **Always tune them for your own
> material, tooling, and machine before cutting** — and check that Z−12 into the
> spoilboard, the chosen WCS origin, and the manual tool change all match your
> setup.

