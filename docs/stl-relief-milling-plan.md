# STL import & 3D relief milling — implementation plan

Written 2026-08-15.

Status: **Phase 1 SHIPPED 2026-08-16; Phase 1.5 SHIPPED 2026-08-16.** Item 3 (tool-profile dilation) landed
separately as #62, because it turned out to be a live bug in the existing relief
path rather than an STL prerequisite — a hard-edged heightfield gouged 2.905 mm
on a 3 mm part. Items 1, 2, 4 and 5 followed.

**One thing below is wrong and is left standing as written**, because the reason
matters more than the tidiness: the persistence section claims **"zero `.rcam`
schema change"**. It isn't. `embeddedImage` is `additionalProperties: false`, and
the height-map marker has to persist — without it, reopening a saved file re-reads
the buffer as a photograph and silently re-flattens the top 4% of the model's
height range. `zRangeMM` was added as an OPTIONAL field (old files still load),
with the full 4-step drift checklist.

**Phase 1.5 SHIPPED 2026-08-16**, but *not* on the signal this plan proposed —
`emptyCells` was measured against real files and rejected. See that section below;
the short version is that it measures the model's SHADOW, and a real relief in the
test corpus scores 17.3% on it. After this, the steep/shallow split is the
highest-value item and needs only the local gradient, so it does not depend on
Phase 3 or 5.

## The decision

Import an STL, rasterise it **once** into a heightfield, and machine it through the
relief path that already exists. No mesh in the document, no new op types, no mesh
feature recognition.

### Prior art: the field splits into two schools

The dividing line is **whether tool contact is computed against a sampled image or
against the triangles directly.**

**School 1 — heightfield / z-buffer.** Sample the mesh into a grid once, machine the grid.
Vectric Aspire/VCarve is the reference: STL import "reads the triangular mesh and converts
it into a height map", which becomes a *relief component* you place, scale and combine,
then bake. Easel Pro, Carveco (ArtCAM lineage) and Carbide Create Pro follow the same
model.

**School 2 — direct against the mesh.** `opencamlib` is the canon: **drop-cutter** (drop a
cutter at a given `(x,y)` until it touches the model) and **push-cutter** (builds
waterlines). MeshCAM is the most complete hobby-tier implementation of it; Kiri:Moto does
it in a browser; Fusion is B-Rep territory.

**The deciding data point:** Blender CAM ships *both* and documents when to pick which —
*"In non-exact mode, an image is used to estimate the cutter offsets… Non-exact mode is
good for high poly meshes, several millions of polygons shouldn't be a problem for it."*
An open-source project that implemented both recommends the image on exactly the axis a
client-side browser app cares about. **Phase 1 below is Blender CAM's non-exact mode, not
a shortcut.**

Note also opencamlib's own assessment: the drop-cutter is *"the oldest and most stable"*
while *"the waterline algorithm has some bugs that show up now and then."* The reference
implementation is telling us to do drop-cutter first and defer waterline — which is the
phasing below.

### Why this shape

Every browser/hobby CNC tool that ships STL machining does exactly this — Easel Pro,
Vectric VCarve/Aspire, Carbide Create Pro, Estlcam. Easel's own docs steer users away
from full 3D models as input:

> "STL files with a flat face or flat bottom will work best… Many STL files used for 3D
> printing have a full 3D shape. These kinds of files will work, but for CNC router
> applications, relief-styled models work best."

Easel Pro ships **two** operations for a 3D model: a roughing pass with a flat end mill
and a detail pass with a ball-nose. That is the whole feature. Their tapered ball-nose
support is "enter it as *other bit* and type a diameter" — they don't model the taper.

RapidCAM already has both of those passes, plus rest machining, which Easel users have
been asking for on the forum for years ("missing bits between roughing and finishing",
"adding an extra pass between roughing and detail", "finishing pass plunges too deep").
That gap is a stepdown-sized wall of material handed to a small ball-nose in one go.

### Explicitly not doing

- **Mesh feature recognition** (click a face on the STL → get a pocket/drill/profile op).
  Tessellation has already destroyed the information this needs. Commercial FR runs on
  B-Rep solids where a cylindrical face knows its radius; an STL hole is *n* chords, and
  fitting a circle to it is undersize by `R·(1 − cos(π/n))` — ~15 µm at 32 facets, ~61 µm
  at 16. Coplanarity needs an epsilon that a 0.02° model rotation defeats. And the payoff
  is a dumb polygon in an app whose whole value is parametric, editable geometry.
