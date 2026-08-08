/**
 * Constraint-solve orchestration: the sequence that turns a document edit into
 * settled geometry, a status verdict, and a repaint.
 *
 * Lifted out of `App` so it can be exercised without a DOM or a canvas. That is
 * the whole point of it being a separate object: this wiring — "a variable
 * changed, so re-evaluate, solve, regenerate what went stale, solve again" — is
 * where a real bug hid behind a fully green suite. Changing stock thickness did
 * not re-drive anything bound to `stock`, and no unit test could see it because
 * the only path through the sequence ran inside a class that needed a browser to
 * construct.
 *
 * The UI is reached through {@link SolveSinks} rather than concrete widgets, so
 * a test can pass plain recording functions. Note the shape of the interface:
 * it is grouped by *fact published*, not by widget. `publishSolveStatus` feeds
 * the status bar and the design tree from one call deliberately — see its doc.
 */

import { track } from "../analytics";
import { regenerateStaleFeatures } from "../generators/index";
import type { CADDocument } from "../model/document";
import { regenerateAllStalePatterns, regenerateStalePatterns } from "../model/patternEngine";
import { computeSourceSnapshot } from "../model/patterns";
import { evaluateAll } from "../model/variables";
import {
  computeEntityDofStatus,
  type EntityStatusMap,
  type PinMap,
  type SolveResult,
  solve,
  solveConverged,
  solveFailureEvent,
} from "../solver/solver";

/**
 * Everything the coordinator pushes outward. Implemented by the App shell over
 * the renderer / status bar / design tree; implemented by a test over arrays.
 */
export interface SolveSinks {
  /**
   * Per-entity DOF status — drives both the geometry colour and the design
   * tree's badges. One call, so the two cannot disagree about an entity.
   */
  publishEntityStatus(status: EntityStatusMap): void;

  /**
   * The solve verdict, with whether anything ACTUALLY drawn is under-defined.
   *
   * One call feeds the status bar and the design tree's Constraints folder from
   * the same inputs. They must never render their own reading of the result, or
   * the two can contradict each other on screen.
   *
   * `anyUnderDefined` exists because a feature-only sketch (controlled geometry,
   * free solver DOF but nothing loose) should read "Fully constrained" instead
   * of contradicting its own layer-coloured parts. Definedness is reported even
   * for a drag solve: a fresh, unconstrained sketch reads "under-constrained"
   * and draws blue, per the SolidWorks model, and the status bar has to agree
   * with the geometry colour.
   *
   * Publishing unconditionally is safe because `solveStatusLabel` blanks an
   * empty canvas — it returns null when there are no solver variables. Note the
   * corollary, which is sharper than it looks: geometry pinned by a `fixed`
   * constraint contributes NO variables, so a sketch of nothing but fixed
   * geometry also reads blank, not "Fully constrained". Any test asserting the
   * bar does not say something will pass vacuously on such a document.
   */
  publishSolveStatus(res: SolveResult | null, anyUnderDefined: boolean): void;

  /**
   * Which pattern instances are stale (their source moved) and how many patterns
   * that is. The ids grey the instances; the count drives the status-bar prompt.
   */
  publishPatternStaleness(staleEntityIds: Set<string>, staleCount: number): void;

  requestRender(): void;

  /** Open a history entry, so a regeneration is undoable as one step. */
  pushHistory(): void;
}

export class SolveCoordinator {
  private lastResult: SolveResult | null = null;
  private stalePatternIds: Set<string> = new Set();

  /**
   * Entity DOF status from the last COMMITTED solve. Cached rather than derived
   * on demand because a drag deliberately reuses it: recomputing per frame would
   * both cost time on the hot path and answer against half-dragged geometry.
   */
  private lastStatus: EntityStatusMap = new Map();

  /** Whether the last committed solve converged, so only the TRANSITION is reported. */
  private lastConverged = true;

  private autoRegenerating = false;

  /**
   * The document is captured once and never reassigned — `App` builds one
   * `CADDocument` and every load mutates it in place via `restore()`/`clear()`,
   * so holding the reference here cannot go stale.
   */
  constructor(
    private readonly doc: CADDocument,
    private readonly sinks: SolveSinks,
  ) {}

  /** Latest committed solve result, or null before the first solve. */
  get result(): SolveResult | null {
    return this.lastResult;
  }

