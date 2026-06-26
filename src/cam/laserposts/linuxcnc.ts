import { type LaserPost, scaledPower } from "./base";

/**
 * LinuxCNC laser driven as a **PWM "spindle"** — the most portable LinuxCNC laser
 * setup: the beam is wired to the spindle PWM output, so `M3 S…` sets power and
 * `M5` stops, with `S` scaled to the configured max (`[SPINDLE]MAX_*`, commonly
 * 1000). Shops that instead gate the beam through **digital outputs**
 * (`M64`/`M65` on/off, `M67`/`M68` for analog power) should copy this file and
 * adapt `beamOn`/`beamOff` — that wiring needs explicit on/off around every cut
 * and travel, which this PWM head avoids.
 */
export const LINUXCNC_LASER: LaserPost = {
  id: "linuxcnc-laser",
  name: "LinuxCNC (PWM spindle)",
  kerfCompensated: true,
  inlinePower: false,
  programStart: () => [
    "; Laser: LinuxCNC — beam driven as a PWM spindle (M3/M5 + S).",
    "; Digital-output setups (M64/M65 on/off, M67/M68 analog power) need a custom post.",
  ],
  formatPower: (percent, max = 1000) => scaledPower(percent, max),
  beamOn: (s) => [`M3 S${s} ; laser on (PWM spindle)`],
  beamOff: () => ["M5 ; laser off"],
};
