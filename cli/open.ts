/**
 * `rapidcam open` — deliver a .rcam design into the user's browser.
 *
 * The design is encoded into a share-link URL (the app's own `#d=` format:
 * gzip + base64url in the fragment, so it never touches a server) and the
 * default browser is launched at it. Launching goes through a tiny local
 * redirect page because OS "open a URL" commands have command-line length
 * limits (~8 KB on Windows) far below what a design-bearing URL needs.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseRcam } from "../src/io/fileio";
import { shareUrlForFile } from "../src/io/shareLink";

/**
 * Beyond this, fragment URLs stop being dependable across browsers and
 * platforms. Designs that don't fit (typically image-bearing reliefs) must
 * travel as a .rcam file into File ▸ Open instead.
 */
export const MAX_OPEN_URL = 500_000;

/** Encode .rcam text into an app share URL against `base`. Throws when too large. */
export async function buildOpenUrl(text: string, base = "https://rapidcam.app/"): Promise<string> {
  const url = await shareUrlForFile(parseRcam(text), base);
  if (url.length > MAX_OPEN_URL) {
    throw new Error(
      `design too large for a share URL (${url.length} > ${MAX_OPEN_URL} chars) — ` +
        `save it as a .rcam file and open it with File > Open instead`,
    );
  }
  return url;
}

/**
 * Write the redirect page that carries a long URL past OS command-line
 * limits. Returns the page's path. (Exported so the e2e suite can drive the
 * exact page the launcher uses.)
 */
export function writeRedirectPage(url: string): string {
  const page = join(mkdtempSync(join(tmpdir(), "rapidcam-open-")), "open.html");
  // The URL is JSON-escaped into the script; base64url payloads cannot
  // contain "</script>" so the tag cannot be broken out of.
  writeFileSync(
    page,
    `<!doctype html><meta charset="utf-8"><title>Opening RapidCAM…</title>` +
      `<script>location.replace(${JSON.stringify(url)});</script>`,
  );
  return page;
}

/** Launch the user's default browser at `url` (detached; returns immediately). */
export function launchBrowser(url: string): void {
  const target = pathToFileURL(writeRedirectPage(url)).href;
  const [cmd, args]: [string, string[]] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", target]]
      : process.platform === "darwin"
        ? ["open", [target]]
        : ["xdg-open", [target]];
  spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
}
