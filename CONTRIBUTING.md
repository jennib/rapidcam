# Contributing to RapidCAM

Thanks for your interest in contributing! This document covers the development workflow, code conventions, and what kinds of contributions are most useful.

## Before you start

- Check the [open issues](../../issues) to see if your idea or bug is already being tracked.
- For larger features, open an issue first to discuss the approach before investing time in an implementation.
- Read the [architecture section of the README](README.md#architecture) to orient yourself.

## Licence

This project is licensed under **CC BY-NC-SA 4.0**. By submitting a pull request you agree that your contribution will be published under the same licence. Commercial use of this code without prior written agreement from the author is not permitted.

## Development setup

```bash
git clone https://github.com/your-org/rapidcam.git
cd rapidcam
npm install
npm run dev          # dev server at http://localhost:5173
npm run validate     # must pass before opening a PR
```

## Workflow

1. **Fork** the repository and create a branch from `main`:
   ```bash
   git checkout -b feat/my-feature
   ```
2. Make focused, minimal changes — one logical change per PR.
3. Run `npm run validate` and fix any failures.
4. Open a pull request against `main` with a clear title and description.

## Code conventions

### TypeScript

- Strict mode is enabled in `tsconfig.json` — no `any`, no unchecked indexing.
- Prefer `const`; use `let` only when mutation is genuinely needed.
- Keep functions small and single-purpose.
- No comments that explain *what* the code does (the code does that). Comments only for non-obvious *why*: hidden invariants, solver quirks, workarounds.

### Coordinate system

- All geometry is stored in **millimetres**, Y-up (standard mathematical convention).
- Screen-space conversion (Y-flip) happens only in `Viewport.worldToScreen()`.
- Never mix units inside model or solver code.

### Model layer (`src/model/`)

- Entity classes must not read from the DOM or canvas.
- `CADDocument` mutations must go through its public methods — callers are responsible for calling `pushHistory()` before a mutation and `emitChange()` after.
- `dofPoints()` / `dofScalars()` on every entity must stay consistent with `getPoint()` / `setPoint()` / `setScalar()` — the solver depends on this.

### Solver (`src/solver/`)

- Drag anchors are stronger than drag pins so non-dragged geometry stays put while constrained drags project the cursor target. Keep both weights below `1` so hard constraints always dominate.
- The `computeEntityDofStatus()` function must not modify entity state — it runs `evalR(x)` at the end to restore positions after the Jacobian perturbation.
- New constraint types must expose `constraintResiduals()` returning a flat `number[]`.

### Renderer (`src/view/renderer.ts`)

- The renderer must be **read-only** with respect to the document — it should never mutate entity state.
- All colour constants live in `src/view/colors.ts`; do not hard-code hex values in the renderer.

### Tools (`src/tools/`)

- Every tool implements the `Tool` interface from `tool.ts`.
- Tools receive a `ToolContext` for all document mutations, solving, and history — they must not import `App` directly.
- `getOverlay()` returns only transient preview data; it must be cheap and side-effect free.

## Adding a new drawing tool

1. Create `src/tools/myTool.ts` implementing `Tool`.
2. Add an SVG icon to `src/tools/icons.ts` (`wrap('<path .../>')`, 24×24 viewBox).
3. Register it in `App`'s `ToolManager` array in `src/app.ts`.
4. Optionally add a single-letter keyboard shortcut to the `SHORTCUTS` map in `src/app.ts`.

## Adding a new constraint type

1. Add the type to the `Constraint` union in `src/model/constraints.ts`.
2. Implement `constraintResiduals(c, geo)` for the new type.
3. Implement `constraintAnchors(c, geo)` so the renderer knows where to draw the badge.
4. Add the glyph character to `CONSTRAINT_GLYPH` map.
5. Wire it up in `src/ui/constraintBar.ts` so the user can apply it.

## Pull request checklist

- [ ] `npm run validate` passes with zero errors
- [ ] No `any` casts introduced
- [ ] No hard-coded pixel values or colour strings in source files
- [ ] No mutations of entity state inside the renderer
- [ ] New tools registered in `app.ts` and given an icon
- [ ] PR description explains *why* the change is needed, not just what it does

## Reporting bugs

Use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md). Include:
- Steps to reproduce
- Expected vs. actual behaviour
- Browser and OS version
- A minimal `.rapidcam` project file if the bug is geometry-specific
