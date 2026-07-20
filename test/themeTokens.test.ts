/**
 * Tripwire for the CSS-token <-> canvas-palette contract (see view/colors.ts,
 * view/themeTokens.ts). The canvas can't read CSS var()s, so colors.ts keeps
 * literal defaults that must equal their :root token — otherwise the first
 * frame (before syncColorsFromTheme runs) renders a different color than the
 * CSS theme, and the "behavior-neutral sync" guarantee is silently broken.
 *
 * These tests run in the default node env (no DOM), which also exercises the
 * non-browser safety path of syncColorsFromTheme().
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COLORS, syncColorsFromTheme, TOKEN_MIRRORS } from "../src/view/colors";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** Extract `--name: value;` pairs from the first :root { ... } block in style.css. */
function readRootTokens(): Record<string, string> {
  const css = readFileSync(join(repoRoot, "src/style.css"), "utf8");
  const block = css.match(/:root\s*\{([\s\S]*?)\}/);
  if (!block) throw new Error("no :root block found in style.css");
  const tokens: Record<string, string> = {};
  for (const m of block[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    tokens[m[1]] = m[2].trim();
  }
  return tokens;
}

describe("theme token / canvas palette parity", () => {
  const tokens = readRootTokens();

  it("every mirrored token is actually defined in :root", () => {
    for (const cssVar of Object.values(TOKEN_MIRRORS)) {
      expect(tokens[cssVar as string], `${cssVar} must be defined in :root`).toBeTruthy();
    }
  });

  it("each COLORS default equals its :root token (behavior-neutral sync)", () => {
    for (const [key, cssVar] of Object.entries(TOKEN_MIRRORS)) {
      const literal = (COLORS as Record<string, string>)[key].toLowerCase();
      const token = tokens[cssVar as string].toLowerCase();
      expect(literal, `COLORS.${key} must equal ${cssVar}`).toBe(token);
    }
  });
});

describe("syncColorsFromTheme in a non-browser context", () => {
  it("is a safe no-op when there is no DOM (leaves defaults intact)", () => {
    expect(typeof document).toBe("undefined"); // node env precondition
    const before = { ...COLORS };
    expect(() => syncColorsFromTheme()).not.toThrow();
    expect({ ...COLORS }).toEqual(before);
  });
});
