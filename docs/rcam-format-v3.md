# RapidCAM `.rcam` file format — version 3

This is the authoring guide and stability contract for the RapidCAM project file
format. A `.rcam` file is plain JSON. The machine-readable contract lives in
[`public/schema/rcam-v3.schema.json`](../public/schema/rcam-v3.schema.json) (JSON Schema, draft
2020-12); this document is the human- (and AI-) readable companion that explains
the parts a schema can't — the vocabulary of point keys, what each constraint
means, and the gotchas.

This guide is published at
**`https://rapidcam.app/docs/rcam-format-v3.md`**, and the bundled example
projects are listed at **`https://rapidcam.app/examples/index.json`** (see also
[`/llms.txt`](https://rapidcam.app/llms.txt)).

The schema's canonical published URL is
**`https://rapidcam.app/schema/rcam-v3.schema.json`** (this is also its `$id`).
In the repository it lives at
[`public/schema/rcam-v3.schema.json`](../public/schema/rcam-v3.schema.json), which
is what gets served at that URL.

If you are an automated tool (including an LLM) generating `.rcam` files: validate
your output against the schema, and prefer the patterns shown in
[`examples/`](../examples/). The bundled examples are golden files and are tested
against this schema on every commit.

## What changed across versions

### Version 3 (current)

Version 3 dropped machine and controller configuration from the file:

- **No controller / machine settings in the drawing.** `postProcessor`,
  `hasToolChanger`, and the machine-configuration half of the `rotary` block
  (`axisWord`, `arcTolerance`) were removed from the file. A `.rcam` is a
  drawing / design, so machine settings now live in the operator's local machine
  profile and are applied when G-code is generated.
- Declares `"version": 3`.

### Version 2

Version 2 treated a `.rcam` file as a **design**, not an editor session:

- **No selection / UI state.** The top-level `isConstructionMode`,
  `selectedPoints`, `selectedConstraintId`, `selectedDimensionId` fields and the
  per-entity `selected` flag are gone. (A file shouldn't record what happened to be
  selected when it was saved.)
- **Embedded fonts.** A new optional top-level [`fonts`](#fonts) array carries the
  bytes of any non-bundled font a text entity uses, so glyph outlines — and
  therefore toolpaths — reproduce on any machine.

Version-1 and version-2 files still open: RapidCAM upgrades them on load (chaining migrations v1 → v2 → v3).
The set of entity types, constraint types, dimension types, and point-key
vocabularies is unchanged.

## Stability promise

- Every file declares `"version": 3`. The loader auto-upgrades `"version": 1`
  and `"version": 2`; migrations chain, so a v1 file becomes v2 then v3.
- The loader is **tolerant of additive growth**: unknown fields are ignored, and
  most top-level sections default sensibly when absent (see *Minimum viable file*).
  New, optional capabilities may be added without bumping the version. Anything
  that would change or remove existing semantics gets a new `version`.
- A file written by RapidCAM round-trips losslessly. A hand-authored file only
  needs the required fields below.

## Coordinate system & units

- **All lengths are millimetres**, always — regardless of `displayUnit`.
  `displayUnit` (`"mm"` or `"in"`) only controls how the UI presents numbers.
- The world frame is **Y-up**: increasing `y` moves away from the machine front.
- **Angles are radians**, measured CCW, in the world frame.
- The drawing lives inside `canvas` (`width` × `height`, mm), which represents the
  work area / stock footprint.

## Top-level shape

```jsonc
{
  "version": 3,
  "name": "My Part",
  "canvas": { "width": 120, "height": 80 },   // mm
  "displayUnit": "mm",                          // "mm" | "in" (display only)
  "stockThickness": 10,                         // mm, default 10
  "origin": { "x": "left", "y": "front", "z": "top" },
  "machineKind": "mill",                         // "mill" | "laser" | "mill-rotary" | "laser-rotary", default "mill"
  "endPosition": null,                          // optional park position; see below
  "metadata": { "job": "", "revision": "", "notes": "" }, // optional job info; see below
  "groups": [],
  "layers": [ /* optional; a Default layer is created if omitted */ ],
  "activeLayerId": "layer-0",
  "entities": [ /* geometry */ ],
  "constraints": [ /* parametric constraints */ ],
  "dimensions": [ /* measurements / driving dims */ ],
  "variables": [ /* named numbers, may reference each other */ ],
  "bindings": [ /* headless formula → an entity scalar (e.g. circle radius) */ ],
  "patterns": [ /* linear / circular patterns */ ],
  "operations": [ /* CAM toolpaths */ ],
  "tools": [ /* reusable tool definitions referenced by operations */ ],
  "fonts": [ /* embedded non-bundled fonts used by text entities */ ]
}
```

### Minimum viable file

The loader hard-requires only a few fields; the rest default. The smallest file
that loads cleanly and draws a circle:

```json
{
  "version": 3,
  "name": "Minimal",
  "canvas": { "width": 100, "height": 100 },
  "displayUnit": "mm",
  "entities": [
    { "type": "circle", "id": "ent1", "center": { "x": 50, "y": 50 }, "radius": 10 }
  ],
  "constraints": [],
  "dimensions": []
}
```

Defaults applied when omitted: `stockThickness` → 10,
`origin` → front-left-top, `machineKind` → `"mill"`,
`endPosition` → `null`, `layers` → one `"layer-0"` "Default" layer,
`groups`/`variables`/`patterns`/`operations`/`tools`/`fonts` → empty.

`machineKind` is two independent choices in one field — the **head** and the
**stock**.

The head selects the output path: `"mill"` (the default) posts spindle + Z-axis
G-code; `"laser"` posts fixed-Z beam G-code (beam on/off, power + passes, no Z)
and the operations use the laser fields instead — see
[CAM operations](#cam-operations).

A `"-rotary"` kind machines a **cylinder** instead of a flat blank, described by
the top-level `rotary` block (see below). The head behaviour is unchanged by it:

- `"mill-rotary"` behaves like `"mill"` everywhere except export, which **wraps**
  the finished flat program around the cylinder — the wrapped coordinate becomes
  rotary-axis degrees.
- `"laser-rotary"` behaves like `"laser"` *including* at export. A laser rotary
  **substitutes** the axis rather than wrapping it: the wrapped coordinate stays
  on its ordinary linear word, in surface millimetres, and the machine is set up
  so one revolution equals the circumference of travel on that axis (its rotary
  is wired in place of that linear motor, with steps/mm rescaled). GRBL 1.1 —
  which drives most laser rotaries — has no 4th axis and would reject an `A`
  word, so this is the only mode offered for a beam. The posted program is
  therefore the ordinary flat one plus a setup banner stating what one revolution
  must measure; what the rotary machine kind buys you is the cylinder-sized
  canvas, the wrap hint, the preview, and that banner.

**The controller is NOT in the file.** As of v3 a `.rcam` is a drawing, so it
carries the design and not the author's machine: the post-processor, the
automatic-tool-changer flag, the rotary axis word and the arc tolerance all live
in the opener's local machine profile and are applied when G-code is generated.
A design you receive is cut with *your* controller, not the sender's.

For reference, the posts a machine can be configured with — for a **mill**,
`"linuxcnc"` or `"grbl"`; for a **laser**, one of the controllers below, each a
separate editable post in `src/cam/laserposts/`:

| id | controller |
|----|------------|
| `grbl-dynamic` | GRBL / FluidNC, `M4` dynamic power (default) |
| `grbl-constant` | GRBL / FluidNC, `M3` constant power |
| `marlin` | Marlin, `M3`, power 0–255 |
| `smoothie` | Smoothieware, inline `S` (0–1) per cut move |
| `linuxcnc-laser` | LinuxCNC, PWM-spindle (`M3`/`M5` + `S`) |

(Legacy laser files that stored `"grbl"` map to `grbl-dynamic`.)

Coolant is **per operation** (`operations[].coolant`), not a top-level field.
Custom program start/end G-code and the "machine has coolant" capability are
machine-wide (localStorage) preferences, since they describe the operator's
shop, not the design — so they are not stored in the file either.

`endPosition` is an optional `{ "x", "y" }` (work coordinates, mm) the spindle
rapids to at safe Z just before `M30`; `{ "x": 0, "y": 0 }` parks at the WCS
origin. `null` (or omitted) leaves the tool wherever the last toolpath ended.

`toolChangePosition` is an optional `{ "x", "y" }` (work coordinates, mm) the
tool rapids to at safe Z before a *manual* tool change, so the operator can reach
the spindle. `null`/omitted leaves the tool over the work; ignored with an
automatic tool changer and on lasers.

`flip` is an optional double-sided machining setup. When present, each operation
carries a `face` (`"top"` | `"bottom"`, absent = `"top"`): the top ops are cut as
drawn, then the stock is flipped and the bottom ops are cut from a program whose
geometry is mirrored about the flip axis so features align through the part. Its
fields are `axis` (`"h"` = flip left↔right / mirror X, `"v"` = flip near↔far /
mirror Y), `registration` (`"pins"` bores dowel holes through the stock into the
spoilboard at the end of the top-side program, `"none"` leaves realignment to the
operator), `pinDiameter` and `pinDepth` (mm), and `pins` (an array of `{ "x", "y" }`
hole centres in world mm; must be invariant under the mirror). Mill-only.
`null`/omitted = single-sided.

`rotary` is the optional cylindrical setup, required by a `"-rotary"`
`machineKind` and ignored otherwise. The drawing canvas is the **unrolled
cylinder surface**: one axis runs along the cylinder length and the perpendicular
one spans the circumference, so `canvas` should be authored as length ×
π·`diameter` (360° of rotation = π·diameter of surface travel).

How the wrapped axis is posted depends on the head. A **mill** wraps it: the
coordinate is emitted as rotary-axis degrees and arcs are flattened to G1 chords;
Z is depth below the **top of the cylinder** (touch off the stock top) and
`stockThickness` is the radial wall / max cut depth. A **laser** substitutes it:
nothing is transformed, because the canvas is already in the surface millimetres
the substituted axis wants, and no Z is emitted at all.

Fields in the FILE describe the job, because the cylinder *is* the stock:
`diameter` (mm), `wrapAxis` (`"y"` = Y wraps to rotation and X runs along the
length — the default pairing; `"x"` = swapped), and optional `zero`
(`"surface"` (default) or `"center"` — see Zeroing below). `zero` is
**mill-only**: a beam emits no Z to zero.

The rotary **axis word** (`"A"` about machine X, pairing with `wrapAxis` `"y"`;
`"B"` about Y, pairing with `"x"`) and the **arc tolerance** (chord tolerance in
mm, default 0.1) describe the machine, not the design, so as of v3 they are not
stored in the file — they come from the local machine profile. Both are
mill-only anyway: a beam emits no rotary word and never flattens an arc because
it never wraps one. Not combinable with `flip`.
`null`/omitted = flat work. See
`examples/rotary-spiral-dowel.rcam` — a straight line across the wrapped axis
becomes a ring, a diagonal becomes a helix.

**Zeroing (important for setup and preview).** The `zero` field picks where `Z0`
sits:

- **`"surface"` (default).** `Z0` is the **top of the cylinder** — touch the tool
  off on the stock's top surface, and cuts run negative from there (the tool cuts
  at top-dead-centre as the part rotates under it). This is the easy zero to set
  physically, but note it is *not* the centre-of-rotation zero that some rotary
  previewers assume. To let those previewers place the toolpath on the cylinder,
  the wrap's G-code header carries a machine-readable diameter comment,
  `; Cylinder Dia: <mm>`, which they read and offset by the radius. In **gSender**
  specifically, turn on **Config ▸ Rotary ▸ "Visualize non-center zeros"** so it
  applies that offset; otherwise its visualizer draws the A-axis moves flat.
- **`"center"`.** `Z0` is the **rotary axis** (the cylinder centreline) — the
  native rotary convention. Every emitted `Z` is shifted up by the radius, so the
  surface sits at `Z = radius` and a cut to depth `d` lands at `Z = radius − d`.
  Set this zero by touching off on the stock top and entering the radius as the
  Z work offset. gSender and most controllers visualize this on the cylinder with
  **no** toggle, so the `; Cylinder Dia:` hint is omitted for this mode.

`metadata` is optional informational job data — `job`, `revision`, and `notes`,
all optional strings. It affects no geometry or toolpaths; non-empty fields are
written as comments in the G-code header (`; Job: …`, `; Revision: …`,
`; Notes: …`). Blank fields are dropped on save, and an all-blank object is
omitted entirely.

## IDs

- Every `id` is a string, unique within the file. RapidCAM uses `"<prefix><n>"`
  (`ent1`, `con3`, `dim2`, `var1`, `pat1`), but any unique non-empty string works.
- `"__origin__"` is **reserved** for the work-coordinate-system origin point.
  RapidCAM injects it automatically on load — you don't need to author it, and you
  shouldn't reuse the id.
- `layerId` on an entity should reference a real layer id; it defaults to
  `"layer-0"`.

## Entities

Each entity is an object tagged by `type`. Common optional fields:

- `isConstruction` (default false) — construction/reference geometry, excluded from CAM.
- `layerId` (default `"layer-0"`).
- `name` — a custom label shown in the design tree. Omit it and the tree derives
  a description from the geometry (`Circle ⌀35.00 mm`); it has no effect on output.
- `visible` (default true) — `false` hides the entity on the canvas; it stops
  being pickable and snappable, and it **is excluded from CAM output**, exactly
  as geometry on a hidden layer is. If it isn't on screen, it isn't in the
  program. Pre-flight warns (`hidden-geometry`) when a toolpath still references
  something hidden, so the exclusion is never silent.
- `locked` (default false) — `true` stops the entity being dragged, scaled,
  rotated, nudged or deleted. It stays selectable, dimensionable and snappable
  (the SolidWorks sense of "lock"), and it is still cut. Locking a whole *layer*
  is the blunter tool: that takes its geometry out of reach entirely.
- `fixtureHeight` — workholding only: how far *this* clamp stands above the stock
  top, in mm. It applies to a closed shape on a layer with `"fixture": true` and
  is ignored anywhere else. Omit it to inherit the layer's `fixtureHeight`, which
  is how every file written before this behaves; set it when clamps of different
  heights share one fixture layer. Resolution is entity → layer → full-height
  (an unknown height blocks any pass, because you cannot clear what you can't
  measure). Where a footprint is several entities that disagree, the tallest wins.

The **point keys** below are the addresses constraints and dimensions use to refer
to a specific point on an entity (via a `{ "entityId", "key" }` pair). Getting
these right is the single most important thing when authoring constraints.

| `type` | Geometry fields | Point keys (for constraints/dimensions) | Scalar DOFs |
|--------|-----------------|------------------------------------------|-------------|
| `line` | `a`, `b` (Vec2) | `a`, `b` endpoints; `mid` (derived, pickable) | — |
| `circle` | `center` (Vec2), `radius` | `c` center | `r` radius |
| `rectangle` | `p0`, `p1` (opposite corners) | corners `bl` `br` `tr` `tl`; edge mids `mid_b` `mid_r` `mid_t` `mid_l`; `center` | — |
| `polyline` | `points` (Vec2[]), `vertexIds` (string[], optional), `closed` (bool) | vertices `v<id>`; segment mids `mid_<id>` (id of the segment's start vertex) | — |
| `arc` | `center`, `radius`, `startAngle`, `endAngle` (rad, CCW) | `c` center; `start`, `end` (derived) | `r`, `sa`, `ea` |
| `bezier` | `p0` `p1` `p2` `p3` (start, start handle, end handle, end) | `p0` `p3` (constrainable); `p1` `p2` (drag-only) | — |
| `point` | `pos` (Vec2) | `p` | — |
| `text` | `text`, `fontId`, `sizeMM`, `position`, `angle` (rad) | `pos` baseline-left anchor; ink-box `bl` `br` `tr` `tl`, edge mids `mid_b` `mid_r` `mid_t` `mid_l`, `center` (all derived) | — |
| `image` | `imageId`, `position` (bottom-left), `widthMM`, `heightMM`, `angle` (rad) | `pos` bottom-left anchor | — |

Notes:
- A **Vec2** is `{ "x": number, "y": number }` in mm.
- `rectangle` is axis-aligned; `p0`/`p1` are normalised to min/max corners on load.
- A **polyline vertex carries a stable id.** `vertexIds[i]` is the id of `points[i]`;
  point keys are `v<id>` and `mid_<id>` (the midpoint of the segment that *starts*
  at vertex `<id>`). The id is decoupled from the array position so a constraint or
  dimension keeps pointing at the same physical vertex when an edit (chamfer,
  fillet, polygon resize) inserts or removes vertices ahead of it. `vertexIds` is
  optional: when omitted, each id defaults to its index as a string (`"0"`, `"1"`,
  …), so older files — whose keys are `v0`, `mid_0`, … — load unchanged. New
  vertices get fresh ids that are never reused within the polyline.
- A **polyline segment** can stand in for a line anywhere a line-type constraint
  expects an entity: use the entity reference string `"<polylineId>#<startVertexId>"`
  (the segment that starts at that vertex and runs to the next). Legacy files
  encoded the start vertex's *index* here; that resolves identically because a
  loaded vertex's default id is its index.
- `fontId` is either a bundled font (e.g. `"roboto-regular"`) or a `"font-XXXXXXXX"`
  id present in the top-level [`fonts`](#fonts) array. Text stays editable until CAM
  export, where it is expanded to glyph contours.
- A **text** entity exposes its ink-box corners `bl`/`br`/`tr`/`tl`, edge midpoints
  `mid_b`/`mid_r`/`mid_t`/`mid_l`, and `center` as derived point keys — dimension or
  constrain them like a rectangle's. They are derived from the anchor plus the live
  glyph extents (rotated by `angle`), so `position` (`pos`) is the only real DOF: a
  constraint on a box point **translates** the whole text so that point lands on the
  target (the string/size/rotation are unchanged), and it re-solves as the text is
  edited. This is what the **Center** command (Align toolbar / right-click) uses via
  the [`center`](#constraints) constraint.
- An **`image`** entity is a placed raster picture for greyscale engraving — by a
  **laser** (modulating beam power) or a **mill** (carving a depth relief).
  Its `imageId` (`"img-XXXXXXXX"`) must appear in the top-level `images` array,
  which stores a downscaled **greyscale** buffer (one byte per pixel, row-major,
  row 0 = top, 0 = black) — colour carries no machining information for a laser.
  `angle` (CCW radians) rotates the image about its anchor. The engrave/relief
  sweeps in the image's own (rotated) frame, so a non-zero `angle` is honoured in
  both the toolpath and the preview — the scan rows tilt with the image.
  `flipX` / `flipY` (default false) mirror the image content left↔right / top↔bottom
  about its centrelines; the mirror is baked into the sampled dots, so it is
  honoured identically in the laser engrave, the mill relief, and both previews.
  To **drive** `widthMM` / `heightMM` / `angle` from a variable formula, add a
  scalar binding (see [Bindings](#bindings)) on the image with
  `scalarKey` `"w"` / `"h"` / `"angle"` — exactly the mechanism used for a circle
  radius. An `"angle"` binding is entered in **degrees** and carries
  `scale: 0.0174533` (π/180) to reach the radian DOF, like an arc's `sa`/`ea`.
  (Pre-unification files used inline `widthExpr` / `heightExpr` / `angleExpr`
  fields; these are still read and auto-migrated to bindings on load, but are no
  longer written.) `aspectLocked` (default true) is an **edit-time** convenience
  only: with it on, editing one of width/height writes a proportional value or
  formula to the other — it stores nothing extra in the file and adds no solver
  constraint.
  The image also exposes constrainable **point keys** for use in constraints: the
  four corners `c0` (bottom-left anchor), `c1`, `c2`, `c3` (CCW) and `center`.
  A constraint on one of these (e.g. `coincident` of `c0` with a circle's `c`)
  reflows the image through the solver. How far it may reflow is **two independent
  permissions**, both default false (and omitted from the file), which together
  make an unlocked image rigid — a constraint just moves it, and positioning
  never distorts it:
  * `constraintResize` — constraints and dimensions may change its **size**. With
    `aspectLocked` (the default) the two size scalars are ONE degree of freedom,
    so the ratio is exact rather than merely converged; with the lock off, width
    and height move independently. This is how you *calibrate* a scan: put a
    driving dimension across a feature of known size (image edges and corners are
    dimensionable) and the whole image scales to suit.
  * `constraintRotate` — constraints may **turn** it, e.g. levelling a tilted scan
    by making one of its edges `horizontal`.

  They are separate, and `aspectLocked` governs the solver as well as the panel,
  because every extra freedom is another way for the solver to satisfy a
  constraint *wrongly*: a free angle meets a size dimension by tilting (a 10mm gap
  is also a 32mm edge seen at 72°), and a free size meets a levelling constraint
  by shrinking the image away (`w·sin(angle) = 0` has a root at `w = 0` as much as
  at `angle = 0`). Grant only what the intent needs and neither escape route is
  open.

## Constraints

A constraint contributes equation(s) the solver drives to zero, encoding design
intent so the sketch reflows when dimensions/variables change. Constraints are
**optional** — geometry is fully valid (and machinable) with none. Each
constraint references geometry through `points` (array of point refs) and/or
`entities` (array of entity-id strings), depending on its `type`:

| `type` | Operands | Meaning |
|--------|----------|---------|
| `coincident` | `points[2]` | the two points are equal |
| `horizontal` | `entities[1]` line **or** `points[2]` | endpoints/points share Y |
| `vertical` | `entities[1]` line **or** `points[2]` | endpoints/points share X |
| `parallel` | `entities[2]` lines | directions parallel |
| `perpendicular` | `entities[2]` lines | directions perpendicular |
| `equal` | `entities[2]` | equal length (lines) or equal radius (circles/arcs) |
| `concentric` | `entities[2]` circles/arcs | centres coincide |
| `pointOnLine` | `points[1]` + `entities[1]` line | point lies on the (infinite) line |
| `pointOnCircle` | `points[1]` + `entities[1]` circle | point lies on the circle |
| `pointOnArc` | `points[1]` + `entities[1]` arc | point lies on the arc's circle |
| `tangent` | `entities[2]` | line↔circle/arc, or circle/arc↔circle/arc tangency |
| `symmetric` | `points[2]` + `entities[1]` line | two points mirror across the line |
| `collinear` | `entities[2]` lines | both lie on the same infinite line |
| `midpoint` | `points[1]` + `entities[1]` line, **or** `points[3]` | point at line midpoint, or `points[0]` = midpoint of `points[1]`–`points[2]` |
| `angle` | `entities[2]` lines + `params[0]` | fixed angle between lines, `params[0]` = target **radians** |
| `fixedPoint` | `points[1]` + `params` | pin point to world position, `params` = `[x, y]` |
| `center` | `points[0]` mover + `points[1]` (or `points[1..2]` → their midpoint) reference + optional `params[0]` axis | **one-way**: the mover's centre follows the reference centre — X if `params[0]`=`0`, Y if `1`, both if omitted. The reference is never moved; the mover re-centres live as it (or the reference) changes |
| `fixed` | `entities[1+]` | lock all the entity's DOFs (no equation) |

A constraint object is:

```json
{ "id": "con1", "type": "fixedPoint",
  "points": [{ "entityId": "ent1", "key": "bl" }],
  "entities": [], "params": [15, 12] }
```

`points`, `entities`, and `params` are each **optional and default to `[]`** — a
type that uses only one of them may omit the others entirely (e.g. a `horizontal`
constraint can be just `{ "id": "...", "type": "horizontal", "entities": ["line1"] }`).
RapidCAM always writes the empty arrays out when saving, but you don't need to
author them. The same applies to a dimension's `points`/`entities`.

`center` is **directional** — unlike every other constraint it is not symmetric:
the solver snapshots the reference centre each solve and moves only the mover
toward it, so centring text in a box never nudges the box. It's normally produced
by the **Center** command rather than hand-authored; to author one, put the
mover's centre first (`points[0]`) and the reference last. A reference with no
single centre point (e.g. a rectangle drawn as four lines) uses two diagonal
corners in `points[1]`/`points[2]`, whose midpoint is the centre.

> **Authoring caution.** A syntactically valid constraint set can still be
> over-constrained, under-constrained, or fail to converge — and that can only be
> determined by running the solver, not by reading the JSON. If you are generating
> constraints programmatically and can't run RapidCAM to check, prefer:
> (a) emitting geometry already in its solved positions, and (b) pinning with
> `fixedPoint` + driving `dimensions` rather than dense webs of relational
> constraints. The bundled examples show idiomatic, convergent constraint sets.

## Dimensions

A dimension measures geometry and, when `"driving": true`, forces that measurement
to equal `value` (acting as a constraint). `value` is mm, or **radians** for
`type: "angle"`. `offset` is purely visual placement.

| `type` | Operands | Measures |
|--------|----------|----------|
| `distance` | `points[2]` | straight-line distance |
| `horizontal` | `points[2]` | |Δx| |
| `vertical` | `points[2]` | |Δy| |
| `radius` | `entities[1]` circle/arc | radius |
| `diameter` | `entities[1]` circle/arc | diameter |
| `arclength` | `entities[1]` arc | arc length |
| `angle` | `entities[2]` lines | angle between (radians) |
| `line-distance` | `entities[2]` lines | perpendicular gap between lines |
| `circle-gap` | `entities[2]` circles/arcs | edge-to-edge gap: radii difference when one lies inside the other (a ring's wall, even off-centre), otherwise the clearance between the edges |
| `angle-x` | `entities[1]` line | direction from the +X axis, in DEGREES (signed, -180..180). The one angular type stored in degrees, because it backs the Angle property field and a dimension's `expr` is evaluated straight into `value` with no unit applied — storing radians would make `45` and a variable worth `45` mean different things in the same box. Written only as a hidden driving dimension. |
| `arc-sweep` | `entities[1]` arc | included angle (sweep) in DEGREES, normalised to [0, 360). Unlike `angle-x` its residual is NOT wrapped: a 350° arc and a 10° arc are different arcs, so the shortest path is the wrong answer. Written only as a hidden driving dimension. |

Optional: `anchors` (`[t1, t2]`, for `line-distance` extension lines) and `expr`
(a formula string driving `value`, e.g. `"width * 2"`, evaluated against
`variables`).

```json
{ "id": "dim1", "type": "diameter", "points": [], "entities": ["ent2"],
  "value": 6, "driving": true, "offset": 2.356 }
```

## Variables

Named numbers referenced by dimension/pattern/binding expressions. `expr` is the
raw input string; `value` is its cached evaluation in mm. `name` must match
`^[a-zA-Z_][a-zA-Z0-9_]*$`.

`expr` may be a plain length (`"100"`, `"50mm"`, `"3.5in"`) **or a formula that
references other variables** (`"width * 0.1"`). Variables are evaluated in
dependency order, so declaration order doesn't matter; a reference cycle (or a
self-reference) leaves those variables at their last value rather than looping.
Bare numbers inside a formula are millimetres (like dimension formulas).

The global constant `stock` (or `$stock`) is always available to expressions and evaluates to the project's `stockThickness` in mm. This allows parametric designs (e.g. box joints) to automatically scale to the material thickness.

```json
{ "id": "var1", "name": "pcd", "expr": "60mm", "value": 60 }
{ "id": "var2", "name": "margin", "expr": "pcd * 0.1", "value": 6 }
```

## Bindings

Optional. A **headless parametric binding** drives one *scalar* DOF of an entity
(by its scalar key — `"r"` for a circle/arc radius, `"sa"`/`"ea"` for arc angles,
`"w"`/`"h"`/`"angle"` for image width/height/rotation) from a variable formula. It draws nothing on the canvas: it contributes a driving
residual (`currentScalar − expr`) to the same solver as dimensions/constraints, so
it reconciles through the one over/under-constrained mechanism (no separate
channel). `scale` converts the formula's display unit to the scalar's internal
unit — omit it (or `1`) for lengths; `π/180` for an angle scalar entered in
degrees. Measurement fields without a scalar DOF (line length, rect W/H) use a
`hidden` driving **dimension** instead (see below), not a binding.

```json
{ "id": "bind1", "entityId": "ent3", "scalarKey": "r", "expr": "pcd/2" }
{ "id": "bind2", "entityId": "arc1", "scalarKey": "sa", "expr": "tilt", "scale": 0.0174533 }
```

A dimension may carry `"hidden": true` — a driving dimension that isn't drawn,
used when a formula is typed into a *measurement* property field (line length,
rect W/H). It drives geometry like any dimension but shows no annotation.

## Patterns

Linear or circular replication. `sourceIds` are the master entities; `instanceIds`
holds one sub-array of entity ids per generated step. **The copy entities listed in
`instanceIds` must also appear in `entities`** — a pattern records the relationship;
it does not generate geometry on load.

> **Generating a file by hand or with an LLM?** Patterns are the easy thing to get
> wrong, because you must materialise every copy as a real entity *and* keep
> `instanceIds` consistent with the count. Two safe options: **(a)** the simplest —
> just emit all the copies as ordinary `entities` and omit the `pattern` block
> entirely (you lose the live link, but the geometry is correct and machinable);
> or **(b)** author the `pattern` *and* list one `instanceIds` sub-array per copy.
> If you do author a pattern, RapidCAM self-heals a count mismatch on open
> (it regenerates the instances to match the resolved count), but the file is
> cleanest when they already agree. `count*` is a cache; if you also set a
> `*Expr`, the expression wins on the next regenerate.

```jsonc
{ "id": "pat1", "kind": "circular",
  "sourceIds": ["ent2"],
  "instanceIds": [["ent3"], ["ent4"], ["ent5"], ["ent6"], ["ent7"]],
  "params": { "count": 6, "cx": 45, "cy": 40, "totalAngle": 6.283185 } }
```

- Linear params: `countX`, `countY`, `spacingX`, `spacingY` (mm), optional
  `countXExpr` / `countYExpr` and `spacingXExpr` / `spacingYExpr` (variable
  expressions).
- Circular params: `count`, `cx`, `cy` (centre, mm), `totalAngle` (radians; `2π`
  = full circle), optional `countExpr`.
- `count*` and `spacing*` are resolved caches; when an `*Expr` is present it is the
  source of truth — re-evaluated against `variables` (counts rounded, clamped to
  ≥1 linear / ≥2 circular) when the pattern is created or regenerated. So a
  variable can drive how *many* copies exist, not just their spacing. The
  `instanceIds` snapshot still must match the resolved count; regenerating in the
  app reconciles it.
- **CAM follows patterns.** A toolpath whose `entityIds` reference any member of a
  pattern (its source or any instance) is expanded at toolpath/preview time to
  cover the whole pattern — so a profile/drill assigned to patterned geometry
  cuts every copy and tracks the count as it grows or shrinks. You only need to
  assign the op to the master; you don't have to list every copy in `entityIds`.
  Set the op's `followPattern` to `false` to opt out (cut only the literal
  `entityIds`).
- **Instances are owned by the pattern.** Editing a single copy — moving or
  re-layering it — is overwritten the next time the pattern regenerates. Edit the
  source (or the pattern params/variables) instead; the copies follow.

## CAM operations

Each operation is a toolpath over some `entityIds`. Required fields cover the tool
and cut; several are type-specific and optional. `depth` is mm below the surface
and is **negative** for cuts. `side` (`"outside"`/`"inside"`) is required only on
`profile` ops and should be omitted elsewhere — a drill has no side. `stepdown`
(mm per depth pass, default 1.5) and `stepover` (fraction of tool diameter 0–1,
default 0.4) are optional; omit them where the op type ignores them.
Optional `coolant` (`"off"` | `"mist"` | `"flood"`, default `"off"`) emits `M7`/`M8`
around the operation and `M9` when it changes / at program end — but only if the
machine is flagged as having coolant (a machine-wide app preference); otherwise
it is suppressed.

An operation may carry an optional **`toolId`** referencing an entry in the
top-level [`tools`](#tools) array (see below). When `toolId` resolves, that tool's
geometry/feeds (`toolType`, `diameter`, `vAngle`, `tipAngle`, `feedrate`,
`plungeRate`, `spindleSpeed`, `safeZ`) drive the operation, and the inline copies
of those fields act only as a fallback for an unresolved id. `toolNumber` and the
cut settings (`depth`, `stepdown`, `stepover`, tabs, leads) always stay per-operation.
Operations with no `toolId` use their inline fields directly.

For a double-sided job (the top-level `flip` setting, see
[Top-level shape](#top-level-shape)), an operation may carry an optional
**`face`** (`"top"` | `"bottom"`,
default `"top"`): `"bottom"` ops are cut in the flipped setup, with their geometry
mirrored about the flip axis. It is ignored when `flip` is absent.

| `type` | Notes |
|--------|-------|
| `profile` | contours a closed shape; uses `side` (`"outside"`/`"inside"`), optional `tabs`, `leadIn`, `leadOut`. Optional `finishPass` leaves `finishAllowance` mm of stock during roughing and removes it in a final full-depth wall lap |
| `drill` | plunges at each entity (e.g. circle centres); `stepdown` ignored. Optional `peckDepth` (mm) drills in increments, fully retracting between pecks (G83-style) to clear chips |
| `engrave` | follows geometry at depth |
| `pocket` | clears an area; `pocketStrategy` (`"offset"`/`"adaptive"`/`"raster"` — `"adaptive"` replaces any stretch that would bury the cutter deeper than a straight wall step with trochoidal circles, trading travel for load), and optionally uses `regions` OR explicit `entityIds` combined with `islandIds`. Optional `finishPass`/`finishAllowance` leave a wall skin during roughing and clean it in a final full-depth lap (round pockets clear with smooth G2 arcs + a helical entry) |
| `chamfer` | bevels an edge with a **v-bit**: traces the (optionally offset) contour at a depth derived from `chamferWidth` and the bit's `vAngle`. `chamferSide` (`"on"`/`"outside"`/`"inside"`) places the bevel relative to the edge; optional `sharpenCorners` pulls the tip up into sharp inside corners (tapering the bevel to the surface at the corner vertex) so they come to a point instead of a fillet. Used e.g. to chamfer a Shaker-pocket edge after clearing it with a pocket op |
| `vcarve` | **v-carves** a region at variable depth with a **v-bit**: the area (text glyphs, explicit `entityIds` chained into loops, or a flood-fill `region` with islands) is offset-peeled inward and each peel ring is cut at the depth where the bit's flanks touch both walls — so strokes taper to a sharp spine, and areas wider than the bit bottom out flat at \|`depth`\| (the max/floor depth). `vStep` (mm, default 0.4) is the radial pitch between peel passes — smaller = smoother floor, more passes. Optional `vHopClearance` (mm above the stock) hops between a region's contours at that low height instead of retracting to `safeZ` each time; leave it unset/0 (the safe default) if a clamp stands above the stock inside the carve footprint |
| `score` | **laser only** (`machineKind: "laser"`): traces the geometry centreline with **no kerf offset** at low power — a fold/crease line rather than a cut (the UI's "Score / Fold", defaulting to 15% power). On a mill there is no score; use `engrave`. Mill-only op types (`drill`, `pocket`, `chamfer`, `vcarve`, `relief-rough`) are conversely skipped with a G-code note on a laser |
| `relief-rough` | **Roughs** a greyscale **image** relief in flat Z-levels with a coarse flat / bull-nose tool: resamples the image at the tool's `stepover` (× diameter), and clears the bulk down to `finishAllowance` mm above the final relief surface in `stepdown` planes, leaving that allowance for the ball-nose relief **finish** pass (an `engrave` op on the same image) to carve. Runs the raster boustrophedon, **ramping into each cut** and hopping over uncut areas at a low clearance above the stock. Set its `depth` / `stepdown` / `stepover` / `reliefGamma` / `rasterInvert` to match the finish op, and order it **before** the finish op (a tool change between them). The editor warns if a roughing op's depth (less its allowance) would cut past the finish op's surface — a gouge |

`regions` (pocket/vcarve) is an alternative to explicit `entityIds`. While you can just list your boundary lines/arcs directly in `entityIds` (they will be chained into closed boundaries automatically) and list `islandIds` for any holes, the legacy/flood-fill way clears one or more **enclosed
faces** of the drawing. Each region is identified *parametrically* — not by a
coordinate — so it reflows when a driving dimension moves the geometry. A region
is `{ "containingLoops": [ ... ] }`, where each entry is the set of **entity ids**
whose live geometry forms a loop that encloses the face (a face lies inside
exactly its containing loops and outside all others). At toolpath time the loops
are rebuilt from current geometry, matched back by id-set, and the face — with any
enclosed loops as islands — is recomputed fresh. If a referenced loop no longer
exists, that region is skipped (with a G-code note) rather than cutting the wrong
area.

```jsonc
// Pocket the inside of a rectangle (ids r1..r4 form its boundary loop),
// with a circle "c1" sitting inside it automatically becoming an island:
{ "containingLoops": [ ["r1", "r2", "r3", "r4"] ] }
```

Authoring these by hand is awkward (you must know which entity ids chain into the
enclosing loop); in practice they're produced by region-picking in the toolpath
dialog. A single closed entity (circle, rectangle, closed polyline) is a one-id
loop, e.g. `{ "containingLoops": [ ["circle-7"] ] }`.

When hand-authoring, **naming just the innermost boundary loop is enough**: a
non-listed loop that fully contains the referenced area (e.g. the part outline
around a recessed panel) is treated as an additional containing loop, not
subtracted. Only loops that genuinely cut into the region (islands, overlapping
shapes) affect it. The app's region picker records the complete containing set;
both spellings resolve to the same face.

```jsonc
{ "id": "op1", "name": "Profile outline", "type": "profile",
  "entityIds": ["ent1"], "side": "outside",
  "toolType": "end-mill", "toolNumber": 2, "diameter": 6,
  "feedrate": 900, "plungeRate": 250, "spindleSpeed": 18000, "safeZ": 5,
  "depth": -12, "stepdown": 2, "stepover": 0.4,
  "tabs":   { "enabled": true, "count": 4, "width": 6, "height": 2 },
  // …or by spacing: { "enabled": true, "strategy": "spacing", "spacing": 50, "width": 6, "height": 2 }
  "leadIn": { "type": "arc", "length": 3 },
  "leadOut":{ "type": "arc", "length": 3 } }
```

Three optional cut-control fields apply across operation types:

- `cutDirection` (`"climb"` | `"conventional"`, profile only) — the cut direction
  relative to a standard M3 (clockwise) spindle: `"climb"` (CW around an outside
  profile / CCW inside) finishes cleanly on rigid machines, `"conventional"` is
  the reverse. Omitted = the raw offset winding is left untouched.
- `cornerStyle` (`"none"` | `"dogbone"`, inside profiles and pockets) — corner
  relief: `"dogbone"` adds a diagonal overcut at each convex inside corner so a
  mating square part seats instead of hitting the tool-radius fillet. Default
  `"none"`.
- `rampAngle` (degrees off horizontal, clamped 0.5–45) — entry angle for
  operations that descend into the cut gradually (the pocket helical/linear
  entry, the relief-rough ramp). Omitted = each mechanism's built-in default.

> **Feeds & speeds are not a recipe.** Any numbers you emit are starting points
> only and must be tuned for the actual material, tool, and machine. Always verify
> `depth`, the chosen `origin`, and tool changes before cutting.

### Parametric operation fields

Optional. `paramExprs` drives numeric operation fields from formulas instead of
fixed numbers, keyed by field name. Expressions are evaluated against
[variables](#variables) and `stock` before every solve, then clamped to the
field's valid range — so an operation can track the material rather than being
re-typed when it changes.

```jsonc
{ "id": "op1", "name": "Profile outline", "type": "profile",
  // …required fields as above…
  "depth": -12, "feedrate": 900,
  "paramExprs": { "depth": "-stock", "feedrate": "baseFeed * 1.2" } }
```

- The sibling numeric field (`depth`, `feedrate`, …) holds the **last resolved
  value**, and is the cache/fallback for fields with no expression or whose
  expression fails to evaluate. Always emit it — a file is valid and loadable
  without ever evaluating an expression.
- Bare numbers inside an expression are **millimetres**, matching variable and
  dimension formulas — `"0.5"` alone in an inch-unit document is 0.5 in, but
  `"0.5 * 2"` is 1 mm.
- Nested fields accept either the flat or dotted key: `"tabCount"` or
  `"tabs.count"`, `"leadInLen"` or `"leadIn.length"`. An expression for a nested
  field is ignored while its parent object (`tabs`, `leadIn`, `leadOut`) is
  absent, and applies once it exists.
- Renaming a variable in the app rewrites references inside `paramExprs`, as it
  does for dimension and feature expressions.

### Laser operations

When the document's `machineKind` is `"laser"`, the same operations are posted
as fixed-Z beam moves (no spindle, no Z plunge) and only two `type`s apply:
`profile` (cut) and `engrave`. The Z/spindle fields (`spindleSpeed`, `safeZ`,
`depth`, `stepdown`, `plungeRate`) are ignored, and these fields drive the cut
instead:

| Field | Applies to | Meaning |
|-------|-----------|---------|
| `laserPower` | both | beam power as a percentage (0–100) of the controller's max (GRBL `$30`), scaled to an `S` word. Default 80 |
| `laserPasses` | both | times the beam re-traces each path — the fixed-Z analogue of stepdown. Default 1 |
| `kerfWidth` | `profile` | beam kerf (mm); the closed contour is offset outward (`side: "outside"`) or inward (`"inside"`) by half this. 0 = cut on the line |
| `laserFill` | `engrave` | flood closed shapes with parallel scan lines (area/solid engraving) on top of the outline; counters (the hole in "O") stay clear. Default false |
| `laserFillSpacing` | `engrave` | scan-line spacing (mm) when `laserFill` is on — roughly the beam width. Default 0.2 |
| `laserOverscan` | `engrave` | fill **or** raster: distance (mm) the head runs past each scan line's/row's ends with the beam off, so it's at full speed when the beam fires (avoids over-burned edges). 0 = off. Default 0 |
| `airAssist` | both | turn on air assist (the post's air command, `M8`/`M9` by default), held across consecutive ops that request it. Default false |
| `rasterLineInterval` | `engrave` (image) | **raster engrave** (an Engrave op whose target is an `image` entity): vertical pitch (mm) between scan rows. Default 0.1 |
| `rasterDotPitch` | `engrave` (image) | raster: horizontal pitch (mm) between dots in a row. Omitted = square dots (= `rasterLineInterval`) |
| `rasterMinPower` | `engrave` (image) | raster: beam power (%) for the lightest engraved dot; `laserPower` is the power for a fully black dot. Default 0 |
| `rasterInvert` | `engrave` (image) | raster: engrave the light areas instead of the dark (photo negative). Default false |
| `laserOverride` | both | cut with this op's own beam settings, ignoring any `laser` recipe on its layer (see below). Default false |

#### Per-layer beam recipes

A **layer** may carry a `laser` recipe — `feedrate`, `laserPower`, `laserPasses`
and optionally `kerfWidth` / `airAssist`. Every operation whose `entityIds` all
sit on that layer takes those numbers at toolpath time, so the colour-driven
workflow (cut on black, score on red) is set up once and re-tuned in one place
after a test cut.

The rules, which mirror `toolId` on the mill side:

- The layer's numbers **replace** the operation's own; `kerfWidth` and
  `airAssist` fall back to the operation's when the recipe omits them.
- An operation whose geometry **spans several layers** keeps its own settings —
  there is no single correct answer for it.
- `"laserOverride": true` opts an operation out entirely. Set it where the
  numbers *are* the point, such as the cells of a material-test grid.
- A layer with no `laser` key changes nothing, which is how every file written
  before this existed behaves.
- Building a job skips **hidden** layers (`"visible": false`) and **workholding**
  layers — hiding something is how you take it out of the job.

```jsonc
// The "Cut" layer: everything on it burns at 100% and 300mm/min, three passes.
{ "id": "layer-cut", "name": "Cut", "color": "#000000",
  "visible": true, "locked": false,
  "laser": { "feedrate": 300, "laserPower": 100, "laserPasses": 3 } }
```

#### The layer as a job

A recipe may also say what its geometry is **for**, with `kind`: `"cut"`,
`"score"`, `"engrave"` or `"fill"` (a filled/solid engrave). Layers carrying a
kind can be turned into a whole program in one action — **Toolpaths from Layers**
in the CAM panel — producing one operation per layer, in layer order, named after
the layer.

**This makes `operations` optional for a laser design.** Emitting layers with
kinds and an empty `operations` array is a valid and compact way to describe a
job: the file says what each colour is for and how hard to cut it, and the user
presses one button to get the toolpaths. That is usually a better thing to
generate than hand-built operations, because you cannot get the entity lists,
the kerf direction or the cut order wrong.

`kind` behaves differently from the numbers beside it, and the asymmetry is
deliberate:

| | applied | why |
|---|---|---|
| `feedrate`, `laserPower`, `laserPasses` | **live**, at toolpath time | parameters — they change how hard the same move is cut, so re-tuning a layer re-tunes every operation on it |
| `kind` | when operations are **built** | structure — a cut is a kerf-compensated closed contour, an engrave a centreline, a fill floods the interior. Retyping an existing operation at export would emit different geometry than the previewed toolpath |

So changing a kind does not retype toolpaths that already exist; rebuild to apply
it. A layer with a recipe but no `kind` still tunes the operations that cut it —
it just isn't a job of its own.

##### Kerf direction

`side` applies to `"cut"` only and is normally **omitted**, meaning *auto*.

Kerf compensation has a direction: to finish at the size you drew, the beam
centreline runs **outside** an outline and **inside** a hole. Use one direction
for both and every hole comes out a full kerf oversize. So a cut layer with a
kerf is split by containment — a contour enclosed by another contour on the same
layer is a hole — and builds **two** operations, holes first. That is also the
order you would run it by hand: cut the interior features while the part is
still held by the sheet, then free it with the outline.

With no kerf there is nothing to compensate, so the layer stays one operation.
Set `side` explicitly to force one direction throughout — an inlay or a press
fit, where you want every contour biased the same way.

```jsonc
// A two-colour job: cut the outline, score the fold lines.
"layers": [
  { "id": "l-cut", "name": "Cut", "color": "#000000", "visible": true, "locked": false,
    "laser": { "kind": "cut", "feedrate": 300, "laserPower": 100, "laserPasses": 3,
               "kerfWidth": 0.15 } },
  { "id": "l-score", "name": "Score", "color": "#e05a5a", "visible": true, "locked": false,
    "laser": { "kind": "score", "feedrate": 1800, "laserPower": 15, "laserPasses": 1 } }
]
```

A raster engrave is produced when an **Engrave** op's `entityIds` reference an `image` entity: the greyscale pixels are swept as horizontal scan rows, modulating beam power per dot (`laserPower` for black down to `rasterMinPower` for the lightest mark). `laserPower` is the *darkest* power; `laserPasses` repeats the whole sweep.

On a **mill** (machineKind `"mill"`), the same Engrave-op-targeting-an-image instead carves a **relief**: each dot's darkness maps to **Z depth** (darkest = `depth`, white = the surface), cut as continuous boustrophedon rows reached over `stepdown` passes. It needs a **ball-nose** (the smooth-relief tool, and the default) — a **V-bit** is allowed but carves an engraving-like result (a cone per dot) and is flagged with a note; a flat end mill is rejected. The default stepover is ~10% of the cutter diameter. `rasterLineInterval` is the stepover and `rasterDotPitch` the horizontal dot pitch; `rasterInvert` carves the light areas instead; `reliefGamma` applies a tone curve (`depth ∝ darkness^gamma`, default linear) to keep a photo from reading flat. (`laserPower`/`rasterMinPower` are ignored.)

```jsonc
// Laser: cut a circle with 0.2mm kerf, and area-fill-engrave a rectangle.
// (document-level: "machineKind": "laser")
{ "id": "op1", "name": "Cut", "type": "profile", "entityIds": ["circle-1"],
  "side": "outside", "toolType": "end-mill", "toolNumber": 1, "diameter": 0,
  "feedrate": 1200, "plungeRate": 300, "spindleSpeed": 0, "safeZ": 5,
  "depth": -3, "stepdown": 1.5, "stepover": 0.4,
  "laserPower": 90, "laserPasses": 2, "kerfWidth": 0.2 }
```

## Tools

The top-level `tools` array holds reusable tool definitions. An operation
references one by `toolId`; a single tool can drive many operations, so a feed or
diameter change in one place updates every operation that points at it. `tools` is
optional and defaults to `[]`.

Each tool requires `id`, `name`, `toolType`, `diameter`, `feedrate`, `plungeRate`,
`spindleSpeed`, and `safeZ`; `vAngle`, `tipDiameter`, and `tipAngle` are optional
and type-specific (as on operations). The `id` is the target of an operation's
`toolId`.

```json
{ "id": "tool-em-6", "name": "6mm End Mill", "toolType": "end-mill",
  "diameter": 6, "feedrate": 900, "plungeRate": 250, "spindleSpeed": 18000, "safeZ": 5 }
```

When RapidCAM saves a file it embeds only the tools actually referenced by an
operation, so the file is self-contained and portable. See
`mounting-plate-cam.rcam` for an example of two operations driven by a shared
`tools` library.

## Fonts

A text entity's `fontId` must resolve to a font. **Bundled** fonts (currently
`"roboto-regular"` and `"roboto-bold"`) ship with the app and resolve by id, so
they are never embedded. Any **other** font — one a user loaded from disk — is
embedded in the top-level `fonts` array so the file is self-contained: it renders
and cuts identically on a machine that has never seen that font.

Each embedded font has a content-addressed `id` (`"font-XXXXXXXX"`, an FNV-32 hash
of the bytes, so the same font always dedupes to the same id), a human-readable
`name`, a `format` (`"ttf"` | `"otf"` | `"woff"`), and base64-encoded `data`.

```jsonc
{ "id": "font-1a2b3c4d", "name": "Some Custom Font",
  "format": "ttf", "data": "AAEAAAAL..." }   // base64 font bytes
```

RapidCAM embeds only the fonts actually referenced by a text entity. If a text
entity's `fontId` is neither a bundled font nor present in `fonts`, the text cannot
be rendered or cut.

## Validating your output

```bash
# From the repo, the bundled examples are checked on every test run:
npm test -- rcam-schema
```

External tools can validate against [`public/schema/rcam-v3.schema.json`](../public/schema/rcam-v3.schema.json)
with any JSON Schema (draft 2020-12) validator. The schema enforces structure and
enumerations; it cannot tell you whether a constraint system converges or a pocket
seed lands inside its region — for that you need to load the file in RapidCAM.

## Reference examples

The files in [`examples/`](../examples/) form a difficulty progression and are the
canonical, tested references:

- `keychain-tag.rcam` — smallest complete part (rectangle, circle, text, driving dims).
- `mounting-plate.rcam` — fully-constrained plate with `equal` + `symmetric` holes.
- `bracket.rcam` — L-profile driven to "fully constrained" with per-segment H/V constraints.
- `bolt-circle.rcam` — `variables` + a circular `pattern`.
- `mounting-plate-cam.rcam` — drill + tabbed profile `operations`.
- `enclosure-lid.rcam` — pocket with parametric region `containingLoops` and an island.
- `vcarve-sign.rcam` — `vcarve` + `chamfer` operations sharing one v-bit via the `tools` library.
- `laser-coaster.rcam` — `machineKind: "laser"` with outline/fill engraves and a kerf-compensated cut.
- `rotary-spiral-dowel.rcam` — `machineKind: "mill-rotary"` + the `rotary` cylinder block.
- `tumbler-wrap.rcam` — `machineKind: "laser-rotary"`: the same `rotary` block with a beam
  head, so the wrapped axis is substituted rather than wrapped.
