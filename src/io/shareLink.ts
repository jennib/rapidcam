/**
 * Shareable design links: encode the whole .rcam document into the URL hash so a
 * design can be shared with a single link — no server, no upload, no account.
 *
 * The payload lives in the URL *fragment* (`#d=…`), which browsers never send to
 * the server, so the design stays entirely client-side. It is gzip-compressed
 * (JSON compresses ~5-10×) and base64url-encoded. A one-char codec marker leads
 * the payload so a recipient can decode regardless of which browser produced it.
 */

import type { CADDocument } from "../model/document";
import { serializeDoc, normalizeRcam, type RcamFile } from "./fileio";

const HASH_KEY = "d";

/**
 * Links beyond this length get unreliable to paste into chat apps, forums, and
 * URL-shorteners. Past it we steer the user to the .rcam file instead. (The
 * browser itself tolerates far longer, but pasteability is the real limit.)
 */
export const MAX_LINK_LENGTH = 14000;

// --- base64url (chunked to dodge call-stack limits on large designs) ---------

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// --- gzip via the Compression Streams API ------------------------------------

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

// --- encode / decode ---------------------------------------------------------

/** Encode a file to a base64url payload: "g…" = gzip, "r…" = raw UTF-8 fallback. */
async function encodeDesign(file: RcamFile): Promise<string> {
  const json = JSON.stringify(file);
  if (typeof CompressionStream !== "undefined") {
    return "g" + bytesToBase64Url(await gzip(json));
  }
  return "r" + bytesToBase64Url(new TextEncoder().encode(json));
}

async function decodeDesign(payload: string): Promise<RcamFile> {
  const codec = payload[0];
  const bytes = base64UrlToBytes(payload.slice(1));
  let json: string;
  if (codec === "g") json = await gunzip(bytes);
  else if (codec === "r") json = new TextDecoder().decode(bytes);
  else throw new Error(`Unknown share-link codec "${codec}"`);
  return normalizeRcam(JSON.parse(json));
}

// --- public API --------------------------------------------------------------

/** Build a shareable link for the current document. `tooLong` warns callers to
 *  fall back to the .rcam file for designs that won't paste reliably. */
export async function buildDesignLink(
  doc: CADDocument,
  name: string,
): Promise<{ url: string; tooLong: boolean }> {
  const payload = await encodeDesign(serializeDoc(doc, name));
  const url = `${location.origin}${location.pathname}#${HASH_KEY}=${payload}`;
  return { url, tooLong: url.length > MAX_LINK_LENGTH };
}

/**
 * If the page was opened with a `#d=…` design link, decode it and return the
 * document. Clears the hash either way so a refresh doesn't reload it and the
 * address bar stays clean. Returns null when there's no link (the normal case).
 */
export async function consumeSharedDesign(): Promise<{ file: RcamFile; name: string } | null> {
  const raw = location.hash.replace(/^#/, "");
  const payload = new URLSearchParams(raw).get(HASH_KEY);
  if (!payload) return null;
  history.replaceState(null, "", location.pathname + location.search);
  try {
    const file = await decodeDesign(payload);
    return { file, name: file.name || "Shared design" };
  } catch (e) {
    console.error("Failed to decode shared design link:", e);
    alert("This RapidCAM share link is invalid or corrupted.");
    return null;
  }
}
