/**
 * The machine profile — everything that describes *this computer's machine*
 * rather than a design. Stored in localStorage, never in a `.rcam`: a file is a
 * drawing, so it travels, and machine configuration does not. See
 * SETTINGS_MODEL.md.
 *
 * The custom G-code, coolant and sender entries always lived here and were
 * always right. The post-processor, tool changer and the two machine-ish rotary
 * fields used to sit on the document — which meant a shared design carried the
 * author's controller, and two adjacent checkboxes in one dialog wrote to two
 * different stores for no reason. They moved here for `.rcam` v3.
 *
 * Note `postProcessor` is per HEAD TYPE, not a single value: machine type is a
 * property of the design, so one flat post would meet a laser design with a mill
 * controller stored. Two fields, not a profile library.
 */

import { StorageKeys } from "./storageKeys";

const START_KEY = StorageKeys.gcodeCustomStart;
const END_KEY = StorageKeys.gcodeCustomEnd;
const HAS_COOLANT_KEY = StorageKeys.machineHasCoolant;
const GSENDER_URL_KEY = StorageKeys.gsenderUrl;
const NCSENDER_URL_KEY = StorageKeys.ncsenderUrl;
const SENDER_APP_KEY = StorageKeys.senderApp;
const POST_MILL_KEY = StorageKeys.postMill;
const POST_LASER_KEY = StorageKeys.postLaser;
const TOOL_CHANGER_KEY = StorageKeys.hasToolChanger;
const ROTARY_AXIS_WORD_KEY = StorageKeys.rotaryAxisWord;
const ARC_TOLERANCE_KEY = StorageKeys.rotaryArcTolerance;

/** Fallbacks when the profile has never been configured on this computer. */
export const DEFAULT_POST_MILL = "linuxcnc";
export const DEFAULT_POST_LASER = "grbl-dynamic";
/** Chord tolerance (mm) for flattening arcs into a rotary wrap. */
export const DEFAULT_ARC_TOLERANCE = 0.1;

/** Which rotary axis word this machine's 4th axis answers to. */
export type RotaryAxisWord = "A" | "B";

/** The post-processor for a given head. Mill and laser are stored separately. */
export function getPostFor(head: "mill" | "laser"): string {
  try {
    const raw = localStorage.getItem(head === "laser" ? POST_LASER_KEY : POST_MILL_KEY);
    if (raw) return raw;
  } catch {
    /* storage disabled — fall through to the default */
  }
  return head === "laser" ? DEFAULT_POST_LASER : DEFAULT_POST_MILL;
}

export function setPostFor(head: "mill" | "laser", id: string): void {
  try {
    localStorage.setItem(head === "laser" ? POST_LASER_KEY : POST_MILL_KEY, id);
  } catch {
    /* private mode / storage disabled — preference simply doesn't persist */
  }
}

/** Whether the machine has an automatic tool changer (emit T/M6 rather than M0). */
export function getHasToolChanger(): boolean {
  try {
    return localStorage.getItem(TOOL_CHANGER_KEY) === "1";
  } catch {
    return false;
  }
}

export function setHasToolChanger(v: boolean): void {
  try {
    if (v) localStorage.setItem(TOOL_CHANGER_KEY, "1");
    else localStorage.removeItem(TOOL_CHANGER_KEY);
  } catch {
    /* private mode / storage disabled — preference simply doesn't persist */
  }
}

export function getRotaryAxisWord(): RotaryAxisWord {
  try {
    // Validate rather than cast — localStorage is external input.
    return localStorage.getItem(ROTARY_AXIS_WORD_KEY) === "B" ? "B" : "A";
  } catch {
    return "A";
  }
}

export function setRotaryAxisWord(w: RotaryAxisWord): void {
  try {
    if (w === "B") localStorage.setItem(ROTARY_AXIS_WORD_KEY, "B");
    else localStorage.removeItem(ROTARY_AXIS_WORD_KEY);
  } catch {
    /* private mode / storage disabled — preference simply doesn't persist */
  }
}

export function getArcTolerance(): number {
  try {
    const n = Number(localStorage.getItem(ARC_TOLERANCE_KEY));
    // Reject 0, negatives and NaN — a non-positive tolerance would divide badly.
    if (Number.isFinite(n) && n > 0) return n;
  } catch {
    /* storage disabled — fall through to the default */
  }
  return DEFAULT_ARC_TOLERANCE;
}

