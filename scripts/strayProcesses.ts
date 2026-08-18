/**
 * Find processes that are BURNING CPU RIGHT NOW.
 *
 * Why this exists: a stray `npm run dev`, or an MCP server left over from a
 * past session, does not announce itself. It steals cores, and the only symptom
 * is that the test suite gets slower and starts failing on timeouts — which
 * reads as a code regression. It has cost real diagnosis time more than once:
 * six abandoned dev servers made `npm run validate` 8x slower, and an orphaned
 * `mcp/server.ts` holding 165% of a core for 24 hours timed out three 30-second
 * tests while CI on the same commit was green.
 *
 * `vite.config.ts` already states the principle this enforces: *"a test whose
 * result depends on what else is running is a benchmark with an assertion on
 * it."* This module is how we find out BEFORE the run rather than after.
 *
 * ## The measurement, and why the obvious one is wrong
 *
 * Total CPU time is the number every task manager shows first, and it is
 * confounded by uptime: a process that worked hard for a minute and then went
 * idle looks identical to one that has been spinning gently for a day. Both
 * report "a lot of CPU".
 *
 * So sample TWICE and take the difference. `coreFraction` is CPU-seconds
 * consumed per second of wall clock: 0.0 is asleep, 1.0 is one core pinned,
 * and >1.0 means several threads are spinning. That number is a fact about the
 * present, which is the only thing that can affect the run you are about to
 * start.
 *
 * ## Two safety rules that matter more than the detection
 *
 * 1. **Detect broadly, kill narrowly.** Anything spinning steals the machine, so
 *    everything is REPORTED; but only a process whose command line names this
 *    repo (`mine`) may be killed automatically. A developer's unrelated Node
 *    service is none of our business.
 *
 *    This split exists because the first version filtered by repo before even
 *    looking, and a deliberate spinner started as `node spin.js` — a RELATIVE
 *    path, so the repo name never appeared — walked straight past it. Every
 *    historical stray here happened to run through `node_modules` with an
 *    absolute path, which is exactly the kind of luck that hides a blind spot.
 * 2. **Never flag ourselves or our own ancestors.** Otherwise a doctor run
 *    inside `npm run validate` reports the shell that invoked it.
 */

export interface ProcSample {
  pid: number;
  ppid: number;
  /** Full command line, used both to identify and to filter by repo. */
  cmd: string;
  /** Cumulative CPU seconds (user + kernel) since the process started. */
  cpuSeconds: number;
  /** Wall-clock seconds since the process started. */
  ageSeconds: number;
  /**
   * Does this process provably belong to THIS repo (its command line names the
   * repo path)? Only these may ever be killed automatically — see the note on
   * `mine` in `StrayVerdict`.
   */
  mine: boolean;
}

export type Verdict = "runaway" | "working" | "idle" | "too-young";

export interface StrayVerdict {
  pid: number;
  cmd: string;
  /** CPU-seconds consumed per wall second over the sample window. */
  coreFraction: number;
  ageSeconds: number;
  verdict: Verdict;
  reason: string;
  /**
   * Safe to kill automatically. A spinning process we CANNOT attribute to this
   * repo is still worth reporting — it poisons the run just the same — but it
   * might be the developer's real work, so it is only ever named, never killed.
   */
  mine: boolean;
}

export interface ClassifyOptions {
  /** Wall seconds between the two samples. */
  windowSeconds: number;
  /** Our own pid and every ancestor — never flagged. */
  selfPids: ReadonlySet<number>;
  /**
   * A process younger than this is doing startup work, not spinning. A cold
   * `vite build` legitimately pins a core for its first seconds.
   */
  minAgeSeconds?: number;
  /** At or above this many cores held, sustained, it is a runaway. */
  runawayCoreFraction?: number;
  /** Below this it is not worth mentioning. */
  idleCoreFraction?: number;
}

export const DEFAULT_MIN_AGE_SECONDS = 120;
export const DEFAULT_RUNAWAY_CORE_FRACTION = 0.5;
export const DEFAULT_IDLE_CORE_FRACTION = 0.05;

/**
 * Does this command line belong to the repo at `repoRoot`?
 *
 * Compared case-insensitively with slashes normalised, because on Windows the
 * same path arrives as `C:\Users\...` from one API and `c:/Users/...` from
 * another, and a miss here means a runaway goes unreported.
 */
export function belongsToRepo(cmd: string, repoRoot: string): boolean {
  const norm = (s: string) => s.replace(/\\/g, "/").toLowerCase();
  return norm(cmd).includes(norm(repoRoot));
}

/**
 * Compare two samples of the same processes and say which are spinning.
 *
 * A pid present in only one sample is dropped rather than guessed at: it either
 * started or exited mid-window, and in both cases there is no rate to compute.
 */
export function classify(
  before: readonly ProcSample[],
  after: readonly ProcSample[],
  opts: ClassifyOptions,
): StrayVerdict[] {
  const {
    windowSeconds,
    selfPids,
    minAgeSeconds = DEFAULT_MIN_AGE_SECONDS,
    runawayCoreFraction = DEFAULT_RUNAWAY_CORE_FRACTION,
    idleCoreFraction = DEFAULT_IDLE_CORE_FRACTION,
  } = opts;

  if (windowSeconds <= 0) throw new Error("windowSeconds must be > 0");

  const first = new Map(before.map((p) => [p.pid, p]));
  const out: StrayVerdict[] = [];

  for (const now of after) {
    const then = first.get(now.pid);
    if (!then) continue; // started mid-window — no rate to compute.
    if (selfPids.has(now.pid)) continue; // us, or whoever launched us.

    // A pid can be reused after a process exits. The replacement is younger
    // than the window it would be measured over, which is the tell.
    if (now.ageSeconds < windowSeconds) continue;

    const used = now.cpuSeconds - then.cpuSeconds;
    // Clock corrections and pid reuse can both produce a negative delta; a
    // process cannot un-consume CPU, so treat it as unmeasurable rather than
    // reporting a nonsense rate.
    if (used < 0) continue;

    const coreFraction = used / windowSeconds;

    let verdict: Verdict;
    let reason: string;
    if (coreFraction < idleCoreFraction) {
      verdict = "idle";
      reason = "asleep — idle is the job of a server";
    } else if (now.ageSeconds < minAgeSeconds) {
      verdict = "too-young";
      reason = `only ${Math.round(now.ageSeconds)}s old — still starting up`;
    } else if (coreFraction >= runawayCoreFraction) {
      verdict = "runaway";
      reason = `holding ${coreFraction.toFixed(2)} cores after ${Math.round(
        now.ageSeconds / 60,
      )} min`;
    } else {
      verdict = "working";
      reason = "busy, but not enough to poison a run";
    }

    out.push({
      pid: now.pid,
      cmd: now.cmd,
      coreFraction,
      ageSeconds: now.ageSeconds,
      verdict,
      reason,
      mine: now.mine,
    });
  }

  // Worst first: the thing to kill should be the thing you read first.
  return out.sort((a, b) => b.coreFraction - a.coreFraction);
}
