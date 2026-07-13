/**
 * Headless share URLs (cli/open.ts + shareLink.ts in Node): the delivery leg
 * of an agent's author → validate → open loop. The e2e suite proves the
 * browser end consumes these; this proves the Node end produces them.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildOpenUrl, MAX_OPEN_URL, writeRedirectPage } from "../cli/open";
import { parseRcam } from "../src/io/fileio";
import { decodeDesign, shareUrlForFile } from "../src/io/shareLink";

const here = dirname(fileURLToPath(import.meta.url));
const exampleText = readFileSync(join(here, "..", "examples", "bolt-circle.rcam"), "utf8");

describe("headless share URLs", () => {
  it("round-trips a design through the share-link codec in Node", async () => {
    const file = parseRcam(exampleText);
    const url = await shareUrlForFile(file, "https://rapidcam.app/");
    expect(url.startsWith("https://rapidcam.app/#d=g")).toBe(true); // g = gzip codec
    const decoded = await decodeDesign(url.split("#d=")[1]);
    expect(decoded.name).toBe(file.name);
    expect(decoded.entities).toEqual(file.entities);
    expect(decoded.operations).toEqual(file.operations);
  });

  it("buildOpenUrl refuses designs too large for a URL", async () => {
    const file = parseRcam(exampleText);
    // Hard-to-compress noise in a free-text field forces the payload over the
    // cap (base-36 text still gzips ~35%, hence the 2× headroom).
    file.metadata = {
      job: "",
      revision: "",
      notes: Array.from({ length: MAX_OPEN_URL * 2 }, () => Math.random().toString(36)[2]).join(
        "",
      ),
    };
    await expect(buildOpenUrl(JSON.stringify(file))).rejects.toThrow(/too large/);
  });

  it("writeRedirectPage embeds the URL safely", () => {
    const page = writeRedirectPage("https://rapidcam.app/#d=gABC");
    const html = readFileSync(page, "utf8");
    expect(html).toContain('location.replace("https://rapidcam.app/#d=gABC")');
  });
});
