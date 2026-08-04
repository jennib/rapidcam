// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Covers exception capture, which is consent-gated on exactly the same terms as
 * usage analytics: a stack trace can name a file the user opened, so it is
 * analytics data and must never leave a browser that declined or has DNT set.
 *
 * The dedupe is load-bearing rather than cosmetic — the canvas render loop runs
 * at frame rate, so one bad entity throws ~60×/second. Without dedupe a single
 * bug becomes thousands of identical events. Each negative assertion below is
 * paired with a positive control, so "nothing was captured" can't pass simply
 * because the wiring is dead.
 */

const captureExceptionMock = vi.fn();
const phMock = {
  init: vi.fn(),
  capture: vi.fn(),
  captureException: captureExceptionMock,
  opt_in_capturing: vi.fn(),
  opt_out_capturing: vi.fn(),
  startSessionRecording: vi.fn(),
  stopSessionRecording: vi.fn(),
};
vi.mock("posthog-js", () => ({ default: phMock }));

function fakeLocalStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
}

const CONSENT = "rapidcam_analytics_consent";

beforeEach(() => {
  vi.resetModules();
  captureExceptionMock.mockClear();
  phMock.init.mockClear();
  vi.stubGlobal("localStorage", fakeLocalStorage());
  vi.stubGlobal("navigator", { doNotTrack: "0", maxTouchPoints: 0 });
});

describe("error capture consent gating", () => {
  test("captures nothing before consent is given", async () => {
    const a = await import("../src/analytics");
    a.captureError(new Error("boom"));
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  // Positive control for the test above: same call, consent granted, DOES capture.
  test("captures once analytics is granted", async () => {
    const a = await import("../src/analytics");
    await a.grantConsent();
    a.captureError(new Error("boom"));
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(captureExceptionMock.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  test("Do Not Track captures nothing even with consent stored", async () => {
    vi.stubGlobal("navigator", { doNotTrack: "1", maxTouchPoints: 0 });
    const a = await import("../src/analytics");
    await a.grantConsent();
    a.captureError(new Error("boom"));
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  test("a declined user's errors are dropped, not buffered for a later grant", async () => {
    const a = await import("../src/analytics");
    await a.denyConsent();
    a.captureError(new Error("while declined"));

    // Changing their mind must not retroactively ship what happened while off.
    await a.grantConsent();
    expect(captureExceptionMock).not.toHaveBeenCalled();

    // Positive control: errors AFTER the grant do flow.
    a.captureError(new Error("after grant"));
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  });
});

describe("startup buffering", () => {
  test("an error thrown while PostHog is still loading is flushed on init", async () => {
    const a = await import("../src/analytics");
    // Consent already stored from a previous session, but init hasn't run — the
    // exact window in which boot and draft-restore failures happen.
    localStorage.setItem(CONSENT, "granted");

    a.captureError(new Error("during boot"));
    expect(captureExceptionMock).not.toHaveBeenCalled();

    await a.initAnalytics();
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect((captureExceptionMock.mock.calls[0][0] as Error).message).toBe("during boot");
  });

  test("the buffer does not re-drop entries to its own dedupe", async () => {
    const a = await import("../src/analytics");
    localStorage.setItem(CONSENT, "granted");
    a.captureError(new Error("one"));
    a.captureError(new Error("two"));
    await a.initAnalytics();
    expect(captureExceptionMock).toHaveBeenCalledTimes(2);
  });
});

describe("dedupe", () => {
  test("the same error repeated at frame rate reports once", async () => {
    const a = await import("../src/analytics");
    await a.grantConsent();

    const throwIt = () => {
      throw new Error("render loop");
    };
    for (let i = 0; i < 60; i++) {
      try {
        throwIt();
      } catch (e) {
        a.captureError(e);
      }
    }
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  });

  test("distinct errors are each reported", async () => {
    const a = await import("../src/analytics");
    await a.grantConsent();
    a.captureError(new Error("first"));
    a.captureError(new Error("second"));
    expect(captureExceptionMock).toHaveBeenCalledTimes(2);
  });

  test("a bounded number of distinct errors is reported per session", async () => {
    const a = await import("../src/analytics");
    await a.grantConsent();
    for (let i = 0; i < 200; i++) a.captureError(new Error(`distinct ${i}`));
    // Capped, but not zero — the cap must not silence reporting altogether.
    expect(captureExceptionMock.mock.calls.length).toBeGreaterThan(0);
    expect(captureExceptionMock.mock.calls.length).toBeLessThanOrEqual(25);
  });
});

describe("global handlers", () => {
  /**
   * Each test gets a fresh window. `vi.resetModules()` hands every test its own
   * copy of the analytics module — with its own `errorCaptureInstalled` flag —
   * but happy-dom's window lives for the whole FILE, so without this the
   * listeners installed by earlier tests are still attached and fire too. That
   * is an artefact of module resetting, not a product bug: in the browser the
   * module is a singleton installed once per page load.
   */
  beforeEach(() => {
    vi.stubGlobal("window", new EventTarget() as unknown as Window & typeof globalThis);
  });

  test("an uncaught exception reaching the window is captured", async () => {
    const a = await import("../src/analytics");
    await a.grantConsent();
    a.installErrorCapture();

    window.dispatchEvent(new ErrorEvent("error", { error: new Error("uncaught") }));
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(captureExceptionMock.mock.calls[0][1]).toMatchObject({ source: "window.error" });
  });

  test("a failed resource load is not reported as a crash", async () => {
    const a = await import("../src/analytics");
    await a.grantConsent();
    a.installErrorCapture();

    // <img>/<script> load failures fire `error` with no exception object.
    window.dispatchEvent(new ErrorEvent("error", { message: "Failed to load image" }));
    expect(captureExceptionMock).not.toHaveBeenCalled();

    // Positive control: a real exception on the same listener still lands.
    window.dispatchEvent(new ErrorEvent("error", { error: new Error("real") }));
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  });

  test("installing twice does not double-report", async () => {
    const a = await import("../src/analytics");
    await a.grantConsent();
    a.installErrorCapture();
    a.installErrorCapture();

    window.dispatchEvent(new ErrorEvent("error", { error: new Error("once") }));
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  });
});
