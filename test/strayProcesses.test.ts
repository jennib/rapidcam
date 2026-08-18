import { describe, expect, test } from "vitest";
import {
  belongsToRepo,
  classify,
  DEFAULT_MIN_AGE_SECONDS,
  type ProcSample,
} from "../scripts/strayProcesses";

/**
 * The classifier is pure on purpose: the thing worth pinning is the JUDGEMENT
 * (what counts as a runaway), not the platform plumbing that reads `ps`. Every
 * case below is a real shape this has to get right — the ones marked with a
 * story are ones that actually happened.
 */

const ROOT = "C:/Users/jenni/Projects/rapidcam";
const NONE = new Set<number>();

function proc(over: Partial<ProcSample> & { pid: number }): ProcSample {
  return {
    ppid: 1,
    cmd: `node ${ROOT}/node_modules/vite/bin/vite.js`,
    cpuSeconds: 0,
    ageSeconds: 3600,
    mine: true,
    ...over,
  };
}

/** Same process, `used` CPU-seconds later. (Not named `after` — biome reads
 * that as a vitest hook.) */
function later(p: ProcSample, used: number, windowSeconds = 10): ProcSample {
  return { ...p, cpuSeconds: p.cpuSeconds + used, ageSeconds: p.ageSeconds + windowSeconds };
}

describe("classify", () => {
  test("a process pinning a core is a runaway", () => {
    const a = proc({ pid: 100, cpuSeconds: 5000 });
    const [v] = classify([a], [later(a, 16.5)], { windowSeconds: 10, selfPids: NONE });

    expect(v.verdict).toBe("runaway");
    expect(v.coreFraction).toBeCloseTo(1.65, 2);
  });

  test("THE CASE THIS EXISTS FOR: huge total CPU but asleep now is NOT a runaway", () => {
    // An idle server that did real work earlier looks alarming on total CPU —
    // 72,747 CPU-seconds was the real number on the orphan that started this —
    // and is completely harmless to a test run. Only the rate can tell them
    // apart, so this is the assertion that makes the sampling worth doing.
    const a = proc({ pid: 101, cpuSeconds: 72_747, ageSeconds: 86_400 });
    const [v] = classify([a], [later(a, 0.01)], { windowSeconds: 10, selfPids: NONE });

    expect(v.verdict).toBe("idle");
  });

  test("and the mirror image: barely any total CPU but spinning right now IS", () => {
    // Positive control for the test above. Without it, both would pass against
    // a classifier that just always said "idle".
    const a = proc({ pid: 102, cpuSeconds: 3, ageSeconds: 7200 });
    const [v] = classify([a], [later(a, 9)], { windowSeconds: 10, selfPids: NONE });

    expect(v.verdict).toBe("runaway");
  });

  test("a young process is still starting up, not spinning", () => {
    // A cold `vite build` legitimately pins a core for its first seconds.
    const a = proc({ pid: 103, ageSeconds: 5 });
    const [v] = classify([a], [later(a, 10)], { windowSeconds: 10, selfPids: NONE });

    expect(v.verdict).toBe("too-young");
    expect(v.coreFraction).toBeCloseTo(1.0, 2);
  });

  test("the same load past the age threshold IS reported", () => {
    // Positive control for the young case: proves the exemption is about AGE,
    // not about the load being below the bar.
    const a = proc({ pid: 104, ageSeconds: DEFAULT_MIN_AGE_SECONDS + 60 });
    const [v] = classify([a], [later(a, 10)], { windowSeconds: 10, selfPids: NONE });

    expect(v.verdict).toBe("runaway");
  });

  test("we never report ourselves or whoever launched us", () => {
    // Otherwise `npm run validate` fails on its own shell, every time.
    const me = proc({ pid: 200, cpuSeconds: 100 });
    const parent = proc({ pid: 201, cpuSeconds: 100 });
    const other = proc({ pid: 202, cpuSeconds: 100 });

    const verdicts = classify(
      [me, parent, other],
      [later(me, 20), later(parent, 20), later(other, 20)],
      { windowSeconds: 10, selfPids: new Set([200, 201]) },
    );

    expect(verdicts.map((v) => v.pid)).toEqual([202]);
  });

  test("a process that appeared mid-window has no rate, so it is dropped", () => {
    const existing = proc({ pid: 300 });
    const born = proc({ pid: 301 });
    const verdicts = classify([existing], [later(existing, 0), later(born, 8)], {
      windowSeconds: 10,
      selfPids: NONE,
    });

    expect(verdicts.map((v) => v.pid)).toEqual([300]);
  });

  test("a reused pid cannot produce a false runaway", () => {
    // The replacement is younger than the window it would be measured over.
    const old = proc({ pid: 400, cpuSeconds: 900, ageSeconds: 9000 });
    const reused = proc({ pid: 400, cpuSeconds: 4, ageSeconds: 4 });

    expect(classify([old], [reused], { windowSeconds: 10, selfPids: NONE })).toEqual([]);
  });

  test("a negative delta is unmeasurable, not a negative rate", () => {
    const a = proc({ pid: 401, cpuSeconds: 500 });
    expect(classify([a], [later(a, -50)], { windowSeconds: 10, selfPids: NONE })).toEqual([]);
  });

  test("the worst offender is listed first", () => {
    const mild = proc({ pid: 500, cpuSeconds: 10 });
    const bad = proc({ pid: 501, cpuSeconds: 10 });
    const verdicts = classify([mild, bad], [later(mild, 6), later(bad, 18)], {
      windowSeconds: 10,
      selfPids: NONE,
    });

    expect(verdicts.map((v) => v.pid)).toEqual([501, 500]);
  });

  test("a spinner we cannot attribute is still REPORTED, just not ours to kill", () => {
    // Detect broadly, kill narrowly. The doctor kills only `mine`; anything
    // else is named so a human can judge it. Losing this distinction would
    // either hide a real thief or let a script kill someone's real work.
    const a = proc({ pid: 600, cmd: "node spin.js", mine: false, cpuSeconds: 10 });
    const [v] = classify([a], [later(a, 15)], { windowSeconds: 10, selfPids: NONE });

    expect(v.verdict).toBe("runaway");
    expect(v.mine).toBe(false);
  });

  test("a zero-length window is rejected rather than dividing by zero", () => {
    expect(() => classify([], [], { windowSeconds: 0, selfPids: NONE })).toThrow();
  });
});

describe("belongsToRepo", () => {
  test("matches despite Windows' two spellings of the same path", () => {
    // The sampler gets backslashes from one API and forward slashes from
    // another; a miss here means a runaway is never even considered.
    expect(belongsToRepo("node C:\\Users\\jenni\\Projects\\rapidcam\\node_modules\\x", ROOT)).toBe(true);
    expect(belongsToRepo("node c:/users/jenni/projects/rapidcam/node_modules/x", ROOT)).toBe(true);
  });

  test("someone else's Node service is none of our business", () => {
    // The safety rule: this is what keeps `--kill` from touching a developer's
    // unrelated work. chrome-devtools-mcp runs from npx and is excluded free.
    expect(belongsToRepo("node C:\\Users\\jenni\\Projects\\other-app\\server.js", ROOT)).toBe(false);
    expect(belongsToRepo("node .../npm/bin/npx-cli.js -y chrome-devtools-mcp@latest", ROOT)).toBe(false);
  });
});
