/**
 * Is anything stealing this machine before we measure it?
 *
 * Runs as the first step of `npm run validate`, because a poisoned run does not
 * look poisoned — it looks like a code regression. See `strayProcesses.ts` for
 * the measurement and why a sampled RATE is the only honest one.
 *
 *   npm run doctor           report; exit 1 if anything is spinning
 *   npm run doctor -- --kill report, then kill the runaways
 *   npm run doctor -- --window=8   sample over 8s instead of 3
 *   npm run doctor -- --min-age=5  judge processes younger than the 120s default
 *
 * Skipped entirely on CI: a fresh runner has no strays, and a false positive
 * that fails everyone's build would be a worse bug than the one this prevents.
 */
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  belongsToRepo,
  classify,
  DEFAULT_RUNAWAY_CORE_FRACTION,
  type ProcSample,
  type StrayVerdict,
} from "./strayProcesses";

const RUNTIME = /\b(node|esbuild|vite|tsx|bun|deno|vitest)\b/;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Windows: one CIM query already carries CPU time, age, parent and command line. */
function sampleWindows(): ProcSample[] {
  // Every JS/build runtime, not just ones naming the repo: a spinner started
  // with a relative path (`node spin.js`) names no path at all, and that blind
  // spot is exactly what the first version of this shipped with.
  const ps = `
    $names = @('node','esbuild','vite','tsx','bun','deno','vitest')
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object { $names -contains ($_.Name -replace '[.]exe$','') } |
      ForEach-Object {
        [pscustomobject]@{
          pid  = [int]$_.ProcessId
          ppid = [int]$_.ParentProcessId
          cmd  = if ($_.CommandLine) { $_.CommandLine } else { $_.Name }
          cpu  = ([double]($_.KernelModeTime) + [double]($_.UserModeTime)) / 1e7
          age  = if ($_.CreationDate) { ((Get-Date) - $_.CreationDate).TotalSeconds } else { 0 }
        }
      } | ConvertTo-Json -Compress -Depth 3`;
  const out = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", ps],
    { encoding: "utf8", env: { ...process.env, RAPIDCAM_ROOT: REPO_ROOT }, maxBuffer: 32 * 1024 * 1024 },
  ).trim();
  if (!out) return [];
  const raw = JSON.parse(out) as
    | { pid: number; ppid: number; cmd: string; cpu: number; age: number }
    | { pid: number; ppid: number; cmd: string; cpu: number; age: number }[];
  // ConvertTo-Json emits a bare object, not an array, for a single match.
  const rows = Array.isArray(raw) ? raw : [raw];
  return rows.map((r) => ({
    pid: r.pid,
    ppid: r.ppid,
    cmd: r.cmd,
    cpuSeconds: r.cpu,
    ageSeconds: r.age,
    mine: belongsToRepo(r.cmd, REPO_ROOT),
  }));
}

/** POSIX: `ps` gives cumulative CPU as [[dd-]hh:]mm:ss. */
function samplePosix(): ProcSample[] {
  const out = execFileSync("ps", ["-eo", "pid=,ppid=,etimes=,time=,args="], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const rows: ProcSample[] = [];
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const [, pid, ppid, etimes, time, cmd] = m;
    if (!RUNTIME.test(cmd)) continue;
    rows.push({
      pid: Number(pid),
      ppid: Number(ppid),
      cmd,
      cpuSeconds: parseCpuTime(time),
      ageSeconds: Number(etimes),
      mine: belongsToRepo(cmd, REPO_ROOT),
    });
  }
  return rows;
}

/** `[[dd-]hh:]mm:ss` → seconds. */
export function parseCpuTime(t: string): number {
  const [dayPart, clockPart] = t.includes("-") ? t.split("-") : ["0", t];
  const parts = clockPart.split(":").map(Number);
  const [h, m, s] = parts.length === 3 ? parts : [0, parts[0], parts[1]];
  return Number(dayPart) * 86400 + h * 3600 + m * 60 + s;
}

