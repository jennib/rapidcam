import { type LaserPost, scaledPower } from "./base";

/**
 * Marlin laser (the `LASER_FEATURE` spindle/laser support). Uses `M3 S…` to set
 * power and `M5` to stop. Marlin's default inline power scale is **0–255**
 * (`SPEED_POWER_*` / `CUTTER_POWER_UNIT`); override the max if your build is
 * configured for a different range.
 */
export const MARLIN: LaserPost = {
  id: "marlin",
  name: "Marlin (M3, 0–255)",
  kerfCompensated: true,
  inlinePower: false,
  programStart: () => [
    "; Laser: Marlin — M3 S sets power (0–255 by default; depends on your firmware config)",
  ],
  formatPower: (percent, max = 255) => scaledPower(percent, max),
  beamOn: (s) => [`M3 S${s} ; laser on`],
  beamOff: () => ["M5 ; laser off"],
};
