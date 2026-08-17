# Adding a cutter shape (tool type)

**From adding `tapered-ball-nose`** — a cone with a spherical tip, opencamlib's
`CompositeCutter`. Unlike an op type, the *geometry* is nearly free:
`src/cam/toolProfile.ts` owns every flank law in one place (`ballHeight`/`coneHeight`,
switched in `toolProfile()`), and its three consumers — the gouge correction
(`toolContactField`), the 3-D preview stamps (`stockRasterizer`), and the
scallop→stepover calculator (`scallop.ts`) — read that one law. The risk is the fan-out:
`toolType` is switched on at dozens of sites across ~20 files, and **most of them carry a
`default`/fall-through that silently draws a flat end mill.** A green typecheck and a
green unit suite catch none of the UI ones — every fault is "the app says something
untrue." (The two entries marked ⚠️ below were caught *during* this work, both invisible
to the unit suite.)

## The checklist

Each entry answers: *what does the app say that is false if this site is missed?*

1. `ToolType` union (`src/cam/types.ts`) — one place typecheck genuinely helps: add the
   member or the `Record<ToolType,string>` below fails to compile.
2. `TOOL_TYPE_LABELS` (`types.ts`) — the label string is what every picker, list row and
   dialog shows; compile-checked, so a formality, but pick a name users recognise.
3. schema `toolType` enum, **twice** (`public/schema/rcam-v3.schema.json`, op + tool) —
   skip either and **the app can emit a file its own validator rejects on reopen**, and an
   AI-authored file carrying the new type fails to load.
4. `toolProfile()` switch (`src/cam/toolProfile.ts`) — the `default` is a **flat disc**.
   Skip it and **the gouge correction treats the new bit as a flat end mill, so it ploughs
   through steep walls** (the 2.9 mm-gouge class) while posting clean G-code. The worst
   fault: silent, and nothing downstream can see it.
5. relief-engrave gate (`src/cam/gcode.ts`, `!== ball-nose && !== v-bit`) — skip it and
   **a relief finish with the new bit is skipped with a NOTE claiming it's a flat tool**
   ("leaves blocky dots"), i.e. the program refuses a cutter that is perfectly fine.
6. halftone gate — **deliberately leave it V-bit-only.** A ball-tip cone has no V-groove
   width law; adding it here would carve a halftone with no screen to derive.
7. finish/roughing NOTE comments (`gcode.ts`) — skip and **the posted comment names the
   wrong cutter** ("roughing with a ball-nose works but is slow"). Knowingly untested: it's
   advisory prose, not behaviour — a miss here loses a hint, not a part — so no test pins the
   wording.
8. chamfer/vcarve gates (`gcode.ts`) — **deliberately leave V-bit-only**; the bevel/vcarve
   slope comes from the V, and a ball-tip cone isn't one.
9. header tool summary + per-op `; ---` label (`gcode.ts`) — skip and **the G-code header
   and every op banner name a different cutter than the one loaded** (both read "EndMill").
10. relief gate (`src/cam/stockRasterizer.ts:324`) — skip and **the 3-D preview shows
    nothing for a relief the G-code does cut** — the preview disagrees with the program.
11. `makeStampFn` (`stockRasterizer.ts`) — the fall-through draws a **flat disc**. Skip and
    **the preview shows flat-bottomed grooves where the real cut is a ball-tip cone.** Add
    the stamp by importing the same flank law — never a second copy.
12. `effectiveToolR` (`stockRasterizer.ts`) — verify the stamp stepping; a wrong value is
    only a denser/sparser preview, not a lie.
13. `buildToolDiagram` switch (`src/ui/toolDiagram.ts`) — the `default` draws an end mill.
    Skip and **the tool library shows an end-mill cross-section for the new bit** — the
    exact `diameter`-vs-`tipDiameter` confusion the diagram exists to prevent.
14. `opItemBuilder.ts` tool label — skip and **the ops list reads "End Mill"** for the new
    tool.
15. `opDialog.ts` field gating — skip and **the tip geometry the user typed is silently
    dropped on Apply** (the op saves without `tipDiameter`, reverting to the sharp default).
16. `opDialogState.ts` fields + defaults — skip and **a fresh op has no ball tip, so the
    new type defaults to a sharp cone — i.e. a v-bit** (the wrong shape, silently).
17. `toolSection.ts` field visibility + save-to-library — skip and **the Ball-Tip field
    never appears**, or save-to-library drops it.
