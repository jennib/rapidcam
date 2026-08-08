/**
 * "Open in GEditor" — hand a generated program to the browser-based G-code editor
 * and 3D simulator at editor.rapidcam.app, so the operator can read, tweak and
 * backplot it before it ever reaches a controller.
 *
 * Unlike gSender/ncSender this is not a local HTTP server, so the handoff is
 * window-to-window rather than a fetch:
 *
 *   1. listen for `message` BEFORE opening the window — GEditor announces itself
 *      with a single `GEDITOR_READY` post when it mounts, and there is no second
 *      one to catch if we're late;
 *   2. `window.open` the editor (its `window.opener` is what it replies through,
 *      so never open this with `noopener`);
 *   3. on `GEDITOR_READY` from the editor's origin, post `LOAD_GCODE`.
 *
 * Why not put the program in the URL? GEditor also accepts `?base64=` / `#base64=`,
 * which needs no handshake — but every browser caps URL length at its own
 * undocumented figure, and a relief-engrave program runs to megabytes. An
 * over-long URL fails by *truncation*, which would hand a machine a program that
 * ends mid-cut and looks complete. postMessage has no size limit, so it is the
 * only transport used here.
 */

/** The published editor. */
export const GEDITOR_URL = "https://editor.rapidcam.app/";

/** The one origin we accept a READY from, and the only one we post a program to. */
const GEDITOR_ORIGIN = new URL(GEDITOR_URL).origin;

/**
 * Named target, so a second send re-uses the same tab instead of littering the
 * browser with editors.
 */
const WINDOW_TARGET = "rapidcam-geditor";

/**
 * How long to wait for the editor to load and say hello. Generous on purpose:
 * this is a cold load of a Monaco + Three.js app over whatever connection the
 * workshop has, and a premature "it failed" would send the operator chasing a
 * problem that doesn't exist.
 */
const READY_TIMEOUT_MS = 20_000;

export interface GeditorOpenResult {
  ok: boolean;
  /** User-facing explanation on failure. */
  error?: string;
  /** Coarse failure class for the caller's UX. */
  hint?: "blocked" | "no-handshake";
}

/** The slice of the opened window this module uses. */
export interface GeditorWindow {
  postMessage(message: unknown, targetOrigin: string): void;
  focus?(): void;
}

/** The slice of `window` this module uses — injectable so tests can drive the handshake. */
export interface GeditorOpener {
  open(url: string, target: string): GeditorWindow | null;
  addEventListener(type: "message", listener: (ev: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (ev: MessageEvent) => void): void;
}

/**
 * Distinct per call. Re-using a named window only produces a fresh
 * `GEDITOR_READY` if the browser actually navigates it, and it won't navigate to
 * the URL it is already showing — so two sends of the same file name would leave
 * the second one waiting for a handshake that never comes. GEditor ignores
 * parameters it doesn't know.
 */
let sendSeq = 0;
function cacheKey(): string {
  return `${Date.now().toString(36)}${(++sendSeq).toString(36)}`;
}

const BLOCKED_MSG =
  "Your browser blocked the pop-up for the G-code editor. Allow pop-ups for this site, then try again.";

const NO_HANDSHAKE_MSG =
  `The editor at ${GEDITOR_ORIGIN} didn't finish loading in time, so the program wasn't ` +
  `handed over. Check your connection and try again — the tab it opened is safe to close.`;

/**
 * Open `gcode` in GEditor. Resolves `ok: true` once the program has been posted
 * to the editor window. On failure, `ok: false` with a user-facing `error` and a
 * coarse `hint`, so the caller can fall back to a plain file download.
 */
export async function openInGeditor(
  name: string,
  gcode: string,
  opener: GeditorOpener | undefined = typeof window === "undefined" ? undefined : window,
): Promise<GeditorOpenResult> {
  if (!opener) {
    return { ok: false, hint: "blocked", error: "No browser window available to open the editor." };
  }

  const url = `${GEDITOR_URL}?filename=${encodeURIComponent(name)}&t=${cacheKey()}`;

  return new Promise<GeditorOpenResult>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const stopListening = () => {
      if (timer !== undefined) clearTimeout(timer);
      opener.removeEventListener("message", onMessage);
    };

    function onMessage(ev: MessageEvent): void {
      // Origin is the security check: this window hears every page's messages,
      // and the program below is about to be handed to whoever sent this one.
      if (ev.origin !== GEDITOR_ORIGIN) return;
      // ...and `source` narrows it to *our* editor tab, so an editor the user
      // already had open elsewhere can't make us post before ours is listening.
      if (ev.source !== (child as unknown as MessageEventSource)) return;
      if ((ev.data as { type?: unknown } | null | undefined)?.type !== "GEDITOR_READY") return;
      stopListening();
      child?.postMessage({ type: "LOAD_GCODE", gcode, filename: name }, GEDITOR_ORIGIN);
      resolve({ ok: true });
    }

    // Attached before open() — see the handshake note at the top of the file.
    opener.addEventListener("message", onMessage);

    const child = opener.open(url, WINDOW_TARGET);
    if (!child) {
      stopListening();
      resolve({ ok: false, hint: "blocked", error: BLOCKED_MSG });
      return;
    }
    // A re-used tab is already open but may be behind this one.
    child.focus?.();

    timer = setTimeout(() => {
      stopListening();
      resolve({ ok: false, hint: "no-handshake", error: NO_HANDSHAKE_MSG });
    }, READY_TIMEOUT_MS);
  });
}
