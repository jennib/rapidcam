/**
 * Open-in-GEditor handoff tests. Run with: npx vitest run test/geditor.test.ts
 *
 * The handoff is a window-to-window handshake, so the tests drive a fake `window`:
 * `open()` records the URL and hands back a fake child window, and the test then
 * plays the `GEDITOR_READY` message the real editor posts on mount. What's being
 * pinned down is the part that can silently misfire — that we're listening
 * *before* the window opens, that a program is only ever posted to the editor's
 * own origin and window, and that a failure resolves (so the caller can offer a
 * download) instead of hanging.
 */

import { test, expect, vi } from "vitest";
import {
  openInGeditor,
  GEDITOR_URL,
  type GeditorOpener,
  type GeditorWindow,
} from "../src/io/geditor";

const ORIGIN = new URL(GEDITOR_URL).origin;

interface Posted {
  message: unknown;
  targetOrigin: string;
}

/**
 * A fake `window`: records listeners and opened URLs, and lets a test deliver a
 * message as if it came from another page. `openReturnsNull` simulates a pop-up
 * blocker.
 */
function fakeOpener(opts: { openReturnsNull?: boolean } = {}) {
  const listeners: ((ev: MessageEvent) => void)[] = [];
  const opened: string[] = [];
  const posted: Posted[] = [];
  let focused = 0;
  /** Set when open() is called, so a test can prove the listener came first. */
  let listenersAtOpen = -1;

  const child: GeditorWindow = {
    postMessage: (message, targetOrigin) => posted.push({ message, targetOrigin }),
    focus: () => {
      focused++;
    },
  };

  const opener: GeditorOpener = {
    open: (url) => {
      opened.push(url);
      listenersAtOpen = listeners.length;
      return opts.openReturnsNull ? null : child;
    },
    addEventListener: (_type, fn) => {
      listeners.push(fn);
    },
    removeEventListener: (_type, fn) => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
  };

  /** Deliver a message event to every attached listener. */
  const deliver = (ev: { origin?: string; source?: unknown; data?: unknown }) => {
    // `in` rather than ??, so a test can deliver an explicitly null/empty payload
    // without it being replaced by the default READY.
    const full = {
      origin: ev.origin ?? ORIGIN,
      source: "source" in ev ? ev.source : child,
      data: "data" in ev ? ev.data : { type: "GEDITOR_READY" },
    } as unknown as MessageEvent;
    for (const fn of [...listeners]) fn(full);
  };

  return {
    opener,
    child,
    deliver,
    opened,
    posted,
    listeners,
    get focused() {
      return focused;
    },
    get listenersAtOpen() {
      return listenersAtOpen;
    },
  };
}

// --- happy path --------------------------------------------------------------
test("posts the program to the editor window once it announces itself", async () => {
  const w = fakeOpener();
  const p = openInGeditor("bracket_all_2026-08-08_101500.nc", "G21 G90\nM30\n", w.opener);

  // The editor posts GEDITOR_READY once, on mount: if we subscribed after
  // opening the window, that single message is gone and nothing is ever sent.
  expect(w.listenersAtOpen).toBe(1);

  w.deliver({});
  await expect(p).resolves.toEqual({ ok: true });

  expect(w.posted).toEqual([
    {
      message: {
        type: "LOAD_GCODE",
        gcode: "G21 G90\nM30\n",
        filename: "bracket_all_2026-08-08_101500.nc",
      },
      targetOrigin: ORIGIN,
    },
  ]);
  expect(w.focused).toBe(1);
  // The handshake is done — nothing left listening to fire a second time.
  expect(w.listeners).toHaveLength(0);
});

test("opens the published editor, carrying the file name", async () => {
  const w = fakeOpener();
  const p = openInGeditor("part one.nc", "M30\n", w.opener);
  w.deliver({});
  await p;

  const url = new URL(w.opened[0]);
  expect(url.origin + url.pathname).toBe(GEDITOR_URL);
  expect(url.searchParams.get("filename")).toBe("part one.nc");
});

test("each send gets a distinct URL, so a re-used tab really re-navigates", async () => {
  const w = fakeOpener();
  // Same file name twice: without a cache key the second open() would be a no-op
  // navigation, and the GEDITOR_READY we're waiting on would never arrive.
  for (let i = 0; i < 2; i++) {
    const p = openInGeditor("same.nc", "M30\n", w.opener);
    w.deliver({});
    await p;
  }
  expect(w.opened[0]).not.toBe(w.opened[1]);
});

// --- who we'll talk to -------------------------------------------------------
test("ignores a READY from another origin, and still accepts the editor's own", async () => {
  const w = fakeOpener();
  const p = openInGeditor("job.nc", "M30\n", w.opener);

  w.deliver({ origin: "https://evil.example" });
  expect(w.posted).toHaveLength(0);

  // Positive control: the same delivery from the editor's origin does send, so
  // the assertion above is about the origin check and not a dead handler.
  w.deliver({});
  await expect(p).resolves.toEqual({ ok: true });
  expect(w.posted).toHaveLength(1);
});

test("ignores a READY from a different window at the same origin", async () => {
  const w = fakeOpener();
  const p = openInGeditor("job.nc", "M30\n", w.opener);

  // An editor tab the user already had open would otherwise make us post the
  // program before our own tab is listening for it.
  w.deliver({ source: { postMessage: () => {} } });
  expect(w.posted).toHaveLength(0);

  w.deliver({});
  await expect(p).resolves.toEqual({ ok: true });
  expect(w.posted).toHaveLength(1);
});

test("ignores messages that aren't the READY announcement", async () => {
  const w = fakeOpener();
  const p = openInGeditor("job.nc", "M30\n", w.opener);

  w.deliver({ data: { type: "GCODE_SAVED", gcode: "M30" } });
  w.deliver({ data: null });
  w.deliver({ data: "GEDITOR_READY" });
  expect(w.posted).toHaveLength(0);

  w.deliver({});
  await expect(p).resolves.toEqual({ ok: true });
  expect(w.posted).toHaveLength(1);
});

// --- failure paths -----------------------------------------------------------
test("a blocked pop-up resolves with an explanation, not a hang", async () => {
  const w = fakeOpener({ openReturnsNull: true });
  const res = await openInGeditor("job.nc", "M30\n", w.opener);

  expect(res.ok).toBe(false);
  expect(res.hint).toBe("blocked");
  expect(res.error).toMatch(/pop-up/i);
  // Nothing left subscribed after we've given up.
  expect(w.listeners).toHaveLength(0);
});

test("gives up if the editor never announces itself", async () => {
  vi.useFakeTimers();
  try {
    const w = fakeOpener();
    const p = openInGeditor("job.nc", "M30\n", w.opener);
    await vi.advanceTimersByTimeAsync(60_000);

    const res = await p;
    expect(res.ok).toBe(false);
    expect(res.hint).toBe("no-handshake");
    expect(w.posted).toHaveLength(0);
    expect(w.listeners).toHaveLength(0);
  } finally {
    vi.useRealTimers();
  }
});

test("a late READY after the timeout can't still post the program", async () => {
  vi.useFakeTimers();
  try {
    const w = fakeOpener();
    const p = openInGeditor("job.nc", "M30\n", w.opener);
    await vi.advanceTimersByTimeAsync(60_000);
    await p;

    w.deliver({});
    expect(w.posted).toHaveLength(0);
  } finally {
    vi.useRealTimers();
  }
});

test("without a browser window there is nothing to open", async () => {
  const res = await openInGeditor("job.nc", "M30\n", undefined);
  expect(res.ok).toBe(false);
  expect(res.error).toBeTruthy();
});
