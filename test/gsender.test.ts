/**
 * Send-to-gSender client tests. Run with: npx vitest run test/gsender.test.ts
 *
 * The client is exercised against a scripted fake `fetch` (no gSender needed):
 * each test maps request URLs to canned Responses and asserts the client's
 * decisions (port discovery, load payload, error classification).
 */

import { test, expect } from "vitest";
import {
  normalizeGsenderUrl,
  sendToGsender,
  testGsenderConnection,
  type FetchLike,
} from "../src/io/gsender";

/** Build a fake fetch from a URL→handler map. Records the calls it receives. */
function fakeFetch(
  routes: Record<string, (init?: RequestInit) => Partial<Response> & { _json?: unknown }>,
): {
  fetch: FetchLike;
  calls: { url: string; init?: RequestInit }[];
} {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const key = Object.keys(routes).find((k) => url.endsWith(k));
    if (!key) throw new TypeError("Failed to fetch"); // unrouted = network error
    const r = routes[key](init);
    const json = r._json;
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      json: async () => json,
      text: async () => JSON.stringify(json),
    } as Response;
  };
  return { fetch, calls };
}

// --- URL normalization -------------------------------------------------------
test("normalizeGsenderUrl defaults scheme and trims trailing slash", () => {
  expect(normalizeGsenderUrl("localhost:8000")).toBe("http://localhost:8000");
  expect(normalizeGsenderUrl(" http://192.168.1.5:8000/ ")).toBe("http://192.168.1.5:8000");
  expect(normalizeGsenderUrl("https://host:8000//")).toBe("https://host:8000");
  expect(normalizeGsenderUrl("")).toBe("");
});

/** Read a multipart FormData field as text (the `gcode` part is a Blob). */
async function formText(body: unknown, field: string): Promise<string | null> {
  const fd = body as FormData;
  const v = fd.get(field);
  if (v == null) return null;
  return typeof v === "string" ? v : await (v as Blob).text();
}

// --- happy path (machine connected) -----------------------------------------
test("sendToGsender signs in, discovers the port, and posts the program to /api/file", async () => {
  const { fetch, calls } = fakeFetch({
    "/api/signin": () => ({ _json: { token: "tok123" } }),
    "/api/controllers": () => ({ _json: [{ port: "COM3", workflow: { state: "idle" } }] }),
    "/api/file": () => ({ _json: { msg: "Successfully loaded file" } }),
  });
  const res = await sendToGsender("localhost:8000", "part.nc", "G0 X0\nM30", fetch);
  expect(res.ok).toBe(true);
  expect(res.port).toBe("COM3");

  const load = calls.find((c) => c.url.endsWith("/api/file"))!;
  expect(load.init?.method).toBe("POST");
  expect(await formText(load.init!.body, "gcode")).toBe("G0 X0\nM30");
  expect(await formText(load.init!.body, "port")).toBe("COM3");
  // The token from signin is forwarded as a bearer; Content-Type is left to the
  // browser so it can set the multipart boundary.
  const headers = load.init!.headers as Record<string, string>;
  expect(headers.Authorization).toBe("Bearer tok123");
  expect(headers["Content-Type"]).toBeUndefined();
});

test("works even when signin returns no token (auth bypassed) — no Authorization header", async () => {
  const { fetch, calls } = fakeFetch({
    "/api/signin": () => ({ ok: false, status: 404 }),
    "/api/controllers": () => ({ _json: [{ port: "/dev/ttyUSB0" }] }),
    "/api/file": () => ({ _json: {} }),
  });
  const res = await sendToGsender("localhost:8000", "j.nc", "G0", fetch);
  expect(res.ok).toBe(true);
  const load = calls.find((c) => c.url.endsWith("/api/file"))!;
  expect((load.init!.headers as Record<string, string>).Authorization).toBeUndefined();
});

// --- no machine connected: STILL sends (loads into the workspace) ------------
test("sends successfully with no machine connected — file lands in gSender, no port", async () => {
  const { fetch, calls } = fakeFetch({
    "/api/signin": () => ({ _json: { token: "t" } }),
    "/api/controllers": () => ({ _json: [] }),
    "/api/file": () => ({ _json: { msg: "Successfully loaded file" } }),
  });
  const res = await sendToGsender("localhost:8000", "j.nc", "G0", fetch);
  expect(res.ok).toBe(true);
  expect(res.port).toBeUndefined();
  const load = calls.find((c) => c.url.endsWith("/api/file"))!;
  expect(load).toBeTruthy(); // it still posted the file
  expect(await formText(load.init!.body, "port")).toBeNull(); // with no port field
});

