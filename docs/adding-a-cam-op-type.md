# Adding a CAM operation type

**From adding `inlay` (the V-carve inlay)** — one op that posts two programs, the
pocket in board A and the mirrored plug in board B. An op type's fan-out is the
same defect class as a cutter shape (`adding-a-cutter-shape.md`), but the sites
differ. Most of them carry a `default`/fall-through that silently does nothing,
and a green typecheck + green unit suite catch none of the UI ones — every fault
is "the app says something untrue."

## The checklist

Each entry answers: *what does the app say that is false if this site is missed?*

1. `CAMOpType` union (`src/cam/types.ts`) — add the member; the `Record`-typed
   tables below fail to compile if you miss it.
2. `CAMOperation` fields + `DEFAULTS` (`types.ts`) — the op's own numeric fields.
3. `OpCombo` union (`src/ui/camBarHelpers.ts`) — the UI's combo name.
4. `isValidFor` (`camBarHelpers.ts`) — which entities the op accepts. A miss
   refuses every selection, so the op cannot be created.
5. `OP_TYPES` (`src/ui/camBar/opTypeInfo.ts`) — name/label/blurb/machines; the
   single table auto-naming and the dropdown read.
6. `opTypeDiagram.DRAW` (`opTypeDiagram.ts`) — total over `OpCombo`; the one
   site the compiler itself catches.
7. badge (`opItemBuilder.ts`) — the short code (`VCV`/`INL`/…).
8. Dialog state (`opDialogState.ts`) — `OpState` fields + the factory defaults.
9. Dialog commit (`opDialog.ts`) — the `combo → type` arm AND the field
   write-back (gated on `type === "…"`). A miss silently drops fields on Apply.
10. Dialog section (`sections/…Section.ts`) — the rows, wired into `opDialog.ts`
    (`build…Section` + `updateAllSections`).
11. `OP_PARAMS` (`src/model/variables.ts`) — a `flat("field", clamp)` entry per
    numeric field, or the ƒx binding is INERT (`test/cam-parametric.test.ts`).
12. Emit (`src/cam/gcode.ts`) — the `toolpathBody` branch + the `typeLabel`
    ternary (the `; ---` banner).
13. Preview (`src/cam/stockRasterizer.ts`) — the `rasterizeOp` branch; a miss
    shows a 3-D preview that disagrees with the program.
14. Two-programs-from-one-op (if the op posts more than one board) — a
    `generate…Programs` mirroring `generateFlipPrograms`, routed in BOTH
    `postPrograms.ts` (CLI/MCP) and `camExportService.ts` (the UI export path) —
    the two routing sites drift apart if only one is updated.

## The 4-step schema checklist (any new persisted field or enum)

`public/schema/rcam-v3.schema.json` (op `type` enum + the new fields — the op
object is `additionalProperties: false`, so a miss breaks save/reopen) +
`docs/rcam-format-v3.md` (op-table row) + `llms.txt` (auto-derived from those
two — no manual edit) + the kitchen-sink fixture (`test/rcam-schema.test.ts`),
which is the only thing that actually exercises the enum.

## The drift guards that catch the rest

`test/opTypeInfo.test.ts` (`ALL_COMBOS`), `test/camBarDialog.test.ts` (the
laser/mill list assertions), `test/camParamBounds.test.ts` (clamp vs schema
bounds), `test/cam-parametric.test.ts` (every dialog row backed by `OP_PARAMS`),
`test/opFieldsRoundtrip.test.ts` (fields survive save/load).

## Related

- `adding-a-cutter-shape.md` — the tool-type sibling (same defect, different
  fan-out; `toolType` is switched on at dozens of sites with a flat-disc default).
- `docs/relief-rough-finish-plan.md` — the "12-place op-type checklist" cited as
  the cost of a persisted-enum change.