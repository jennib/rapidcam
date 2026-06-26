import { type LaserPost, fractionalPower } from "./base";

/**
 * Smoothieware laser. Unlike GRBL/Marlin, Smoothie takes power as an **inline
 * `S` value (0–1 fraction) on each cutting move** rather than a modal command —
 * so `inlinePower` is true and the generator appends ` S<frac>` to every
 * G1/G2/G3 cut. `G0` rapids carry no `S`, so travel happens with the beam off.
 * `M5` is emitted at the end as a safety stop.
 */
export const SMOOTHIE: LaserPost = {
  id: "smoothie",
  name: "Smoothieware (inline S 0–1)",
  kerfCompensated: true,
  inlinePower: true,
  programStart: () => [
    "; Laser: Smoothieware — power is the inline S (0–1) on each G1/G2/G3 cut move",
    "; G0 rapids carry no S, so travel runs with the beam off",
  ],
  formatPower: (percent) => fractionalPower(percent),
  beamOn: () => [], // power rides on each cut move (inlinePower)
  beamOff: () => ["M5 ; laser off"],
};
