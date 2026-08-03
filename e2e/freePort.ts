/**
 * Force-free the dev-server port AFTER a Playwright run.
 *
 * globalTeardown ONLY. Do not wire this to globalSetup: Playwright starts the
 * `webServer` before globalSetup runs, so freeing the port there kills the very
 * server the tests need, and every spec fails with ERR_CONNECTION_REFUSED while
 * the server appears to have started normally. That mistake shipped and broke
 * CI; it passes locally right up until there is a leaked server on the port for
 * the setup hook to find.
 *
 * Playwright cannot be relied on to stop the server it started. It has no
 * SIGTERM on Windows, so it force-kills the process *group*, and a Vite server
 * always sits behind at least one `cmd.exe` wrapper — with `npm run dev`, behind
 * four processes. In practice the kill sometimes lands and sometimes doesn't,
 * which is worse than never landing: the leak is intermittent, so it accumulates
 * quietly. Four orphaned servers were found running from previous days' sessions,
 * each still watching the project, so every source edit rebuilt the module graph
 * in all of them. Clearing them cut this suite's wall time from ~2.9 min to ~50s.
 *
 * Rather than hoping a shorter process chain gets killed (it mostly does, which
 * is precisely the trap), this makes it deterministic: after the run, whoever
 * holds the port dies. One leaked server can still be present at the START of a
 * run if the previous one was killed mid-flight; `reuseExistingServer` is left
 * on locally so that case is reused rather than fought over.
 *
 * Deliberately kills by PORT, not by process name: the target is "whatever is
 * squatting on 5173", which is the actual problem, and node processes unrelated
 * to this project (an editor's language server) must not be caught in it.
 */
import { execFileSync } from "node:child_process";

const PORT = 5173;

/** PIDs listening on `port`, via the platform's own tooling. */
function listenersOn(port: number): number[] {
  const pids = new Set<number>();
  try {
    if (process.platform === "win32") {
      const out = execFileSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8" });
      for (const line of out.split("\n")) {
        // `TCP  0.0.0.0:5173  0.0.0.0:0  LISTENING  1234`
        const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/);
        if (m && Number(m[1]) === port) pids.add(Number(m[2]));
      }
    } else {
      const out = execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], {
        encoding: "utf8",
      });
      for (const line of out.split("\n")) if (line.trim()) pids.add(Number(line.trim()));
    }
  } catch {
    // No listener (lsof exits non-zero), or the tool is unavailable. Either way
    // there is nothing to clean up and nothing worth failing the run over.
  }
  return [...pids].filter((p) => Number.isInteger(p) && p > 0);
}

export function freeDevPort(): void {
  for (const pid of listenersOn(PORT)) {
    try {
      if (process.platform === "win32") {
        // /T kills the wrapper's children too — the point of the exercise.
        execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        process.kill(pid, "SIGKILL");
      }
      console.log(`[e2e] freed port ${PORT} (killed leaked server pid ${pid})`);
    } catch {
      // Already gone, or not ours to kill. Not worth failing the run over.
    }
  }
}

export default freeDevPort;
