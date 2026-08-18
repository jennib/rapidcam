/**
 * Runner for the one-off measurement probes in `scripts/*.e2e.ts`.
 *
 * The main `playwright.config.ts` is `testDir: "./e2e"`, so nothing in
 * `scripts/` is reachable from it — which is why six committed probes
 * (`load-probe`, `scale-probe`, `interaction-probe`, `design-tree-probe`,
 * `coupled-probe`, `resample-space-probe`) had no way to be run except by
 * remembering to pass `--config` with a file that kept getting written and
 * thrown away. This one is committed so they stay runnable: `npm run probe`,
 * or `npm run probe -- scripts/load-probe.e2e.ts` for one of them.
 *
 * Probes are NOT tests and are deliberately not in `npm run validate`: they
 * measure (timings, colour error, interaction cost) rather than assert, several
 * take minutes, and their output is meant to be read. `retries: 0` because a
 * retried measurement is a different measurement.
 */
import base from "./playwright.config";

export default { ...base, testDir: "./scripts", reporter: "list" as const, retries: 0 };
