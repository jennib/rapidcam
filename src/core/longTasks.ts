/**
 * Long-task flight recorder — turns "the app sometimes hangs" into data.
 *
 * A frozen tab is the one bug class the app cannot report on itself. Every
 * expensive path here is SYNCHRONOUS on the main thread (generator rebuild, CAM
 * estimate, canvas render), so while one is running the browser cannot repaint:
 * no spinner, no toast, no status line. Whatever we want to say about the hang
 * has to be said AFTER it ends, which is exactly what this records.
 *
 * Two halves, because neither alone is enough:
 *
 *  - {@link measure} wraps a known-suspect call and remembers when it ran. It
 *    does not decide anything; it only leaves a NAME behind.
 *  - a `longtask` PerformanceObserver catches every block over ~50ms, including
 *    the ones nobody thought to wrap — which is the whole point when the culprit
 *    is unknown. It fires in a LATER task, by which time the call that blocked
 *    has long returned, so entries are attributed by overlapping their time
 *    window against the recent {@link measure} windows.
 *
 * `longtask` is Chromium-only. Where it is missing, `measure` reports its own
 * overruns directly, so an instrumented path is still covered on Firefox/Safari
 * — an un-instrumented one simply is not, and that is the honest limit of this.
 *
 * Reads (and reports) nothing about the document beyond a label and a duration.
 */

import { track } from "../analytics";

/**
 * Below this a block is jank, not a hang. 200ms is roughly where a click stops
 * feeling connected to its result; the observer's own floor is 50ms, so entries
 * between the two are seen and deliberately dropped.
 */
const THRESHOLD_MS = 200;

/**
 * Distinct labels reported per session. Matches the error-capture idiom in
 * analytics.ts: a path that blocks once usually blocks every time, and the first
 * occurrence carries the whole signal. Bounded so a render loop that has gone
 * quadratic cannot spend the analytics quota in a minute.
 */
const MAX_RECORDS = 40;

/**
 * How many recent {@link measure} windows to keep for attribution. A long task
 * is attributed against windows that have already CLOSED, and only a handful can
 * have closed inside one 200ms+ block, so this is generous rather than tight.
 */
const RECENT_WINDOWS = 12;

export interface LongTaskRecord {
  /** The `measure` label whose window covered this block, or "unattributed". */
  label: string;
  ms: number;
  /** `performance.now()` at the start of the block. */
  at: number;
  /** How it was caught — an un-instrumented block can only be seen by the observer. */
  via: "longtask" | "measure";
}

interface Window_ {
  label: string;
  start: number;
  end: number;
}

const recent: Window_[] = [];
const records: LongTaskRecord[] = [];
const seen = new Set<string>();
let observing = false;

/**
 * The recorded blocks, worst first. Exposed for the dev hook and for tests;
 * a copy, so a caller cannot corrupt the record it is reading.
 */
export function longTasks(): LongTaskRecord[] {
  return [...records].sort((a, b) => b.ms - a.ms);
}

/** Test seam — drops every window and record. */
export function resetLongTasks(): void {
  recent.length = 0;
  records.length = 0;
  seen.clear();
}

/**
 * Name the closed window that overlaps [start, end) by the most time.
 *
 * Overlap rather than containment: a long task's own boundaries come from the
 * browser's task queue and a `measure` window from `performance.now()` inside
 * it, so the two never nest exactly, and requiring containment attributed
 * nothing. Exported for the unit test — the correlation is the only part of this
 * module with a wrong answer available to it.
 */
export function attribute(start: number, end: number, windows: Window_[] = recent): string {
  let best = "unattributed";
  let bestOverlap = 0;
  for (const w of windows) {
    const overlap = Math.min(end, w.end) - Math.max(start, w.start);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = w.label;
    }
  }
  return best;
}

function record(label: string, ms: number, at: number, via: LongTaskRecord["via"]): void {
  try {
    if (seen.has(label) || seen.size >= MAX_RECORDS) return;
    seen.add(label);
    records.push({ label, ms, at, via });
    // Deduped and capped above, so this cannot become the per-frame console
    // spam that once cost a quarter of the frame budget (see core/transform.ts).
    console.warn(`[longtask] ${label} blocked the main thread for ${Math.round(ms)}ms`);
    track("long_task", { label, ms: Math.round(ms), via });
  } catch {
    // A diagnostic must never be the thing that breaks the app.
  }
}

/**
 * Run `fn`, remembering the window it occupied so a long task overlapping it can
 * be named. Returns whatever `fn` returns and rethrows what it throws — wrapping
 * a call must not change what that call does.
 */
export function measure<T>(label: string, fn: () => T): T {
  const start = performance.now();
  try {
    return fn();
  } finally {
    const end = performance.now();
    recent.push({ label, start, end });
    if (recent.length > RECENT_WINDOWS) recent.shift();
    // Only self-report where the observer cannot; otherwise it would double-count
    // every block, once here and once on attribution.
    if (!observing && end - start >= THRESHOLD_MS) record(label, end - start, start, "measure");
  }
}

/**
 * Start watching. Safe to call before consent — `track` is gated internally and
 * no-ops until PostHog initialises, exactly like error capture.
 */
export function installLongTaskWatch(): void {
  if (observing || typeof PerformanceObserver === "undefined") return;
  try {
    const obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.duration < THRESHOLD_MS) continue;
        record(attribute(e.startTime, e.startTime + e.duration), e.duration, e.startTime, "longtask");
      }
    });
    obs.observe({ type: "longtask", buffered: true });
    observing = true;
  } catch {
    // Not Chromium — `measure` falls back to reporting its own overruns.
  }
}
