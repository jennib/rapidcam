import { spawnSync } from "node:child_process";

const runtimeTests = [
  "test/dimensions.test.ts",
  "test/solver.test.ts",
  "test/gcode.test.ts",
];

let failed = false;

for (const testFile of runtimeTests) {
  console.log(`\n> npx tsx ${testFile}`);
  const result = spawnSync("npx", ["tsx", testFile], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    failed = true;
  }
}

process.exit(failed ? 1 : 0);
