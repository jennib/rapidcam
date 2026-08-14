/**
 * Debounced, chunked background time estimation for toolpath operations.
 * Extracted from camBar.ts to isolate event loop chunking and caching.
 */
import type { CADDocument } from "../../model/document";
import type { CAMOperation } from "../../cam/types";
import { estimateGCodeTime, formatDuration } from "../../cam/timeEstimate";
import { generateGCode, type GCodeOptions } from "../../cam/gcode";
import { measure } from "../../core/longTasks";

export class OpEstimateManager {
  public static readonly OP_EST_CHUNK = 3;

  private opTimeCache = new Map<string, number>();
  private opEstEls = new Map<string, HTMLElement>();
  private opEstTimer: number | null = null;

  constructor(
    private doc: CADDocument,
    private getGcodeOpts: () => GCodeOptions,
  ) {}

  public registerElement(opId: string, el: HTMLElement): void {
    this.opEstEls.set(opId, el);
  }

  public clearElements(): void {
    this.opEstEls.clear();
  }

  public getCached(op: CAMOperation): number | undefined {
    return this.opTimeCache.get(this.opTimeKey(op));
  }

  /**
   * Signature for the op-time cache: the op plus the doc context that changes its
   * posted motion (stock thickness drives depth passes; machine kind picks the
   * generator). Origin only shifts coordinates, not lengths, so it's omitted.
   */
  public opTimeKey(op: CAMOperation): string {
    return `${this.doc.machineKind}|${this.doc.stockThickness}|${JSON.stringify(op)}`;
  }

  /**
   * Fill in any missing per-op run-time estimates off the render path.
   */
  public scheduleOpEstimates(): void {
    const pending = this.doc.operations.filter(
      (op) => this.opEstEls.has(op.id) && !this.opTimeCache.has(this.opTimeKey(op)),
    );
    if (pending.length === 0) return;
    if (this.opEstTimer !== null) window.clearTimeout(this.opEstTimer);
    this.opEstTimer = window.setTimeout(() => this.runOpEstimateChunk(pending), 150);
  }

  public cancel(): void {
    if (this.opEstTimer !== null) {
      window.clearTimeout(this.opEstTimer);
      this.opEstTimer = null;
    }
  }

  private runOpEstimateChunk(pending: CAMOperation[]): void {
    const chunk = pending.slice(0, OpEstimateManager.OP_EST_CHUNK);
    const rest = pending.slice(OpEstimateManager.OP_EST_CHUNK);
    for (const op of chunk) {
      const key = this.opTimeKey(op);
      let secs = this.opTimeCache.get(key);
      if (secs === undefined) {
        try {
          // Chunking is per OP, which buys nothing when a single op is the
          // expensive one — kumiko's inside-profile carries one target per
          // opening. Labelled by kind and target count so the record says which.
          secs = measure(`cam:estimate:${op.type}:${op.entityIds.length}`, () =>
            estimateGCodeTime(generateGCode([op], this.doc, this.getGcodeOpts())).seconds,
          );
        } catch {
          secs = 0; // a bad/empty op shouldn't break the list
        }
        this.opTimeCache.set(key, secs);
      }
      // The element may have been replaced by a newer render — update only if it's
      // still the live one for this op.
      const el = this.opEstEls.get(op.id);
      if (el) el.textContent = `⏱ ~${formatDuration(secs)}`;
    }
    this.opEstTimer =
      rest.length > 0 ? window.setTimeout(() => this.runOpEstimateChunk(rest), 0) : null;
  }
}
