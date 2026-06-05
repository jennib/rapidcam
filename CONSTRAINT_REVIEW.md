# Constraints System Review

I've reviewed the constraint system, entities, tools, and the solver. The recent 8 fixes (especially the `dof > 0 && newEqs > dof` redundancy fix and the `ctx.solve()` additions) look solid.

Here are 5 suggestions/potential issues found during the review that you might want to address next:

### 1. Polyline Segments Cannot Receive Line Constraints
Because a `PolylineEntity` is a single entity of type `"polyline"`, the selection system (`ents.filter((e) => e.type === "line")`) will not pick up its segments as lines.
* **Impact:** Users cannot apply `horizontal`, `vertical`, `parallel`, `perpendicular`, `collinear`, `equal`, `tangent`, or `angle` constraints to polyline segments. They can only constrain the vertices (e.g. `coincident`, `pointOnLine`).
* **Suggestion:** Either change `PolylineTool` to output individual `LineEntity` objects connected by coincident constraints, or upgrade the constraint selection logic and `constraints.ts` to allow addressing specific segments of a polyline (e.g., using a combination of `entityId` and `segmentIndex`).

### 2. Entity Duplication Drops Layer Assignment
In `src/model/entities.ts`, the `duplicate()` method on all entities correctly copies `.isConstruction` but forgets to copy `.layerId`.
* **Impact:** When an entity is duplicated, its clone is temporarily assigned to `"layer-0"`. Then `CADDocument.add()` forces it to the `activeLayerId`. The duplicated entity loses its original layer assignment.
* **Suggestion:** Add `e.layerId = this.layerId;` to the `duplicate()` method of every entity class.

### 3. Bezier Handles Don't Follow Endpoints on Drag
In `src/model/entities.ts`, `BezierEntity.dofsAffectedBy` uses the default implementation, which returns only the dragged point.
* **Impact:** When dragging an endpoint (`p0`), its control handle (`p1`) is anchored heavily by the solver in its absolute world position. This drastically warps the curve shape during the drag.
* **Suggestion:** When an endpoint is dragged, the adjacent control handle should ideally translate with it to preserve the curve's shape. You can update `BezierEntity.setPoint("p0", v)` to also translate `p1` by the same delta, and update `dofsAffectedBy("p0")` to include `"p1"` so the solver knows to un-anchor it.

### 4. Typed Arc Lengths Are Not Constrained
In `src/tools/arcTool.ts`, when a user types a specific length to finish an arc (`commitByLength`), that length is only used to set the initial `endAngle`.
* **Impact:** No dimension or constraint is added. If the arc is later involved in the constraint solver, the solver is free to change its length/sweep.
* **Suggestion:** When a user explicitly types a value in the value editor, automatically generate a driving `Dimension` (or constraint) locking that value, so their typed intent is preserved during future solves.

### 5. Tangency to Arcs Treats Them as Full Circles
In `src/model/constraints.ts`, the `tangent` constraint uses `circularTangencyResidual`.
* **Impact:** This computes tangency based solely on the center point and radius. It means an arc can be considered "tangent" to a line even if the point of tangency lies far outside the arc's actual start/end angular sweep.
* **Suggestion:** While this is standard behavior in many CAD kernels (tangent to the underlying geometric circle), it can confuse users. Similar to how you added the post-solve angle clamp for `pointOnArc`, you could add a clamp or a warning for tangency points that fall outside the arc's sweep.

---

## Resolution status (this session)

| # | Finding | Action |
|---|---------|--------|
| 1 | Polyline segments can't receive line constraints | **Skipped** — CAM uses PolylineEntity for closed profiles; converting to lines would break profiling. Documented as limitation. |
| 2 | duplicate() drops layerId | **Fixed** — added `e.layerId = this.layerId` to all 6 entity `duplicate()` methods |
| 3 | Bezier endpoint drag warps curve | **Fixed** — `setPoint("p0")` now translates `p1` by the same delta (and `"p3"` translates `p2`); the solver's post-seed anchor holds the handle in the correct relative offset |
| 4 | Typed arc length isn't constrained | **Fixed** — `arcTool.commitByLength` now adds a driving `arclength` dimension immediately after creating the arc |
| 5 | Tangent ignores arc sweep | **Not fixed** — standard CAD kernel behaviour; low priority, left as known limitation |
