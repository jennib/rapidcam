import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Guards the privacy invariant that session replay (canvas-pixel capture) is a
 * separate, opt-in-only consent: allowing usage analytics must NOT enable
 * replay, and PostHog must be initialised with recording disabled unless the
 * user explicitly opted in. Regression test for the original bug where
 * `recordCanvas` was always on under a single "Allow analytics" consent.
 */

const initMock = vi.fn();
const phMock = {
  init: initMock,
  capture: vi.fn(),
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
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
}

const CONSENT = "rapidcam_analytics_consent";
const REPLAY = "rapidcam_analytics_replay_consent";

beforeEach(() => {
  vi.resetModules();
  initMock.mockClear();
  vi.stubGlobal("localStorage", fakeLocalStorage());
  // DNT off so init can run.
  vi.stubGlobal("navigator", { doNotTrack: "0" });
});

describe("analytics consent", () => {
  test("granting analytics does not enable replay by default", async () => {
    const a = await import("../src/analytics");
    await a.grantConsent();
    expect(a.getConsent()).toBe("granted");
    expect(a.getReplayConsent()).toBe("denied");
  });

  test("replay requires an explicit opt-in", async () => {
    const a = await import("../src/analytics");
    await a.grantConsent(true);
    expect(a.getConsent()).toBe("granted");
    expect(a.getReplayConsent()).toBe("granted");
  });

  test("declining clears both consents", async () => {
    const a = await import("../src/analytics");
    await a.grantConsent(true);
    await a.denyConsent();
    expect(a.getConsent()).toBe("denied");
    expect(a.getReplayConsent()).toBe("denied");
  });

  test("replay can never be granted without analytics", async () => {
    const a = await import("../src/analytics");
    await a.setConsentChoices(false, true);
    expect(a.getReplayConsent()).toBe("denied");
  });

  test("init disables session recording unless replay opted in", async () => {
    const a = await import("../src/analytics");
    localStorage.setItem(CONSENT, "granted"); // analytics only
    await a.initAnalytics();
    expect(initMock).toHaveBeenCalledTimes(1);
    expect(initMock.mock.calls[0][1].disable_session_recording).toBe(true);
  });

  test("init enables session recording when replay opted in", async () => {
    const a = await import("../src/analytics");
    localStorage.setItem(CONSENT, "granted");
    localStorage.setItem(REPLAY, "granted");
    await a.initAnalytics();
    expect(initMock.mock.calls[0][1].disable_session_recording).toBe(false);
  });

  test("Do Not Track stores the choice but never initialises", async () => {
    vi.stubGlobal("navigator", { doNotTrack: "1" });
    const a = await import("../src/analytics");
    await a.grantConsent(true);
    expect(initMock).not.toHaveBeenCalled();
  });
});
