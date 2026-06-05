# Constraints System Review

## Files reviewed
- `src/model/constraints.ts` — constraint types, residuals, anchors
- `src/solver/solver.ts` — Levenberg-Marquardt, DOF counting, drag pins
- `src/solver/linalg.ts` — Gaussian elimination
- `src/model/dimensions.ts` — dimension residuals
- `src/model/document.ts` — add/remove/prune constraints
- `src/model/entities.ts` — DOF points, snap points, getPoint/setPoint
- `src/ui/constraintBar.ts` — build + apply constraints, over-constraint check
- `src/tools/lineTool.ts` — autoJoin helper
- `src/tools/rectTool.ts` — internal corner coincidents + snap fix
- `src/tools/circleTool.ts` — center snap coincident
- `src/tools/arcTool.ts` — center/start/end snap coincidents
- `src/tools/polylineTool.ts` — vertex snap coincidents
- `src/tools/bezierTool.ts` — (no snap handling)

---

## Bugs found and status

### BUG 1 — FIXED (commit 73dc777)
**PointEntity.snapPoints() missing key**
`src/model/entities.ts:722` — snap returned no `key`, so snapping to the origin never
triggered autoJoin. Added `key: "p"` to match dofPoints().

### BUG 2 — FIXED (commit 8462e07)
**RectTool doesn't autoJoin snapped corners**
`src/tools/rectTool.ts` — saved cornerSnap on first click and added
`autoJoinCorner(snap0/snap1, c0/c1)` after the internal coincident chain.

### BUG 3 — FIXED (this session)
**CircleEntity.snapPoints() uses key `"center"` but DOF key is `"c"`**
`src/model/entities.ts:212`
Effect: any line/arc/polyline endpoint snapped to a circle's center creates a
dead coincident (readPoint("center") throws → residual [] → constraint ignored).
Fix: change `key: "center"` → `key: "c"` in CircleEntity.snapPoints().

### BUG 4 — FIXED (this session)
**circleTool.ts uses `key: "center"` for new circle's own center coincident**
`src/tools/circleTool.ts:33`
Effect: a circle drawn with its center snapped to an existing point gets a dead
coincident because the new entity's center DOF key is `"c"`, not `"center"`.
Fix: change `key: "center"` → `key: "c"`.

### BUG 5 — FIXED (this session)
**LineTool doesn't call ctx.solve() after creating line + coincidents**
`src/tools/lineTool.ts` — unlike arcTool/circleTool/rectTool, lineTool omits
ctx.solve(). DOF display stays stale after drawing a constrained line.
Fix: add `ctx.solve()` after the two autoJoin calls.

### BUG 6 — FIXED (this session)
**PolylineTool doesn't call ctx.solve() after finish()**
`src/tools/polylineTool.ts` — finish() adds coincident constraints but never solves.
Fix: add `ctx.solve()` at the end of finish() (after the for loop).

### BUG 7 — FIXED (this session)
**BezierTool has no snap/autoJoin at all**
`src/tools/bezierTool.ts` — e.snap is never read. Snapping p0 or p3 to an
existing point doesn't create a coincident.
Fix: save snaps for p0 and p3 clicks; call autoJoin(p0Snap, "p0") and
autoJoin(p3Snap, "p3") before ctx.solve() in the p2 commit phase.

### BUG 8 — FIXED (this session)
**constraintBar pre-check blocks redundant constraints on fully-constrained sketch**
`src/ui/constraintBar.ts:230` — check is `dof - newEqs < 0`. When DOF=0 (fully
constrained), ANY new constraint is rejected even if it's redundant. The post-check
(solver converge test) would correctly accept redundant constraints if the pre-check
were bypassed.
Fix: change condition to `dof > 0 && newEqs > dof` so DOF=0 falls through to the
solver-based post-check.

---

## Architecture notes (no bugs, just observations)

- `fixed` constraint removes DOFs from variables (no equation). `fixedPoint` pins
  with equations. Both work; they coexist fine.
- Arc start/end are derived scalar DOFs (`sa`, `ea`). Coincident on arc.start/end
  works because finite-diff Jacobian chains through setScalar/getPoint.
- `pointOnArc` only enforces radial distance; post-solve angle clamp handles the
  sweep. Consequence: if hard constraints force the point outside the sweep, the
  clamp breaks those constraints silently.
- `angle` constraint locks the signed angle from u1→u2. Solutions exist at α and
  α+π; LM damping keeps the solver near the initial value (correct branch).
- `line-distance` dimension uses midpoint projection; correct for parallel lines,
  approximate for non-parallel.
- Solver convergence threshold for reporting is 1e-4 mm (coarser than the 1e-6 mm
  iteration stopping criterion) — intentional, reasonable.
