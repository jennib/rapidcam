/**
 * `rapidcam decode` — the reverse of `rapidcam open`: turn a share-link URL
 * (the app's `#d=` fragment format) back into .rcam JSON. This is how an
 * agent gets hold of the user's *current* design — the user copies a link
 * with File ▸ Copy Share Link, the agent decodes it, edits, validates, and
 * hands the result back with `open`.
 */

import { decodeDesign } from "../src/io/shareLink";

/**
 * Extract the `d=` payload from a share URL. Also accepts a bare `d=…` string
 * or the raw payload itself (the part after `d=`), so pasted fragments work.
 */
function extractPayload(input: string): string {
  const s = input.trim();
  if (!s) throw new Error("empty input — paste a RapidCAM share link (…#d=…)");

  const hash = s.indexOf("#");
  const looksLikeUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
  if (hash !== -1 || looksLikeUrl) {
    const fragment = hash !== -1 ? s.slice(hash + 1) : "";
    const payload = new URLSearchParams(fragment).get("d");
    if (!payload) {
      throw new Error(
        "no design payload in the link — a RapidCAM share URL carries the design in its " +
          "#d=… fragment (File ▸ Copy Share Link). Note: quote the URL in a shell, or the " +
          "shell strips everything after the #.",
      );
    }
    return payload;
  }
  // Bare "d=…" or the raw payload itself. A base64url payload never contains
  // "=", so an "=" means key=value form.
  if (s.includes("=")) {
    const payload = new URLSearchParams(s).get("d");
    if (!payload) throw new Error("no d=… design payload found in the input");
    return payload;
  }
  return s;
}

/**
 * Decode a share URL (or bare `d=…` / raw payload) into pretty-printed .rcam
 * JSON. Throws with a clear message when there is no `d=` payload or the
 * payload's codec marker is unknown.
 */
export async function decodeShareUrl(urlOrPayload: string): Promise<string> {
  const file = await decodeDesign(extractPayload(urlOrPayload));
  return JSON.stringify(file, null, 2);
}