const sample = process.platform === "win32" ? sampleWindows : samplePosix;

/** Our own pid plus every ancestor we can see, so a run never reports itself. */
function selfChain(rows: readonly ProcSample[]): Set<number> {
  const parent = new Map(rows.map((r) => [r.pid, r.ppid]));
  const chain = new Set<number>([process.pid, process.ppid]);
  let cur = process.pid;
  for (let hops = 0; hops < 32; hops++) {
    const next = parent.get(cur);
    if (next === undefined || chain.has(next)) break;
    chain.add(next);
    cur = next;
  }
  return chain;
}

function shorten(cmd: string): string {
  const trimmed = cmd.replace(/"/g, "").replace(new RegExp(REPO_ROOT.replace(/[\\/]/g, "[\\\\/]"), "gi"), ".");
  return trimmed.length > 96 ? `${trimmed.slice(0, 93)}...` : trimmed;
}

async function main(): Promise<void> {
  if (process.env.CI) {
    console.log("doctor: skipped on CI");
    return;
  }

  const args = process.argv.slice(2);
  const kill = args.includes("--kill");
  const quiet = args.includes("--quiet");
  const windowSeconds = Number(args.find((a) => a.startsWith("--window="))?.split("=")[1] ?? 3);
  // Lower the startup grace period when you are deliberately hunting something
  // you just started — the default 120s exists for cold builds, not for you.
  const minAge = args.find((a) => a.startsWith("--min-age="))?.split("=")[1];

  const before = sample();
  await new Promise((r) => setTimeout(r, windowSeconds * 1000));
  const after = sample();

  const verdicts = classify(before, after, {
    windowSeconds,
    selfPids: selfChain(after),
    ...(minAge === undefined ? {} : { minAgeSeconds: Number(minAge) }),
  });
  const runaways = verdicts.filter((v) => v.verdict === "runaway");

  if (!quiet) {
    const seen = verdicts.filter((v) => v.verdict !== "idle");
    console.log(
      `doctor: ${verdicts.length} repo process(es) sampled over ${windowSeconds}s, ` +
        `${runaways.length} runaway, ${seen.length - runaways.length} busy-but-fine`,
    );
  }

  if (runaways.length === 0) return;

  const ours = runaways.filter((r) => r.mine);
  const theirs = runaways.filter((r) => !r.mine);

  console.error(`
  ${runaways.length} process(es) are burning this machine:
`);
  for (const r of ours) report(r);
  if (theirs.length) {
    console.error(
      ours.length
        ? `  ...and ${theirs.length} NOT attributable to this repo — yours to judge:
`
        : `  NOT attributable to this repo — yours to judge:
`,
    );
    for (const r of theirs) report(r);
  }

  if (kill) {
    for (const r of ours) {
      try {
        process.kill(r.pid, "SIGKILL");
        console.error(`  killed ${r.pid}`);
      } catch (e) {
        console.error(`  could NOT kill ${r.pid}: ${(e as Error).message}`);
      }
    }
    // Never automatic for the others: one of them could be the work you are
    // actually being paid for.
    if (theirs.length) {
      console.error(`  left ${theirs.length} alone — not this repo's. Kill those by pid yourself.`);
    }
    return;
  }

  console.error(
    `
  A run measured against this is a benchmark with an assertion on it.
` +
      `  Fix it with:  npm run doctor -- --kill
`,
  );
  process.exitCode = 1;
}

function report(r: StrayVerdict): void {
  console.error(`  pid ${r.pid}  ${r.coreFraction.toFixed(2)} cores  ${Math.round(r.ageSeconds / 60)} min old`);
  console.error(`      ${shorten(r.cmd)}`);
}

main().catch((e) => {
  // Never let a diagnostic be the thing that breaks the build.
  console.error(`doctor: could not sample processes (${(e as Error).message}) — continuing`);
});

export { DEFAULT_RUNAWAY_CORE_FRACTION };
