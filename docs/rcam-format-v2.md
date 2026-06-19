# RapidCAM `.rcam` file format — version 2

This is the authoring guide and stability contract for the RapidCAM project file
format. A `.rcam` file is plain JSON. The machine-readable contract lives in
[`public/schema/rcam-v2.schema.json`](../public/schema/rcam-v2.schema.json) (JSON Schema, draft
2020-12); this document is the human- (and AI-) readable companion that explains
the parts a schema can't — the vocabulary of point keys, what each constraint
means, and the gotchas.

The schema's canonical published URL is
**`https://rapidcam.app/schema/rcam-v2.schema.json`** (this is also its `$id`).
In the repository it lives at
[`public/schema/rcam-v2.schema.json`](../public/schema/rcam-v2.schema.json), which
is what gets served at that URL.

If you are an automated tool (including an LLM) generating `.rcam` files: validate
your output against the schema, and prefer the patterns shown in
[`examples/`](../examples/). The bundled examples are golden files and are tested
against this schema on every commit.

## What changed from version 1

Version 2 treats a `.rcam` file as a **design**, not an editor session:

- **No selection / UI state.** The top-level `isConstructionMode`,
  `selectedPoints`, `selectedConstraintId`, `selectedDimensionId` fields and the
  per-entity `selected` flag are gone. (A file shouldn't record what happened to be
  selected when it was saved.)