export function setArcTolerance(mm: number): void {
  try {
    if (Number.isFinite(mm) && mm > 0 && mm !== DEFAULT_ARC_TOLERANCE) {
      localStorage.setItem(ARC_TOLERANCE_KEY, String(mm));
    } else localStorage.removeItem(ARC_TOLERANCE_KEY);
  } catch {
    /* private mode / storage disabled — preference simply doesn't persist */
  }
}

/** Where gSender's server listens for the "Send to gSender" handoff. On the same
 *  machine this is localhost:8000 (gSender's default when Remote/Wireless Control
 *  is enabled); on a shop network it's the LAN address gSender shows you. */
export const DEFAULT_GSENDER_URL = "http://localhost:8000";

/** Where ncSender listens for G-code uploads. */
export const DEFAULT_NCSENDER_URL = "http://localhost:8090";

export type SenderApp = "gSender" | "ncSender" | "ask";

export interface CustomGcode {
  /** Lines injected once near the top of the program (after G21/G90/G17). */
  start: string;
  /** Lines injected at the end of the program (after M5, before M30). */
  end: string;
}

export function getCustomGcode(): CustomGcode {
  try {
    return {
      start: localStorage.getItem(START_KEY) ?? "",
      end: localStorage.getItem(END_KEY) ?? "",
    };
  } catch {
    return { start: "", end: "" };
  }
}

/**
 * Whether this machine has coolant. A machine capability (not a per-design
 * setting), so it lives here, not in the .rcam file. Default false — assume no
 * coolant unless the operator says otherwise, so non-coolant machines are never
 * prompted with coolant options. Gates both the coolant UI and G-code emission.
 */
export function getMachineHasCoolant(): boolean {
  try {
    return localStorage.getItem(HAS_COOLANT_KEY) === "1";
  } catch {
    return false;
  }
}

export function setMachineHasCoolant(v: boolean): void {
  try {
    if (v) localStorage.setItem(HAS_COOLANT_KEY, "1");
    else localStorage.removeItem(HAS_COOLANT_KEY);
  } catch {
    /* private mode / storage disabled — preference simply doesn't persist */
  }
}

/** The configured gSender address, or the localhost default when unset. */
export function getGsenderUrl(): string {
  try {
    return localStorage.getItem(GSENDER_URL_KEY) || DEFAULT_GSENDER_URL;
  } catch {
    return DEFAULT_GSENDER_URL;
  }
}

export function setGsenderUrl(url: string): void {
  try {
    const v = url.trim();
    // Store only a non-default override; clearing/matching the default tidies up.
    if (v && v !== DEFAULT_GSENDER_URL) localStorage.setItem(GSENDER_URL_KEY, v);
    else localStorage.removeItem(GSENDER_URL_KEY);
  } catch {
    /* private mode / storage disabled — preference simply doesn't persist */
  }
}

export function getNcsenderUrl(): string {
  try {
    return localStorage.getItem(NCSENDER_URL_KEY) || DEFAULT_NCSENDER_URL;
  } catch {
    return DEFAULT_NCSENDER_URL;
  }
}

export function setNcsenderUrl(url: string): void {
  try {
    const v = url.trim();
    if (v && v !== DEFAULT_NCSENDER_URL) localStorage.setItem(NCSENDER_URL_KEY, v);
    else localStorage.removeItem(NCSENDER_URL_KEY);
  } catch {
    /* private mode / storage disabled — preference simply doesn't persist */
  }
}

export function getSenderApp(): SenderApp {
  try {
    // Validate rather than blindly cast: localStorage is external input and could
    // hold a stale/garbage value from an older build. Anything unrecognized → "ask".
    const raw = localStorage.getItem(SENDER_APP_KEY);
    return raw === "gSender" || raw === "ncSender" ? raw : "ask";
  } catch {
    return "ask";
  }
}

export function setSenderApp(app: SenderApp): void {
  try {
    if (app && app !== "ask") localStorage.setItem(SENDER_APP_KEY, app);
    else localStorage.removeItem(SENDER_APP_KEY);
  } catch {
    /* private mode / storage disabled — preference simply doesn't persist */
  }
}

export function setCustomGcode(g: CustomGcode): void {
  try {
    // Trim surrounding whitespace/newlines so we don't accumulate blank lines, and
    // treat empty as "remove" to keep storage tidy.
    const start = g.start.trim();
    const end = g.end.trim();
    if (start) localStorage.setItem(START_KEY, start);
    else localStorage.removeItem(START_KEY);
    if (end) localStorage.setItem(END_KEY, end);
    else localStorage.removeItem(END_KEY);
  } catch {
    /* private mode / storage disabled — preference simply doesn't persist */
  }
}
