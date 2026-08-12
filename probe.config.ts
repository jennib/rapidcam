// TEMPORARY: runs the one-off probes in scripts/ with the normal e2e setup.
// Not part of the repo — delete after taking the measurement.
import base from "./playwright.config";

export default { ...base, testDir: "./scripts", reporter: "list" as const, retries: 0 };