test("a controllers-list hiccup doesn't block the send (posts unconnected)", async () => {
  const { fetch, calls } = fakeFetch({
    "/api/signin": () => ({ _json: { token: "t" } }),
    "/api/controllers": () => ({ ok: false, status: 500 }),
    "/api/file": () => ({ _json: {} }),
  });
  const res = await sendToGsender("localhost:8000", "j.nc", "G0", fetch);
  expect(res.ok).toBe(true);
  expect(res.port).toBeUndefined();
  expect(calls.some((c) => c.url.endsWith("/api/file"))).toBe(true);
});

// --- busy: never load over a running/paused job ------------------------------
test("refuses to send while gSender is running a job (would reset the sender mid-cut)", async () => {
  const { fetch, calls } = fakeFetch({
    "/api/signin": () => ({ _json: { token: "t" } }),
    "/api/controllers": () => ({ _json: [{ port: "COM3", workflow: { state: "running" } }] }),
    "/api/file": () => ({ _json: {} }),
  });
  const res = await sendToGsender("localhost:8000", "j.nc", "G0", fetch);
  expect(res.ok).toBe(false);
  expect(res.hint).toBe("busy");
  expect(res.error).toMatch(/running a job/i);
  // Crucially, it must NOT have posted the file.
  expect(calls.some((c) => c.url.endsWith("/api/file"))).toBe(false);
});

test("also refuses while a job is paused", async () => {
  const { fetch } = fakeFetch({
    "/api/signin": () => ({ _json: { token: "t" } }),
    "/api/controllers": () => ({ _json: [{ port: "COM3", workflow: { state: "paused" } }] }),
    "/api/file": () => ({ _json: {} }),
  });
  const res = await sendToGsender("localhost:8000", "j.nc", "G0", fetch);
  expect(res.ok).toBe(false);
  expect(res.hint).toBe("busy");
});

// --- unreachable -------------------------------------------------------------
test("classifies a network failure as unreachable", async () => {
  const { fetch } = fakeFetch({}); // every request throws
  const res = await sendToGsender("localhost:8000", "j.nc", "G0", fetch);
  expect(res.ok).toBe(false);
  expect(res.hint).toBe("unreachable");
  expect(res.error).toMatch(/Couldn't reach gSender/i);
});

// --- mixed-content guidance (remote http address on an https page) -----------
test("adds mixed-content guidance for a remote http address served over https", async () => {
  const orig = (globalThis as { location?: unknown }).location;
  (globalThis as { location?: unknown }).location = { protocol: "https:" };
  try {
    const { fetch } = fakeFetch({}); // unreachable
    const res = await sendToGsender("http://192.168.1.42:8000", "j.nc", "G0", fetch);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Insecure content/i);
  } finally {
    (globalThis as { location?: unknown }).location = orig;
  }
});

test("no mixed-content guidance for a loopback address", async () => {
  const orig = (globalThis as { location?: unknown }).location;
  (globalThis as { location?: unknown }).location = { protocol: "https:" };
  try {
    const { fetch } = fakeFetch({});
    const res = await sendToGsender("http://localhost:8000", "j.nc", "G0", fetch);
    expect(res.error).not.toMatch(/Insecure content/i);
  } finally {
    (globalThis as { location?: unknown }).location = orig;
  }
});

// --- load rejected -----------------------------------------------------------
test("surfaces gSender's message when the load is rejected", async () => {
  const { fetch } = fakeFetch({
    "/api/signin": () => ({ _json: { token: "t" } }),
    "/api/controllers": () => ({ _json: [{ port: "COM3" }] }),
    "/api/file": () => ({ ok: false, status: 400, _json: { msg: "Bad file" } }),
  });
  const res = await sendToGsender("localhost:8000", "j.nc", "G0", fetch);
  expect(res.ok).toBe(false);
  expect(res.hint).toBe("rejected");
  expect(res.error).toMatch(/Bad file/);
});

// --- test connection ---------------------------------------------------------
test("testGsenderConnection returns the connected ports", async () => {
  const { fetch } = fakeFetch({
    "/api/signin": () => ({ _json: { token: "t" } }),
    "/api/controllers": () => ({ _json: [{ port: "COM3" }, { port: "COM7" }] }),
  });
  const res = await testGsenderConnection("localhost:8000", fetch);
  expect(res.ok).toBe(true);
  expect(res.ports).toEqual(["COM3", "COM7"]);
});

test("testGsenderConnection fails cleanly when unreachable", async () => {
  const { fetch } = fakeFetch({});
  const res = await testGsenderConnection("localhost:8000", fetch);
  expect(res.ok).toBe(false);
  expect(res.error).toMatch(/Couldn't reach gSender/i);
});
