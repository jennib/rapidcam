/**
 * RapidCAM headless CLI — lets scripts and AI agents drive the author →
 * validate → post → look loop without a human in the browser.
 *
 *   npm run cli -- validate <file.rcam>
 *   npm run cli -- post <file.rcam> [-o <dir>]
 *   npm run cli -- render <file.rcam> [-o <out.png>]
 *   npm run cli -- open <file.rcam> [--url <base>]
 *   npm run cli -- decode "<share-url>" [-o <out.rcam>]
 *
 * Exit codes: 0 success (warnings allowed), 1 findings/errors, 2 usage.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { buildErrorReport } from "../src/io/aiCheck";
import { postRcamText, validateRcamText } from "./core";

const USAGE = `RapidCAM CLI

Usage:
  rapidcam validate <file.rcam>            schema + load + constraint-solve checks
  rapidcam post <file.rcam> [-o <dir>]     generate G-code (.nc) + Apollo pre-flight lint
  rapidcam render <file.rcam> [-o <png>]   render the design to a PNG (headless Chromium)
  rapidcam open <file.rcam> [--url <base>] validate, then open the design in the browser
                                           (share-link URL; default base https://rapidcam.app/)
  rapidcam decode "<share-url>" [-o <out.rcam>]
                                           turn a share link (File > Copy Share Link) back into
                                           .rcam JSON — quote the URL so the shell keeps the #…
                                           fragment; prints to stdout unless -o is given

The published authoring contract for .rcam files:
  guide   https://rapidcam.app/docs/rcam-format-v2.md
  schema  https://rapidcam.app/schema/rcam-v2.schema.json`;

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1 || i === args.length - 1) return undefined;
  return args[i + 1];
}

function readInput(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    console.error(`cannot read ${path}: ${(e as Error).message}`);
    process.exit(2);
  }
}

function baseNameOf(path: string): string {
  return basename(path).replace(/\.rcam$/i, "");
}

async function main(): Promise<number> {
  const [cmd, target, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(USAGE);
    return cmd ? 0 : 2;
  }
  if (!target) {
    console.error(`missing <file.rcam>\n\n${USAGE}`);
    return 2;
  }

  switch (cmd) {
    case "validate": {
      const result = validateRcamText(readInput(target));
      if (result.issues.length === 0) {
        console.log(`OK — ${basename(target)} passed schema, load, and solver checks.`);
        return 0;
      }
      console.log(buildErrorReport(result, basename(target)));
      return result.ok ? 0 : 1;
    }

    case "post": {
      const outDir = resolve(argValue(rest, "-o") ?? dirname(resolve(target)));
      let post: ReturnType<typeof postRcamText>;
      try {
        post = postRcamText(readInput(target), baseNameOf(target));
      } catch (e) {
        console.error(`post failed: ${(e as Error).message}`);
        return 1;
      }
      mkdirSync(outDir, { recursive: true });
      let lintErrors = 0;
      for (const w of post.warnings) console.log(`⚠ ${w}`);
      for (const p of post.programs) {
        const outPath = join(outDir, p.name);
        writeFileSync(outPath, p.gcode);
        console.log(`wrote ${outPath} (${p.gcode.split("\n").length} lines)`);
        for (const f of p.lint) {
          if (f.severity === "error") lintErrors++;
          console.log(`  ${f.severity === "error" ? "✗" : "⚠"} [${f.code}] ${f.message}`);
        }
      }
      if (lintErrors) {
        console.error(
          `\n${lintErrors} pre-flight lint error${lintErrors === 1 ? "" : "s"} — the files were written, but review before running them.`,
        );
        return 1;
      }
      return 0;
    }

    case "render": {
      const out = resolve(argValue(rest, "-o") ?? `${baseNameOf(target)}.png`);
      const { renderRcam } = await import("./render");
      await renderRcam(resolve(target), out);
      console.log(`wrote ${out}`);
      return 0;
    }

    case "open": {
      const content = readInput(target);
      const result = validateRcamText(content);
      if (!result.ok) {
        console.log(buildErrorReport(result, basename(target)));
        console.error("\nrefusing to open an invalid design — fix the errors above first.");
        return 1;
      }
      const { buildOpenUrl, launchBrowser } = await import("./open");
      const url = await buildOpenUrl(content, argValue(rest, "--url") ?? undefined);
      launchBrowser(url);
      console.log(
        `opened "${baseNameOf(target)}" in the browser (${url.length}-char link; the design stays client-side).`,
      );
      for (const i of result.issues) console.log(`  ⚠ [${i.check}] ${i.message}`);
      return 0;
    }

    case "decode": {
      const { decodeShareUrl } = await import("./decode");
      let json: string;
      try {
        json = await decodeShareUrl(target);
      } catch (e) {
        console.error(`decode failed: ${(e as Error).message}`);
        return 1;
      }
      const out = argValue(rest, "-o");
      if (out) {
        const outPath = resolve(out);
        writeFileSync(outPath, json);
        console.error(`wrote ${outPath}`); // stderr: stdout stays JSON-only
      } else {
        console.log(json);
      }
      return 0;
    }

    default:
      console.error(`unknown command "${cmd}"\n\n${USAGE}`);
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error((e as Error).stack ?? String(e));
    process.exit(1);
  },
);