- **True waterline / 3-axis roughing.** Deferred to Phase 5, only on demand.
- **A `Mesh3DEntity` in the document.** See the persistence decision below.

## What already exists (verified 2026-08-15)

The relief path is already a depth-field surfacing engine. The seam into it is a
`RasterGrid`.

| Piece | Location | What it does |
|---|---|---|
| `RasterGrid` | [rasterEngrave.ts:34](../src/cam/rasterEngrave.ts#L34) | `{width, height, data}`, values 0..1. **The integration seam.** |
| `rasterField()` | [rasterEngrave.ts:291](../src/cam/rasterEngrave.ts#L291) | grid → rows of per-dot cut levels |
| `reliefImage()` | [gcode.ts:1257](../src/cam/gcode.ts#L1257) | finish pass: stepdown passes, equal-Z run merging, ball-nose/V-bit |
| `reliefRoughImage()` | [gcode.ts:1439](../src/cam/gcode.ts#L1439) | `relief-rough` op: coarse regrid at stepover, Z-planes, `finishAllowance` |
| `reliefSpacing()` | [halftone.ts:197](../src/cam/halftone.ts#L197) | shared row/dot pitch resolver — posted G-code and preview cannot disagree |
| `rasRelief` / `rasReliefRough` | [stockRasterizer.ts:610](../src/cam/stockRasterizer.ts#L610), [:663](../src/cam/stockRasterizer.ts#L663) | 3D preview simulation of both passes |
| `registerGrey()` | [imageManager.ts:118](../src/core/imageManager.ts#L118) | register a greyscale buffer directly, no file decode |
| `collectEmbeddedImages()` | [imageManager.ts:239](../src/core/imageManager.ts#L239) | base64 embedding into `.rcam` |
| `restRegions()` | [rest.ts:55](../src/cam/rest.ts#L55) | rest machining — the Easel gap |
| `RasterImageEntity` | [entities.ts:2090](../src/model/entities.ts#L2090) | `imageId`, `position`, `widthMM/heightMM`, `angle`, `flipX/Y` |

There is currently **no STL code anywhere in `src/`**.

## Architecture: persistence

**Do not add a mesh to the document model.** After rasterising, the mesh is dead — what
machining needs is the heightfield, which is an image, and images already persist.

So an imported STL becomes a `RasterImageEntity` backed by a `registerGrey()` buffer.
That means:

- **Zero `.rcam` schema change** for the core feature (see the drift guard caveat below).
- File size stops mattering after the parse — Easel accepts 100 MB STLs because they have
  a backend; we don't need one, because we never persist the triangles.
- Flip, rotary, tiling, the 3D preview, lint, and the op list all work unchanged.

### The open question that must be answered first

`ImageEntry.gray` is a **`Uint8Array`** ([imageManager.ts:113](../src/core/imageManager.ts#L113)),
and `RasterFieldParams.levelStep` defaults to `1/255`. So a persisted heightfield has
**256 depth steps**:

| Model height | Step size | Verdict |
|---|---|---|
| 3 mm relief | 12 µm | invisible, fine |
| 25 mm model | 98 µm | **visible terracing on a smooth dome** |

Three options, decide before Phase 1 lands:

1. **Ship 8-bit**, warn above some height. Cheapest; matches what photo reliefs already do.
2. **Widen the store to 16-bit.** Touches `ImageEntry`, `EmbeddedImage`, `getImageGrid`,
   the greyscale path, and **the `.rcam` schema** — which means the 4-step drift checklist
   (schema + format doc + llms.txt + kitchen-sink fixture).
3. **Keep the mesh in memory only**, re-rasterise on load, persist nothing but the source
   file. Loses round-tripping unless the STL is embedded, which is the size problem again.

Recommendation: **(1) for Phase 1**, with the measurement written down, and (2) as its own
change if terracing actually shows up in a real carve.

## The one real technical gap: gouging

`reliefImage` **point-samples** the field — `Z = level × depth` at each dot. That is fine
for a photo (smooth, shallow). Feed it an STL with a convex edge and **the ball's flank
digs into material the centre-point sample said was clear.** Silent; the result is just
rounded-off and undersized.

The fix is that the tool contact height is a **max over the tool footprint**, i.e. a
greyscale dilation of the heightfield by the inverted tool profile. This *is*
opencamlib's drop-cutter, evaluated in image space instead of per-query — so it isn't an
approximation of the right answer, it's the same algorithm on pre-sampled input:

```
z_tool(xc, yc) = max over {(x,y) : d ≤ R} of  ( Z(x,y) − (R − sqrt(R² − d²)) )
                 where d = hypot(x − xc, y − yc)
```

For a flat end mill the profile term is 0 (plain max over a disc). For a V-bit it is
`d / tan(halfAngle)`. ~30 lines over the grid, separable-ish, run once at op time.

**This is not optional.** Without it every STL comes out with softened convex features and
no error message. It is also a latent improvement for photo reliefs with hard edges.

## Encoding gotchas found while reading the code

These will silently produce wrong depths if missed:

- **Direction.** `tone: "encoded"` gives `level = 1 − value`, and `depth = level × maxDepth`.
  So encode `byte = round(255 × (z − zMin) / (zMax − zMin))` — model **top** = 255 = no cut.
- **`gamma` must be 1.** The tone curve is for making photos read right; on a heightfield
  it is a geometry error. Hide or force it for STL-backed images.
- **`whiteThreshold` defaults to 0.96** ([rasterEngrave.ts:299](../src/cam/rasterEngrave.ts#L299)) —
  bytes ≥ ~245 are treated as blank/level 0. On a photo that stops the background being
  scorched. On a heightfield it **flattens the top 4% of the model's height range** (1 mm
  on a 25 mm model). Pass `whiteThreshold: 1.01` for STL-backed reliefs.
- **`tone` must stay `"encoded"`, never `"linear"`.** Linear light is for halftone *area
  coverage*; a heightfield byte is already a length. (Same distinction as the resample
  finding — the linear-light lesson is about tone mapping, not about depth.)
- **Halftone mode must be off** for STL-backed images — it reinterprets the field as a
  V-groove screen.

### Drift risk (this project's known defect class)

`reliefRoughImage`'s own doc comment says it out loud:

> "The op's depth / gamma / invert / flip should MATCH the finish op or the left allowance
> won't be uniform; they're exposed on both ops for that reason."

That is already two copies of one fact. STL adds a third quantity that must agree —
the height encoding (`zMin`/`zMax`). **Do not type it into two ops.** Derive it from the
image/entity, and add a guard that fails when a rough and its finish disagree.

## Phases

### Phase 1 — STL → heightfield → existing relief ops (the whole feature, minimally)

Ships Easel parity.

1. **`src/io/stlImport.ts`** — binary + ASCII parser → `Float32Array` triangle soup, plus
   bounds. Binary detection by size arithmetic (`84 + 50·n`), not by the "solid" keyword
   (binary STLs lie about it). Reject/repair NaNs. No BVH yet.
2. **`src/cam/stlHeightfield.ts`** — drop-cutter rasteriser: triangles → `Uint8Array`
   heightfield at a chosen cell size, by scanline-rasterising each triangle into the grid
   and keeping the max Z. Returns the buffer + `zMin`/`zMax` + suggested mm extents.
   Runs in a Web Worker if it measures slow — measure first, don't assume.
3. **Tool-profile dilation** (the gouging fix), applied at op time from the op's tool.
4. **Import UI** — file picker/drop → orientation (the model arrives Z-up or not),
   scale (auto-detect mm vs inch by bounds heuristic + a units prompt), placement on the
   stock, and the carve-depth mapping. Lands as a `RasterImageEntity`.
5. **Wire the encoding flags** above so an STL-backed image can't be tone-curved.

Verification: parse → rasterise → **render the heightfield to ASCII/PNG and look at it**
before trusting any test. A known-shape STL (a hemisphere, a stepped block) has a
defining invariant to assert — a hemisphere of radius R must read `sqrt(R² − r²)` at every
cell, to within cell size. `/run` the app afterwards; unit tests do not see the wiring.

**Shipped 2026-08-16 except one thing, recorded here so it isn't lost:**

### Phase 1.5 — warn when the model isn't relief-shaped ✅ SHIPPED

**Do this before Phase 2.** It is small, it sits on data that already exists, and it is
the difference between a user learning the limitation from the docs and learning it from
a ruined blank.

The heightfield rasteriser already computes and returns **`emptyCells`** — cells no
triangle covered, i.e. the model's footprint doesn't fill its bounding box. A high count
means a full 3D shape rather than a relief: undercuts and vertical walls that a
3-axis heightfield carve will quietly flatten into the base plane, because unmodelled
cells are treated as full depth (the Vectric/Easel convention, chosen deliberately).

Today the import dialog says *"models with a flat back work best"* — advice that sits
there whether or not it applies. **Nothing actively warns**, so the one case that needs
the sentence never gets it while every case that doesn't, does.

Easel warns here, and their own docs steer users away from full 3D input:

> "STL files with a flat face or flat bottom will work best… Many STL files used for 3D
> printing have a full 3D shape. These kinds of files will work, but for CNC router
> applications, relief-styled models work best."

Shape of the work: threshold `emptyCells / totalCells`, warn at import with the actual
percentage rather than a generic caution, and say what will happen to those regions —
"37% of this model has nothing above the base plane and will be cut flat" beats "models
with a flat back work best". Calibrate the threshold against a real relief and a real
printed-model STL rather than picking a number; a hemisphere on a plinth is legitimately
mostly-empty at its corners and must not trip it.

#### What shipped instead, and why (2026-08-16)

**`emptyCells` was measured and rejected.** The instinct above — that it is "the data
already on hand" — is right, but it is data about the wrong thing. `emptyCells/total` is
one minus (silhouette area ÷ bounding-box area): a measure of the model's **shadow**,
which is independent of its depth. Four shapes with the same shadow:

| shape | empty | actual damage |
|---|---|---|
| hemisphere on its disc | 21.5% | 0.0% |
| sphere | 21.5% | 20.1% |
| sealed hollow ball | 21.5% | 20.1% |
| open-topped vase | 21.5% | 0.3% |

And on real files: `dragon_wall_art-01.stl`, a relief a user would carve unchanged, is
**17.3% empty**; a torus lying flat is 44.3%. Any threshold low enough to catch a printed
figurine fires on both. There is no such threshold — the ordering is wrong, not the number.

**Shipped: `plinthRatio`.** The carve leaves `zMin ≤ z ≤ zTop(x,y)`; the model occupies
`zBottom(x,y) ≤ z ≤ zTop(x,y)`. The difference is plinth, material a cutter coming from
above can never reach:

    plinthRatio = 1 − Σ(zTop − zBottom) / Σ(zTop − zMin)

One extra `Float32Array` in the existing raster loop, bounded in [0,1] by construction.

**Threshold 10%, and the first attempt at it was wrong.** It was initially set to 5% on a
31-model corpus that looked like it had a clean empty band from 3.8% to 8.8%. Re-measured
over **929 real objects** — every STL plus every mesh inside every 3MF in a working
maker's download folder — *that band does not exist*; the distribution is continuous. The
corpus even supplies the disproof for free: `Imperial_Setup_Blocks_Case` is one part at
fourteen thicknesses and reads 4.0, 4.2, 4.4, 4.7, 4.8, 4.9, 5.1, 5.2, 5.3, 5.3, 5.4, 5.4,
5.5% — the same design, equally carveable at every size, drifting straight across a 5% line.

So it is an operating point, not a discovered boundary, and it is pinned by the two classes:
reliefs run 0.0–**4.7%** (the top one being `mother-day-gift-elegoo`, a framed decorative
panel — rendered and looked at, not guessed from its name), while solid 3-D forms start at
12.4% with the mildest textbook case, a sphere, at exactly 20.0%. 10% is a little over 2×
the worst relief and well under every solid form, and fires on ~15% of the corpus, which
keeps it from becoming wallpaper. Between 5% and 10% sit setup blocks, hand clamps and
gridfinity bins — printed parts that lie flat, where a pass from above does reproduce the
top form. `scripts/stl-relief-probe.ts` reproduces all of it (it reads 3MF too).

**Taking the model's volume from the facet winding was tried and rejected.** It is the
more obvious formulation and it is wrong on real files: `resurgence-2.stl` and
`35-36.5mm_adapter.STL` both report a *negative* waste, impossible for a solid, because
their doubled shells are wound so an invisible cavity adds instead of subtracting — and
the standard closedness test (area-weighted normals summing to zero) passes both at
~1e-18. Spanning between the outermost crossings has no opinion about winding.

**Undercut area was measured and deliberately not shipped.** Counting cells whose
vertical ray crosses the surface more than twice detects material-over-void exactly (a
sealed hollow ball reads 81.0%, matching `(18/20)²` in closed form). But it fires 99.8% on
`resurgence-2` and 100% on `SonicKnifePCB` — both *hollowed* prints whose top surface
carves perfectly — so it is a bad warning signal, and it costs a two-pass crossing list
(~2.5 s, tens of MB) that the dialog would recompute on every control change. It is the
right tool for Phase 2's steep/shallow split, not for this.

**The warning follows the up axis, which turned out to be the most useful part.**
`apolo_v1.stl` reads 61.0% carved from the back, 12.4% from above and 0.4% from the face,
so the warning doubles as a guide to the correct orientation: change the axis and it
clears as the preview snaps into a relief. (`atenea_v1` behaves the same way but peaks at
5.8% seen from above, so at a 10% threshold that one orientation goes unwarned — the
preview showing the top of her head is what has to carry it there.)

**One more defect worth recording: an open mesh read 100%.** A relief face exported
without a back — scanned and sculpted reliefs routinely are — has `zTop == zBottom`, so the
span collapses and it read as pure plinth: the loudest possible warning on the most
relief-shaped input there is. Both sums now skip cells with no measurable thickness. The
test suite missed it because its only open fixture, `sliverPlate`, is perfectly flat and
exits down the zero-range path, passing for the wrong reason.

Undercuts need no user option: keeping the max Z *is* treating them as vertical walls, and
there is no second mode to switch to. The standing note says so instead.

### Phase 2 — close the Easel gap

- **Steep/shallow split — the highest-value item, and nearly free here.** MeshCAM's
  *Surface Angle Limit* machines only areas flatter than a threshold with the parallel
  raster, and only areas steeper than a minimum with waterline; their "Unified" finishing
  switches automatically. The reason is geometric: a raster stepping 0.15 mm in XY across
  a near-vertical wall leaves scallops spaced by however far the wall climbs in that
  0.15 mm — i.e. effectively unfinished.

  MeshCAM needs triangle normals for this. **On a heightfield it's the local gradient:**
  `angle = atan(hypot(dZ/dx, dZ/dy))` — a few ops per cell on data we already have. So we
  can ship the pro-tier strategy on the hobby-tier architecture: parallel raster where the
  grid is shallow, Z-level passes where it's steep, split on a slope threshold. **No mesh
  slicing required**, so this does not depend on Phase 3 or 5.
- **Rest pass between rough and finish** via `restRegions()`, so the ball-nose isn't
  handed a full stepdown of material on a steep wall. This is the standing complaint on
  Easel's forum.
- **Tapered ball-nose as a real `ToolType`.** Currently `ToolType` is
  `"end-mill" | "ball-nose" | "v-bit" | "drill"` ([types.ts:19](../src/cam/types.ts#L19)).
  Model it the way opencamlib does — a `CompositeCutter`, i.e. a cone with a ball tip, not
  a single diameter. (Easel punts entirely: you enter a tapered bit as "other bit" and type
  a diameter.) Adding a tool type has fan-out — follow the 12-place op/tool checklist, and
  expect faults that green typecheck + green unit tests do not catch.
- **Scallop-height → stepover** calculator, so the finish stepover is chosen by target
  cusp height rather than guessed. Vectric's stated rule of thumb — **8–12% of tool
  diameter for a 3D finish pass** — is the default to ship and the sanity check for the
  calculator's output.
- **Pencil finishing** (MeshCAM has it) — trace the concave corners to clear leftover
  stock the raster can't reach. On a heightfield these are the cells where the dilated
  field differs most from the raw field. Lower priority; list it so it isn't forgotten.
- **Cut-time estimate** for a relief, since 3D carves are long and users need to know
  before they start.

### Phase 3 — mesh section → 2D polylines

The honest, robust version of "pick operations on the STL": extraction the *user* directs,
not recognition.

- Slice the mesh at a chosen Z → closed loops → **real `PolylineEntity` objects in the
  sketch.** Then every existing 2D op works (pocket, profile, drill, dogbone, tabs) with
  no new op types, and the geometry is editable and constrainable — which is the point of
  this app.
- Offer the flat plateaus found by an area-vs-Z histogram as suggested slice heights.
- **Circle snapping on top**: fit a circle to each loop; if it fits within tolerance,
  offer "Ø6.34 — snap to 6.35?". This *fixes* the tessellation error instead of inheriting
  it. This is the only "feature detection" worth building, and it's ~20 lines on a loop.
- Precedent: Fusion's "create sketch from mesh section".

### Phase 4 — integration

- Silhouette (project all triangles to Z=0, union via Clipper2) → outer profile with tabs,
  so a relief can be cut out after carving.
- Boundary clamping: restrict a relief op to a drawn 2D loop instead of the image rect —
  kills air-cutting.
- Double-sided via `flip.ts`; rotary unwrap via `klein.ts`.

### Phase 5 — true waterline roughing (only on demand)

Phase 3's slicer is most of what this needs: slice loops → offset by `stockToLeave` →
feed `clearing.ts` / `adaptive.ts`. Cheap *if* Phase 3 exists, which is the argument for
that ordering.

## Testing notes

- Characterisation tests on the relief path **before** touching it — it's shared with
  photo reliefs and the laser, and it currently has no STL-shaped coverage.
- Pair every negative assertion with a positive control.
- Rasterise generated output and look at it; 26 green tests can still draw the wrong shape.
- One `npm run validate` + one e2e per batch, not per file. Mutation-test per claim.
- `/run` the app after any parametric or wiring change.

## Open questions

1. **Reliefs or prismatic parts?** If it's signs/decorative/2.5D tops, Phase 1 is nearly
   the whole feature and Phase 3 is optional polish. If it's mechanical parts, Phase 3 is
   the real product and Phase 1 is just the preview.
2. **8-bit or 16-bit heightfields** — see the table above. Needs a real carve to settle.
3. **Can an STL coexist with 2D shapes in one project?** For RapidCAM this should be the
   natural behaviour (it's just an image entity), but it's worth confirming what Easel
   does — their support pages 403 automated fetches, so this needs a manual look.

## Sources

Heightfield school:

- [Vectric: Import a Component or 3D Model](https://docs.vectric.com/docs/V11.0/Aspire/ENU/Help/form/import-a-component-or-3d-model/index.html)
- [Vectric: 3D Finish Toolpath](https://docs.vectric.com/docs/V10.0/Aspire/ENU/Help/form/Finish%20Machining%20Toolpath/) — the 8–12% stepover figure
- [Blender CAM panel descriptions](https://github.com/vilemduha/blendercam/wiki/Blendercam-Panel-Descriptions) — exact vs non-exact mode, and why
- [Easel: 3D Carving Instructions](https://support.easel.com/hc/en-us/articles/10369535844243-3D-Carving-Instructions)
- [Easel: FAQs — 3D in Easel Pro](https://support.easel.com/hc/en-us/articles/10378619827219-FAQs-3D-in-Easel-Pro)
- [Inventables launches 3D in Easel Pro (Oct 2022)](https://www.globenewswire.com/news-release/2022/10/18/2536128/0/en/Inventables-Launches-3D-in-Easel-Pro.html)
- [Forum: adding an extra pass between roughing and detail](https://forum.easel.com/t/adding-an-extra-pass-between-roughing-and-detail-for-3d-projects/145715)
- [Forum: missing bits between roughing and finishing passes](https://discuss.inventables.com/t/missing-bits-between-roughing-and-finishing-passes-on-carvey/147648)

Direct-mesh school (the algorithmic canon):

- [opencamlib docs](https://opencamlib.readthedocs.io/en/stable/) and [operations](https://opencamlib.readthedocs.io/en/stable/operations.html) — drop-cutter, push-cutter/waterline, cutter models
- [MeshCAM: surface angle limits](https://www.grzsoftware.com/blog/surface-angle-limits/) — the steep/shallow split
- [MeshCAM: STL machining tutorial](https://www.grzsoftware.com/tut/stl/)
- [Kiri:Moto](https://grid.space/kiri/) — browser-based, open source
- [CNCCookbook: 3D milling toolpaths](https://www.cnccookbook.com/3d-cnc-milling-machining-cam-toolpaths/)
