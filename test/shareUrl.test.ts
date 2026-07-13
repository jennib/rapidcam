/**
 * Headless share URLs (cli/open.ts + shareLink.ts in Node): the delivery leg
 * of an agent's author → validate → open loop. The e2e suite proves the
 * browser end consumes these; this proves the Node end produces them.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodeShareUrl } from "../cli/decode";
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
      notes: Array.from({ length: MAX_OPEN_URL * 2 }, () => Math.random().toString(36)[2]).join(""),
    };
    await expect(buildOpenUrl(JSON.stringify(file))).rejects.toThrow(/too large/);
  });

  it("writeRedirectPage embeds the URL safely", () => {
    const page = writeRedirectPage("https://rapidcam.app/#d=gABC");
    const html = readFileSync(page, "utf8");
    expect(html).toContain('location.replace("https://rapidcam.app/#d=gABC")');
  });
});

describe("decodeShareUrl (the reverse direction)", () => {
  it("round-trips buildOpenUrl → decodeShareUrl back to the original design", async () => {
    const file = parseRcam(exampleText);
    const url = await buildOpenUrl(exampleText);
    const decoded = parseRcam(await decodeShareUrl(url));
    expect(decoded.name).toBe(file.name);
    expect(decoded.entities).toEqual(file.entities);
    expect(decoded.operations).toEqual(file.operations);
  });

  it("accepts a full URL, a bare d=… string, and the raw payload alike", async () => {
    const url = await buildOpenUrl(exampleText);
    const payload = url.split("#d=")[1];
    const fromUrl = await decodeShareUrl(url);
    expect(await decodeShareUrl(`d=${payload}`)).toBe(fromUrl);
    expect(await decodeShareUrl(payload)).toBe(fromUrl);
    // Pretty-printed for humans and diff tools.
    expect(fromUrl).toContain('\n  "version"');
  });

  it("rejects a URL with no design payload with a pointer to Copy Share Link", async () => {
    await expect(decodeShareUrl("https://rapidcam.app/")).rejects.toThrow(/no design payload/);
    await expect(decodeShareUrl("https://rapidcam.app/#other=1")).rejects.toThrow(
      /Copy Share Link/,
    );
  });

  it("rejects an unknown codec with a clear message", async () => {
    await expect(decodeShareUrl("https://rapidcam.app/#d=xABC")).rejects.toThrow(
      /Unknown share-link codec "x"/,
    );
  });
});
