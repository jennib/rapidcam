/**
 * Send-to-gSender client tests. Run with: npx vitest run test/gsender.test.ts
 *
 * The client is exercised against a scripted fake `fetch` (no gSender needed):
 * each test maps request URLs to canned Responses and asserts the client's
 * decisions (port discovery, load payload, error classification).
 */

import { test, expect } from "vitest";
import { normalizeGsenderUrl, sendToGsender, testGsenderConnection, type FetchLike } from "../src/io/gsender";

/** Build a fake fetch from a URL→handler map. Records the calls it receives. */
function fakeFetch(routes: Record<string, (init?: RequestInit) => Partial<Response> & { _json?: unknown }>): {
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

// --- happy path --------------------------------------------------------------
test("sendToGsender signs in, discovers the port, and posts the program", async () => {
  const { fetch, calls } = fakeFetch({
    "/api/signin": () => ({ _json: { token: "tok123" } }),
    "/api/controllers": () => ({ _json: [{ port: "COM3", state: "Idle" }] }),
    "/api/gcode": () => ({ _json: { name: "part.nc" } }),
  });
  const res = await sendToGsender("localhost:8000", "part.nc", "G0 X0\nM30", fetch);
  expect(res.ok).toBe(true);
  expect(res.port).toBe("COM3");

  const load = calls.find((c) => c.url.endsWith("/api/gcode"))!;
  expect(load.init?.method).toBe("POST");
  const body = JSON.parse(load.init!.body as string);
  expect(body).toEqual({ port: "COM3", name: "part.nc", gcode: "G0 X0\nM30" });
  // The token from signin is forwarded as a bearer.
  expect((load.init!.headers as Record<string, string>).Authorization).toBe("Bearer tok123");
});

test("works even when signin returns no token (auth bypassed) — no Authorization header", async () => {
  const { fetch, calls } = fakeFetch({
    "/api/signin": () => ({ ok: false, status: 404 }),
    "/api/controllers": () => ({ _json: [{ port: "/dev/ttyUSB0" }] }),
    "/api/gcode": () => ({ _json: {} }),
  });
  const res = await sendToGsender("localhost:8000", "j.nc", "G0", fetch);
  expect(res.ok).toBe(true);
  const load = calls.find((c) => c.url.endsWith("/api/gcode"))!;
  expect((load.init!.headers as Record<string, string>).Authorization).toBeUndefined();
});

// --- no machine connected ----------------------------------------------------
test("reports no-controller when gSender is up but nothing is connected", async () => {
  const { fetch } = fakeFetch({
    "/api/signin": () => ({ _json: { token: "t" } }),
    "/api/controllers": () => ({ _json: [] }),
  });
  const res = await sendToGsender("localhost:8000", "j.nc", "G0", fetch);
  expect(res.ok).toBe(false);
  expect(res.hint).toBe("no-controller");
  expect(res.error).toMatch(/no CNC is connected/i);
});

// --- unreachable -------------------------------------------------------------
test("classifies a network failure as unreachable", async () => {
  const { fetch } = fakeFetch({}); // every request throws
  const res = await sendToGsender("localhost:8000", "j.nc", "G0", fetch);
  expect(res.ok).toBe(false);
  expect(res.hint).toBe("unreachable");
  expect(res.error).toMatch(/Couldn't reach gSender/i);
});

// --- load rejected -----------------------------------------------------------
test("surfaces gSender's message when the load is rejected", async () => {
  const { fetch } = fakeFetch({
    "/api/signin": () => ({ _json: { token: "t" } }),
    "/api/controllers": () => ({ _json: [{ port: "COM3" }] }),
    "/api/gcode": () => ({ ok: false, status: 400, _json: { msg: "Controller not found" } }),
  });
  const res = await sendToGsender("localhost:8000", "j.nc", "G0", fetch);
  expect(res.ok).toBe(false);
  expect(res.hint).toBe("rejected");
  expect(res.error).toMatch(/Controller not found/);
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