18. `cutSection.ts` relief-finish coercion (`!== ball-nose && !== v-bit` → force ball-nose)
    — skip and **picking the new bit for a relief is silently switched back to ball-nose**:
    the coercion "helps" by un-doing the user's explicit choice.
19. `cutSection.ts` relief-rough coercion — add the new type to the force-to-end-mill (it's
    a finish tool); skip and it's left on a roughing pass it shouldn't run.
20. `toolLibraryDialog.ts` conditional geometry fields — skip and **the library editor shows
    no taper/ball-tip fields**, so a library tool can't carry the geometry.
21. `aiPrompt.ts` `describeTools` — skip and **the AI-facing prompt describes the tool
    without its taper or ball**, so an AI authors the wrong geometry.
22. `flip.ts` `validateFlip` — skip and **the pin-hole warning doesn't fire when the last
    top op is the new bit**, so pins get bored with a ball tip (ragged holes).
23. `toolLibrary.ts` preset — optional, but skip and the type is undiscoverable from the
    seeded library.
24. `OP_PARAMS` (`src/model/variables.ts`) — **a `paramRow` key must exist here or the ƒx
    binding is inert.** ⚠️ Hit this for `tipDiameter`; `test/cam-parametric.test.ts` is
    the guard.
25. `docs/rcam-format-v3.md` — skip and **the published guide still names fewer tool
    types**, so external authors/AIs can't express the new one (or emit files the schema
    rejects).
26. kitchen-sink doc (`test/rcam-schema.test.ts`) — skip and **the schema enum is never
    exercised**; the drift guard can't see it.

## Composite-cutter specifics (what was unique to this shape)

- **One geometry file.** The flank law lives ONLY in `toolProfile.ts`: a tapered ball-nose
  is `ballHeight` (the ball tip) joined to `coneHeight` (the cone) at the offset `r·cos(α)`
  where the cone is tangent to the ball. `reach()` inverts it for the dilation footprint
  and the stepover calculator — no second law anywhere.
- **The tangency invariant is the whole point.** At the join the ball and cone must agree
  in VALUE **and** SLOPE (`cot α = 1/tan α` on both sides); a kink describes a lip the tool
  doesn't have. It is the one assertion a wrong implementation can't satisfy — guard it
  with a test, not a comment.
- **Reuse fields, don't add them.** `diameter` = major (widest), `vAngle` = the included
  taper angle, `tipDiameter` = the narrow end (a ball here, a flat on a V-bit). The trap:
  ⚠️ `tipDiameter` now means two things, so `DEFAULTS.tipDiameter` must stay **0** (the
  sharp/no-tip neutral) — set it to a "sensible ball" like 1 and a sharp V-bit's halftone
  and cusp readouts silently read as having a 1 mm flat. Seed the ball tip on switching TO
  the new type, never in the shared default.
- **`cuspReadout` quotes the tip, not the body.** Its 8–12% band and suggested stepover use
  `diameter`; for a tapered bit the cusp is carved by the ball tip, so quoting the major
  suggests a stepover that leaves a huge ridge on the small tip — silently the wrong stepover.

## Related

- The op-type sibling (same defect class, different fan-out): "adding-a-cam-op-type".
- Duplicated-table drift — for ops the live instance was the auto-name table; for tools the
  equivalent is the tool-label ternary written four times (`gcode.ts` header + banner,
  `opItemBuilder.ts`, `TOOL_TYPE_LABELS`).
- dom-tests-cannot-see-layout — a new dialog row can be laid out past a container edge;
  only `e2e/unreachable-controls.e2e.ts` (or a screenshot) sees it.
- a-test-drove-a-control-the-app-was-right-to-hide — the Add-Toolpath case timed out:
  `crowdTheLayersPanel()` switches the document to a LASER, and a laser has no cutter, so the
  tool-type select is correctly hidden — the test asked a laser to pick a milling tool. Product
  right, test wrong (recorded at `e2e/unreachable-controls.e2e.ts`); it only surfaced late
  because `npm run validate` does not run Playwright.
- a-long-running-process-held-stale-modules — `post_gcode`/`render_preview` reported the tool
  as "End Mill" (the pre-change label), and it was diagnosed as "the MCP tools run a separate
  reference build". They don't: `mcp/server.ts` → `cli/core` → `src/cam/gcode` is the same
  source — a long-running server process was holding the modules it loaded before the change.
  It could not be settled because no test read the emitted G-code; `test/taperedBallNoseGcode.test.ts`
  now reads it, so the next unexpected output is a failing assertion, not a judgement call.
