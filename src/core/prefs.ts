/**
 * Machine-wide user preferences (localStorage). Unlike `.rcam` document
 * settings, these are NOT part of a design — they apply to every project opened
 * on this computer. Currently: custom G-code injected at the start/end of every
 * generated program (e.g. a shop's standard safe-start block or end ritual).
 */

const START_KEY = "rapidcam:gcode:customStart";
const END_KEY = "rapidcam:gcode:customEnd";
const HAS_COOLANT_KEY = "rapidcam:machine:hasCoolant";

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

export function setCustomGcode(g: CustomGcode): void {
  try {
    // Trim trailing whitespace/newlines so we don't accumulate blank lines, and
    // treat empty as "remove" to keep storage tidy.
    const start = g.start.replace(/\s+$/, "");
    const end = g.end.replace(/\s+$/, "");
    if (start) localStorage.setItem(START_KEY, start);
    else localStorage.removeItem(START_KEY);
    if (end) localStorage.setItem(END_KEY, end);
    else localStorage.removeItem(END_KEY);
  } catch {
    /* private mode / storage disabled — preference simply doesn't persist */
  }
}