- **Embedded fonts.** A new optional top-level [`fonts`](#fonts) array carries the
  bytes of any non-bundled font a text entity uses, so glyph outlines — and
  therefore toolpaths — reproduce on any machine.

Version-1 files still open: RapidCAM upgrades them on load (dropping the UI state).
The set of entity types, constraint types, dimension types, and point-key
vocabularies is unchanged.

## Stability promise

- Every file declares `"version": 2`. The loader auto-upgrades `"version": 1`.
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
  "version": 2,
  "name": "My Part",
  "canvas": { "width": 120, "height": 80 },   // mm
  "displayUnit": "mm",                          // "mm" | "in" (display only)
  "stockThickness": 10,                         // mm, default 10
  "hasToolChanger": false,
  "origin": { "x": "left", "y": "front", "z": "top" },
  "postProcessor": "linuxcnc",                  // "linuxcnc" | "grbl"
  "endPosition": null,                          // optional park position; see below
  "groups": [],
  "layers": [ /* optional; a Default layer is created if omitted */ ],
  "activeLayerId": "layer-0",
  "entities": [ /* geometry */ ],
  "constraints": [ /* parametric constraints */ ],
  "dimensions": [ /* measurements / driving dims */ ],
  "variables": [ /* named numbers */ ],
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
  "version": 2,
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

Defaults applied when omitted: `stockThickness` → 10, `hasToolChanger` → false,
`origin` → front-left-top, `postProcessor` → `"linuxcnc"`,
`endPosition` → `null`, `layers` → one `"layer-0"` "Default" layer,
`groups`/`variables`/`patterns`/`operations`/`tools`/`fonts` → empty.

Coolant is **per operation** (`operations[].coolant`), not a top-level field.
Custom program start/end G-code and the "machine has coolant" capability are
machine-wide (localStorage) preferences, since they describe the operator's
shop, not the design — so they are not stored in the file either.

`endPosition` is an optional `{ "x", "y" }` (work coordinates, mm) the spindle
rapids to at safe Z just before `M30`; `{ "x": 0, "y": 0 }` parks at the WCS
origin. `null` (or omitted) leaves the tool wherever the last toolpath ended.

## IDs

- Every `id` is a string, unique within the file. RapidCAM uses `"<prefix><n>"`
  (`ent1`, `con3`, `dim2`, `var1`, `pat1`), but any unique non-empty string works.
- `"__origin__"` is **reserved** for the work-coordinate-system origin point.
  RapidCAM injects it automatically on load — you don't need to author it, and you
  shouldn't reuse the id.
- `layerId` on an entity should reference a real layer id; it defaults to
  `"layer-0"`.

## Entities

Each entity is an object tagged by `type`. Common optional fields: `isConstruction`
(default false — construction/reference geometry, excluded from CAM) and `layerId`
(default `"layer-0"`).

The **point keys** below are the addresses constraints and dimensions use to refer
to a specific point on an entity (via a `{ "entityId", "key" }` pair). Getting
these right is the single most important thing when authoring constraints.

| `type` | Geometry fields | Point keys (for constraints/dimensions) | Scalar DOFs |
|--------|-----------------|------------------------------------------|-------------|
| `line` | `a`, `b` (Vec2) | `a`, `b` endpoints; `mid` (derived, pickable) | — |
| `circle` | `center` (Vec2), `radius` | `c` center | `r` radius |
| `rectangle` | `p0`, `p1` (opposite corners) | corners `bl` `br` `tr` `tl`; edge mids `mid_b` `mid_r` `mid_t` `mid_l`; `center` | — |
| `polyline` | `points` (Vec2[]), `closed` (bool) | vertices `v0` `v1` … `vN`; segment mids `mid_0` `mid_1` … | — |
| `arc` | `center`, `radius`, `startAngle`, `endAngle` (rad, CCW) | `c` center; `start`, `end` (derived) | `r`, `sa`, `ea` |
| `bezier` | `p0` `p1` `p2` `p3` (start, start handle, end handle, end) | `p0` `p3` (constrainable); `p1` `p2` (drag-only) | — |
| `point` | `pos` (Vec2) | `p` | — |
| `text` | `text`, `fontId`, `sizeMM`, `position`, `angle` (rad) | `pos` baseline-left anchor | — |

Notes:
- A **Vec2** is `{ "x": number, "y": number }` in mm.
- `rectangle` is axis-aligned; `p0`/`p1` are normalised to min/max corners on load.
- A **polyline segment** can stand in for a line anywhere a line-type constraint
  expects an entity: use the entity reference string `"<polylineId>#<segmentIndex>"`
  (segment from vertex `index` to `index+1`).
- `fontId` is either a bundled font (e.g. `"roboto-regular"`) or a `"font-XXXXXXXX"`
  id present in the top-level [`fonts`](#fonts) array. Text stays editable until CAM
  export, where it is expanded to glyph contours.

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
| `fixed` | `entities[1+]` | lock all the entity's DOFs (no equation) |

A constraint object is:

```json
{ "id": "con1", "type": "fixedPoint",
  "points": [{ "entityId": "ent1", "key": "bl" }],
  "entities": [], "params": [15, 12] }
```

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

Optional: `anchors` (`[t1, t2]`, for `line-distance` extension lines) and `expr`
(a formula string driving `value`, e.g. `"width * 2"`, evaluated against
`variables`).

```json
{ "id": "dim1", "type": "diameter", "points": [], "entities": ["ent2"],
  "value": 6, "driving": true, "offset": 2.356 }
```

## Variables

Named numbers referenced by dimension/pattern expressions. `expr` is the raw input
string (`"100"`, `"50mm"`, `"3.5in"`); `value` is its cached evaluation in mm.
`name` must match `^[a-zA-Z_][a-zA-Z0-9_]*$`.

```json
{ "id": "var1", "name": "pcd", "expr": "60mm", "value": 60 }
```

## Patterns

Linear or circular replication. `sourceIds` are the master entities; `instanceIds`
holds one sub-array of entity ids per generated step. **The copy entities listed in
`instanceIds` must also appear in `entities`** — a pattern records the relationship;
it does not generate geometry on load.

```jsonc
{ "id": "pat1", "kind": "circular",
  "sourceIds": ["ent2"],
  "instanceIds": [["ent3"], ["ent4"], ["ent5"], ["ent6"], ["ent7"]],
  "params": { "count": 6, "cx": 45, "cy": 40, "totalAngle": 6.283185 } }
```

- Linear params: `countX`, `countY`, `spacingX`, `spacingY` (mm), optional
  `spacingXExpr` / `spacingYExpr` (variable expressions).
- Circular params: `count`, `cx`, `cy` (centre, mm), `totalAngle` (radians; `2π`
  = full circle).

## CAM operations

Each operation is a toolpath over some `entityIds`. Required fields cover the tool
and cut; several are type-specific and optional. `depth` is mm below the surface
and is **negative** for cuts. `stepover` is a fraction of tool diameter (0–1).
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

| `type` | Notes |
|--------|-------|
| `profile` | contours a closed shape; uses `side` (`"outside"`/`"inside"`), optional `tabs`, `leadIn`, `leadOut` |
| `drill` | plunges at each entity (e.g. circle centres); `stepdown` ignored |
| `engrave` | follows geometry at depth |
| `pocket` | clears an area; `pocketStrategy` (`"offset"`/`"raster"`), and `regions` |

`regions` (pocket) is the subtle one. A pocket clears one or more **enclosed
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

```jsonc
{ "id": "op1", "name": "Profile outline", "type": "profile",
  "entityIds": ["ent1"], "side": "outside",
  "toolType": "end-mill", "toolNumber": 2, "diameter": 6,
  "feedrate": 900, "plungeRate": 250, "spindleSpeed": 18000, "safeZ": 5,
  "depth": -12, "stepdown": 2, "stepover": 0.4,
  "tabs":   { "enabled": true, "count": 4, "width": 6, "height": 2 },
  "leadIn": { "type": "arc", "length": 3 },
  "leadOut":{ "type": "arc", "length": 3 } }
```

> **Feeds & speeds are not a recipe.** Any numbers you emit are starting points
> only and must be tuned for the actual material, tool, and machine. Always verify
> `depth`, the chosen `origin`, and tool changes before cutting.

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

External tools can validate against [`public/schema/rcam-v2.schema.json`](../public/schema/rcam-v2.schema.json)
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
- `enclosure-lid.rcam` — pocket with flood-fill `regionSeeds` and an island.
