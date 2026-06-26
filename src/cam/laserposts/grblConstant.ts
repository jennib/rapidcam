import { type LaserPost, scaledPower } from "./base";

/**
 * GRBL / FluidNC laser with **M3 constant power** — the beam holds the programmed
 * power regardless of feed. Preferred by some materials/workflows (and required
 * when laser mode is off), at the cost of over-burning on corners and ramps.
 * Power is `S 0–$30` (default max 1000).
 */
export const GRBL_CONSTANT: LaserPost = {
  id: "grbl-constant",
  name: "GRBL / FluidNC (M3 constant)",
  kerfCompensated: true,
  inlinePower: false,
  programStart: () => [
    "; Laser: GRBL/FluidNC — M3 constant power (beam holds power regardless of feed)",
    "; G0 rapids travel with the beam off",
  ],
  formatPower: (percent, max = 1000) => scaledPower(percent, max),
  beamOn: (s) => [`M3 S${s} ; beam on (constant power)`],
  beamOff: () => ["M5 ; beam off"],
};
