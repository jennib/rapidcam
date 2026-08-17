# Relief roughing + finishing: one job, one stock model

Plan, not shipped code. Written 2026-08-17. Follows on from
[stl-relief-milling-plan.md](stl-relief-milling-plan.md), whose Phase 2 shipped the
rest pass *between two roughing ops* and left the finish pass untouched.

## How much of this to trust

The measurements in "The complaint, measured" are real — a throwaway probe against
`generateGCode` on a synthetic relief, run 2026-08-17, numbers quoted below. The
prior-art table is read from vendor documentation, cited. Everything under "The
system" is a design, and this project's relief plans have been **wrong three times
already** (see the sibling doc's own correction sections). Assume a fourth. The
places most likely to be wrong are flagged inline as ⚠️.

**Revised 2026-08-17 after review, and the review found the fourth.** Three of this
document's own claims were wrong and are corrected in place rather than quietly
edited out, because the reasoning that produced them will otherwise be produced
again:

1. **"Measure the fine-grid cost first; coarse+upsample is the fallback."** Backwards.
   The box-min early-out cannot fire for a flat end mill at all — see the mechanism
   under §1 — so the coarse path is the primary algorithm and the fine grid is out of
   scope. Cost of believing a doc comment's "short-circuits on flat ground" without
   checking which sense of "flat" it meant.
2. **"The contour half probably needs the stock floor too, same predicate."** No. A
   waterline is not a re-traced staircase. §2d.
3. **The empty-`priorOps` seed.** Not stated at all in the first draft, and it is the
   one line that decides whether the byte-identical guarantee holds or inverts. §1.

One review finding was itself wrong and is answered in §3: the preview and the
generator do **not** rasterise the relief on different grids — `reliefSpacing` is
shared and exists for that reason.

---

## The complaint

> The G-code generator does not take into account material removed by the roughing
> pass when creating G-code for the engraving task. Also having the two dialogs is
> confusing to the user.

Both are true, and they are the same defect seen from two ends. The finish pass and
the roughing pass are two operations that describe **one surface**, and nothing in
the system makes them agree — not the numbers the user types, and not the material
the machine has actually removed.

## The complaint, measured

Probe: 60×60 mm relief, 20 mm deep — a dome with two 5 mm channels. Roughed with a
⌀12 flat end mill, 3 mm stepdown, 0.5 mm allowance. Finished with a ⌀3 ball nose at
0.3 mm rows. Only the finish program is measured, classified against the surface the
roughing pass actually leaves.

**Ends of the same stick — pick your poison:**

| finish `stepdown` | feed distance | above the roughed floor | time at F2000 |
|---|---|---|---|
| 20 mm (one pass) | 36 m | 4.6 m (12.8%) | ~18 min |
| 5 mm | 144 m | 73.5 m (51.0%) | ~72 min |
| 2 mm | 360 m | 212.1 m (58.9%) | ~180 min |
| 1 mm | 720 m | 448.5 m (**62.3%**) | ~360 min |

At 1 mm stepdown the finish pass spends **3¾ hours cutting air the roughing pass
already removed**. The staircase is computed from `maxDepth`, not from what is left:

```ts
const passes = Math.max(1, Math.ceil(maxDepth / stepdown));   // gcode.ts:1298
```

and the only skip rule compares against the finish's *own* previous reach, never
against the roughing floor:

```ts
const prevReach = (p - 1) * stepdown;
const needsPass = (r) => p === 1 || rows[r].levels.some((lv) => lv * maxDepth > prevReach);
```

So the user sets a large stepdown instead. Then the other end bites:

```
single-pass finish: axial engagement over 36.0 m of feed
  air:                            4.62 m (12.8%)
  <=0.5mm (as roughed):          16.91 m (47.0%)
  0.5-2.5mm (rough staircase):   10.23 m (28.4%)
  2.5-5mm:                        2.39 m (6.6%)
  5-10mm:                         0.12 m (0.3%)
  OVER 10mm:                      1.73 m (4.8%)
  DEEPEST bite: 17.0 mm with a d3 ball nose
  lines in the finish program mentioning roughing/rest/allowance: 0
```

**17 mm of axial engagement on a ⌀3 ball nose**, over 1.73 m of travel — in the
channels the ⌀12 could not enter. Per cell: 11.9% of the relief holds more stock
than roughing promised. The program says nothing about it. This is the standing
complaint the sibling plan already cites from Easel's forum, and it is how finishing
cutters get snapped.

There is no setting that avoids both columns. The user's only knob is a global
`stepdown`, and the quantity it should respond to — **how much stock is actually in
front of the cutter** — is never computed.

### The preview looks correct while this happens

`stockRasterizer.ts` walks every op in order and stamps into one height field, so
the 3-D preview shows the correct finished part either way. It cannot show four
hours of air or a 17 mm bite. The one place that models in-process stock is the
place that does not feed the generator.

## The second half: two ops, one job, typed twice

The roughing op is `type: "relief-rough"`. The finish op is `type: "engrave"` — the
same type as scribing a line at fixed depth, which happens to carve a relief when
pointed at an image. Nothing in the op list, the type dropdown, or a saved `.rcam`
says these two belong together.

Six values must match across the pair or the allowance is not uniform: **depth,
invert, gamma, flip, and the image itself**. Three can no longer drift (flip comes
from the entity, gamma is pinned for an STL by `reliefEncodingFor`). The rest are
typed twice and guarded after the fact by `checkReliefPassMismatch` in `lint.ts`,
whose doc comment names the reason exactly:

> Which is one fact stored in two places, and this project's standing defect class.

`restToolDiameter` is a third hand-typed copy — the *previous* op's diameter, retyped
into this one — and `checkRestToolMismatch` exists solely to catch it going stale.

Two lints exist because the pairing is a convention rather than a mechanism.

## Prior art — what the field actually does

| | rough & finish | does the finish know what roughing left? |
|---|---|---|
| **Vectric Aspire** | two separate forms | **No.** The finish "is always a single pass, and does not use the tool's pass depth". No rest option. The manual just warns: "ensure your Roughing Toolpath's Machining Allowance is set appropriately for the tool used in Finishing to avoid damaging the bit." |
| **Fusion 360** | separate ops | **Yes.** Every 3-D op has a Rest Machining section — "from previous operation(s)" — and in-process stock is tracked across the setup. |
| **MeshCAM** | **one dialog** holding both, each with an enable checkbox | Yes — its surface-angle split decides per area which strategy cuts it |
| **Easel Pro 3-D** | **one carve**: "you select the bits you will use for the roughing pass and finishing pass" | Yes — the detail bit "only carves sections of the design that require a narrower bit diameter" |

Two conclusions, and they point the same way:

1. **For this tier the convention is one job that owns both passes** (Easel Pro,
   MeshCAM). Vectric is the outlier, and Vectric's forum is where the sibling plan
   already sourced *"missing bits between roughing and finishing passes"*.
2. **A relief finish is conventionally a single pass.** Vectric states it as a rule.
   That is only safe because a rest-aware or well-set-up job leaves ≤ the allowance
   everywhere. RapidCAM has a `stepdown` on the finish precisely because it *isn't*
   safe — the stepdown is a workaround for the missing stock model, and it is the
   workaround that costs 3¾ hours.

---

## The system

### 1. `reliefStockFloor()` — the in-process surface, in the relief's own grid

One function. Given the field a relief op is about to cut and the operations ahead
of it in the job, return the Z the material surface now sits at, per cell.

```ts
/** The surface the ops ahead of `op` have already left on this image. */
export function reliefStockFloor(
  field: RasterField,
  priorOps: CAMOperation[],   // same image, earlier in doc.operations
  maxDepth: number,
): RasterField
```

This is a **generalisation of `reliefRest`, not a new mechanism.** `rest.ts` already
computes what one named prior tool left, and `toolProfile.toolSweptFloor` is already
the vetted way to get it:

```
floor = (Z ⊖ tool) ⊕ tool      // the greyscale OPENING
```

⚠️ **This must stay the opening, never the tip field.** That is the finding
[relief-rest-and-steep-shallow] paid for: a tip-field difference invents a
tool-radius band of standing stock along every wall (48.6% on a model with nothing
to do) *and* misses real stock beside narrow features (11.1% where the truth is
55.6%) — wrong in both directions, median 2.6× the area over 220 objects. Do not
re-derive this.

The one thing `reliefStockFloor` adds over `reliefRest`: a `relief-rough` op leaves a
**staircase**, not its target surface. It cuts flat planes at `−p·stepdown` clamped
to `−(maxDepth − allowance)`, so the floor at a cell is the deepest plane in that
sequence still at or above the swept floor. The probe's classifier does exactly this
in ~6 lines; it belongs in the function, not in the caller.

Prior ops come from **job order** — every op earlier in `doc.operations` that targets
this image — which is Fusion's rule and needs no new persisted field. `restToolDiameter`
becomes a derived value, and can be demoted to an override that a hand-written `.rcam`
may still set.

⚠️ **With no prior ops the floor is the uncut blank — level 0 everywhere — not the
target field.** This is the easiest thing here to get backwards, and getting it
backwards inverts the guarantee Phase 1 rests on: a floor seeded from the *target*
gives `maxRemaining = 0` for a lone relief op, collapsing every existing single-op
relief to one pass. Seed at the stock top and let each prior op *deepen* it. This is a
requirement with a test, not a comment: `reliefStockFloor(field, [], maxDepth)`
returns all zeroes, and a lone relief op posts byte-identical G-code to today.

#### Compute it on the COARSE grid and upsample. This is the primary algorithm, not a fallback.

An earlier draft of this plan called fine-grid `toolSweptFloor` the default and the
coarse path a fallback "if it is too slow", on the strength of `dilate`'s doc comment
saying the box-min bound "short-circuits on flat ground". **That reassurance does not
apply to this case, and the reasoning inverts.** Measured 2026-08-17:

| field | cells | `toolSweptFloor`, ⌀12 flat |
|---|---|---|
| 300 mm @ 0.3 mm | 1.0M | 6.8 s |
| 100 mm @ 0.1 mm | 1.0M | 22.7 s |
| 300 mm @ 0.1 mm | 9.0M | **234 s** |
| 300 mm @ 0.1 mm, flat ground | 9.0M | 0.71 s |

The mechanism is what matters, because it is stable under any future tuning. The
early-out in `sweep` is `if (best <= bm + pen[base]) break` — it can only fire early
when the footprint penalty `pen` is positive, i.e. **when the tool has a flank**. A
flat end mill's profile is `height: (d) => (d > R ? Infinity : 0)`, so `pen = 0`
across its whole footprint and the test degenerates to `best <= bm`: the sweep runs
until it finds the true box minimum, which on a smooth surface sits at the far edge
of the footprint. "Flat ground" in that comment means *locally flat*, and a relief is
the opposite. `scripts/relief-dilation-cost.ts` shows the same inversion from the
other side — smooth "photo" fields are its *slowest* case, hard-edged "logo"/"noise"
fields 3–8× faster. The roughing grid has been hiding all of this: at a 4.8 mm pitch
the ⌀12 footprint is about one cell.

So the coarse path is the design, and its safety argument is stronger than "carries no
information below the rough grid pitch". The roughing floor is **staircase-quantised**
(its values come only from the `−p·stepdown` ladder) *and* **opening-smoothed by the
rough tool radius**, so it is piecewise-constant on the coarse grid. Nearest-neighbour
upsampling taking the **highest (least-removed)** neighbour is therefore *exact*
except at staircase edges, and at those edges it over-states the remaining stock —
the finish cuts a little extra air along a wall, and never under-cuts. Conservative
by construction.

### 2. The finish pass consumes it

Two changes in `reliefImage` (`gcode.ts:1261`):

**a. Skip cells with nothing in front of them.** `needsPass(r)` becomes a per-cell
test — nothing to cut where `passFloor >= stockFloor(r,c)`. The machinery for a
broken snake already exists: the steep/shallow split taught `vertsFor` to return a
*list* of runs and split wherever a cell is skipped, precisely so the tool doesn't
feed across a gap. A skipped-because-already-cleared cell breaks the run identically.

**b. Size the staircase to the stock, not to the model.**
`passes = ceil(maxRemaining / stepdown)` rather than `ceil(maxDepth / stepdown)`,
where `maxRemaining = max(stockFloor − target)` over the cells this op will cut —
**the raster's own cells, excluding the steep ones**. The raster already skips steep
cells via `steep.steep(r, c)`; letting them into the max would let one 17 mm channel
that only the contours ever visit multiply the pass count for a raster that never
goes near it.

Together these reinterpret `stepdown` from *a global Z schedule* into *a cap on
axial engagement* — which is what a user setting it always meant. When roughing did
its job, `maxRemaining ≈ allowance` and the result is Vectric's single pass, for
free and without asserting it. Where roughing never reached, the tool steps down
into the pocket instead of taking 17 mm in one bite. On the probe's numbers that is
~720 m → ~255 m of feed, and the deepest bite bounded by the stepdown the user chose.

**c. State it in the program header**, next to the existing cusp and steep/shallow
readouts, in the same voice:

```
; after "Rough 1" (⌀12 flat, 3mm steps, 0.5mm allowance): 88.1% of this relief holds
;   ≤0.5mm, 11.9% holds more — deepest 17.0mm, taken in 17 passes of 1mm
```

That line is the whole feature, visible before the machine moves.

**d. The contour half needs none of this.** An earlier draft guessed "probably yes,
same predicate". It is *no*, and the code settles it. The raster's air problem is
specific to a **re-traced staircase**: passes 2…N re-walk ground pass 1 already
reached. A contour pass is a waterline, not a depth schedule — `steep.ts:178` emits
one ring per level `−k·zStep` for `k = 1…⌊maxDepth/zStep⌋`, each ring distinct and
never re-traced. Every ring rides the contact field, so its points sit on the target
surface; the rough floor is everywhere at or above `target + allowance`, because
roughing never cuts below the target. So no contour point is ever above the roughed
floor, and there is no air for a predicate to skip. Its axial engagement is capped by
`zStep = rowPitch` independently of the raster's `stepdown`, so it does not share the
"17 mm in one bite" hazard either. **This shrinks Phase 1: the stock floor and the
skip predicate are raster-half-only.**

### 3. The preview must not diverge

`stockRasterizer.rasRelief` mirrors `reliefImage`'s path construction, and its own
header says a preview that disagrees with the program is the bug that file exists to
catch. The skip test must therefore be **one shared predicate** called by both, not
the same rule written twice — the defect class this whole document is about.

One thing not to get wrong here, because it looks like a divergence risk and is the
reverse: **the two already share the relief grid.** `rasRelief` builds its field from
`reliefSpacing(op)` — the emitter's own resolver, chosen for exactly this reason
("so the preview shows the depths the program will command") — then applies the same
`toolContactField` and the same `steepSplit`. The adaptive, memory-budgeted `RES` in
that file is the **stock height map** `stamp()` writes into, not the relief field. So
the floor builder takes a field and returns the same floor for both callers by
construction. Do not "fix" this by having each consumer derive its own floor on its
own grid; that would reintroduce precisely the divergence `reliefSpacing` exists to
prevent.

### 4. Lints change meaning

- `rest-tool-mismatch` — its cause is removed once the diameter is derived. Keep it
  scoped to a hand-authored override.
- `relief-pass-mismatch` — cannot fire from the UI once the two stages share one set
  of fields, but a hand-written or AI-generated `.rcam` can still produce it. Keep,
  and keep the positive control.
- **New:** the pre-flight linter should warn on the thing the probe measured —
  *"the finish pass takes up to 17 mm of axial engagement with a ⌀3 ball nose over
  1.7 m of travel; add a rest pass with a smaller roughing tool, or reduce the finish
  stepdown."* This is the Apollo linter's job and it currently has nothing to say
  about it.

---

## The UI

`opDialog` is already one dialog whose rows switch on op type; the confusion is not
that there are two dialog *files*, it is that **one job is presented as two unrelated
op types, one of which is called "Engrave".**

### The shape: one "3-D Relief" entry, two stages in one form

Replace the two dropdown entries — `Relief Roughing (image)` and the image-flavoured
half of `Engrave` — with a single **"3-D Relief (image)"** type. The dialog then reads:

```
Name        [ 3D Relief 1                  ]
Type        [ 3D Relief (image)         ▾  ]
            <diagram>  Carves a greyscale image or STL heightfield as a 3-D
                       surface. Clears the bulk with a big tool first, then
                       finishes with a ball nose.

── The model ──────────────────────────────   (shared — typed ONCE)
Depth              [ 20.0 ] mm
Invert                 [ ]
Tone curve (gamma) [ 1.0  ]

── Roughing ──────────────────────  [x] include
Tool         [ ⌀12 flat end mill      ▾ ]
Stepdown     [ 3.0 ] mm    Stepover [ 40 ] %
Leave        [ 0.5 ] mm for the finish pass

── Finishing ─────────────────────────────
Tool         [ ⌀3 ball nose           ▾ ]
Rows         [ 0.30 ] mm   → 0.008mm cusp
Max bite     [ 1.0 ] mm    (was "stepdown")
[x] Contour the steep areas
```

Three things that matter about this layout:

- **The shared block is the drift fix, made visible.** Depth/invert/gamma appear once
  because there is one model. `checkReliefPassMismatch` becomes unreachable from the
  UI by construction rather than by warning.
- **No "previous tool diameter" field anywhere.** It is derived. The field that
  existed only to be retyped and go stale is gone.
- **Compact and native**, per [cam-op-type-ui] — collapsible sections in the existing
  form, explanation beside the control. Not a wizard, not a card grid.

### It still writes two operations

⚠️ **Do not merge them into one op.** `op = tool`: `gcode.ts` emits `T… M6` or a
manual-tool-change pause whenever `op.toolNumber` changes between ops, and per-op
export, per-op time estimates, drag-reordering and the preview's per-op stamping all
assume it. Two tools is a real fact about the machine and the op list should keep
saying so.

So the dialog writes a **pair**, and the CAM list shows them as one job:

```
▾ 3D Relief 1                                    48 min
    Roughing    ⌀12 flat end mill                12 min
    Finishing   ⌀3 ball nose                     36 min
```

Editing either row opens the one dialog. Deleting the job deletes both; deleting just
the roughing row is allowed and the finish pass recomputes — that is the point of
deriving the stock floor from job order rather than from a link.

Precedent exists for a dialog that writes several ops: `toolpathsFromLayersWorkflow`
already replaces the whole operation list in one action.

### Grouping is derived, not persisted

Same rule as the stock model: ops targeting the same image, adjacent in job order,
one rough + one finish. `checkReliefPassMismatch` already pairs by shared
`entityIds`. **No schema change**, and a hand-written `.rcam` that lists them
separately still groups correctly on load.

---

## Phases

Each ships on its own and is independently useful.

### Phase 1 — the stock model (the actual bug) — no schema change

`reliefStockFloor()` on the coarse grid with a conservative upsample, the two changes
in `reliefImage`'s raster half, the shared skip predicate for the preview, the header
line, the new engagement lint. Ship the naming and the UI untouched. The gating cost
question is **answered, not open** — see the table above — so the coarse path is in
scope from the start and fine-grid `toolSweptFloor` is out of it.

Add a `toolSweptFloor`-on-a-dome row to `scripts/relief-dilation-cost.ts`. The
330× spread between the flat-ground and smooth-dome cases is the kind of thing a
committed probe should pin, and that file already exists to pin the rest of it.

Verification, per the standing discipline: rasterise the emitted path and *look* at
it; a corpus sweep of before/after feed distance and max engagement; a positive
control that a finish with no roughing op ahead of it emits byte-identical G-code to
today. That last one is the assertion that matters — the change must be a no-op for
every existing single-op relief.

### Phase 2 — the UI pair — no schema change

The merged dialog, the shared-model block, the grouped op list, derived pairing,
`restToolDiameter` demoted to an override. `e2e/unreachable-controls.e2e.ts` after,
because happy-dom cannot see layout.

### Phase 3 — the name — schema bump

`type: "engrave"` on an image becomes `type: "relief"`. This is the persisted-enum
change and it costs the most for the least: the 12-place op-type checklist, a schema
version bump with auto-upgrade (v1→v2 set the precedent), format doc, `llms.txt`,
kitchen-sink. Worth doing *after* Phases 1–2 prove the shape, and worth doing at all
only because leaving it means the op list, export filenames, G-code headers and lint
messages all keep calling the 3-D finish pass "Engrave".

## Open questions

Two of the three this document opened are now closed and have moved into the design
above: the fine-grid cost (measured — coarse+upsample is the algorithm) and the
contour half (no — it is a waterline, not a staircase).

1. **A third op in the chain is not free, and the non-free piece is the rest mask.**
   A second *finishing* tool is the easy case, since a finish op cuts to target
   everywhere it runs, so its floor is just its own swept floor. A `rough → rest →
   finish` chain is not: `reliefRest` returns a `kind: "mask"` and `reliefRoughImage`
   only emits inside it, so `reliefStockFloor` must apply a rest op's floor **only
   within that mask** rather than taking a plain min of swept floors. That is real
   plumbing. Don't design anything in Phase 1 that forecloses threading the mask
   through, and don't cost pencil finishing as free.

## Sources

- [Vectric: 3D Finish Toolpath](https://docs.vectric.com/docs/V10.0/Aspire/ENU/Help/form/Finish%20Machining%20Toolpath/) — "always a single pass, and it does not use the tool's pass depth"
- [Vectric: 3D Rough Toolpath](https://docs.vectric.com/docs/V10.0/Aspire/ENU/Help/form/Rough%20Machining%20Toolpath/) — Machining Allowance
- [Fusion 360: Rest machining](https://help.autodesk.com/view/fusion360/ENU/?guid=GUIDFC1FB07B-9585-4BDF-87E7-7553D2A1D8CF) and [between setups](https://help.autodesk.com/view/fusion360/ENU/?guid=MFG-REST-MACHINING-SETUP-STOCK-TRANSFER)
- [MeshCAM: surface angle limits](https://www.grzsoftware.com/blog/surface-angle-limits/)
- [Easel: 3D Carving Instructions](https://support.easel.com/hc/en-us/articles/10369535844243-3D-Carving-Instructions), [Two-Stage Carves](https://support.easel.com/hc/en-us/articles/360012453174-Two-Stage-Carves-Roughing-and-Detail-Carves)