  /** Remaining degrees of freedom; `Infinity` until the first solve lands. */
  get dof(): number {
    if (!this.lastResult) return Infinity;
    return this.lastResult.variables - this.lastResult.equations;
  }

  /** How many patterns are currently stale. */
  get staleCount(): number {
    return this.stalePatternIds.size;
  }

  /**
   * Evaluate variables and settle the geometry.
   *
   * A drag passes `pins`, and a pinned solve is explicitly NOT committed: it
   * does not become `result`, does not re-derive entity status, does not touch
   * pattern staleness, and is never reported as a health event. Mid-drag
   * non-convergence is normal and transient.
   */
  run(pins?: PinMap): void {
    evaluateAll(
      this.doc.variables,
      this.doc.dimensions,
      this.doc.displayUnit,
      this.doc.stockThickness,
      this.doc.operations,
    );
    const res = solve(this.doc, pins);

    if (!pins) {
      this.lastResult = res;
      this.lastStatus = computeEntityDofStatus(this.doc, res);
      this.updatePatternStaleness();
      this.reportHealth(res);
    }

    // Published on every solve, drags included. Mid-drag this re-publishes the
    // SAME map object, which the design tree diffs away and the renderer
    // assigns over itself — so a drag costs nothing here.
    this.sinks.publishEntityStatus(this.lastStatus);
    const anyUnderDefined = [...this.lastStatus.values()].some((s) => s === "under-defined");
    this.sinks.publishSolveStatus(res, anyUnderDefined);
    this.sinks.requestRender();
  }

  /**
   * A variable was committed (name/value/delete). Re-evaluate variables and
   * solve so any variable-driven dimensions move their geometry into place, then
   * regenerate any pattern OR generator feature that became stale — whether its
   * count/spacing/param expression changed or (for patterns) its source moved —
   * and solve again to refresh. All inside the history transaction the
   * VariablesBar already opened, so one undo reverts the edit and the regen
   * together. The guard keeps a regen's emitChange from recursing back in.
   */
  onVariablesChanged(): void {
    this.run(); // re-evaluates variables/dimensions and settles geometry
    if (this.autoRegenerating) return;
    this.autoRegenerating = true;
    try {
      const p = regenerateStalePatterns(this.doc);
      const f = regenerateStaleFeatures(this.doc);
      if (p || f) this.run();
    } finally {
      this.autoRegenerating = false;
    }
    this.doc.emitChange();
  }

  /** Rebuild every stale pattern from its current source, as one undo step. */
  regenerateStale(): void {
    if (this.stalePatternIds.size === 0) return;
    this.sinks.pushHistory();
    regenerateAllStalePatterns(this.doc, this.stalePatternIds);
    this.run();
    this.doc.emitChange();
  }

  private updatePatternStaleness(): void {
    const stale = new Set<string>();
    for (const pat of this.doc.patterns) {
      if (pat.sourceSnapshot === undefined) continue;
      if (computeSourceSnapshot(this.doc.entities, pat.sourceIds) !== pat.sourceSnapshot) {
        stale.add(pat.id);
      }
    }
    this.stalePatternIds = stale;

    const staleInstanceIds = new Set<string>();
    for (const pat of this.doc.patterns) {
      if (stale.has(pat.id)) {
        for (const inst of pat.instanceIds) for (const id of inst) staleInstanceIds.add(id);
      }
    }
    this.sinks.publishPatternStaleness(staleInstanceIds, stale.size);
  }

  /**
   * Report a sketch that stopped solving.
   *
   * A failed solve is the strongest quality signal this app has and it is
   * otherwise invisible after the fact — the user sees red geometry, fixes or
   * undoes it, and nothing records that it happened.
   *
   * The edge-triggering decision lives in `solveFailureEvent` (pure, tested);
   * this keeps only the previous-state bookkeeping. Drag solves (`pins`) never
   * reach here — mid-drag non-convergence is normal and transient.
   */
  private reportHealth(res: SolveResult): void {
    const payload = solveFailureEvent(res, this.lastConverged, {
      entities: this.doc.entities.length,
      constraints: this.doc.constraints.length,
      dimensions: this.doc.dimensions.length,
    });
    if (payload) track("solve_unconverged", payload);
    this.lastConverged = solveConverged(res);
  }
}
