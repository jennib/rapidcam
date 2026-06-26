import { type LaserPost, scaledPower } from "./base";

/**
 * GRBL / FluidNC laser with **M4 dynamic power** — the beam power scales with the
 * actual feed, so acceleration, deceleration, and corners don't over-burn. The
 * default and recommended head for diode/CO2 lasers on GRBL-class controllers.
 * Power is `S 0–$30` (default max 1000); GRBL laser mode (`$32=1`) makes `G0`
 * rapids travel with the beam off.
 */
export const GRBL_DYNAMIC: LaserPost = {
  id: "grbl-dynamic",
  name: "GRBL / FluidNC (M4 dynamic)",
  kerfCompensated: true,
  inlinePower: false,
  programStart: () => [
    "; Laser: GRBL/FluidNC — enable laser mode ($32=1) on the controller",
    "; M4 = dynamic power (scales with feed); G0 rapids travel with the beam off",
  ],
  formatPower: (percent, max = 1000) => scaledPower(percent, max),
  beamOn: (s) => [`M4 S${s} ; beam on (dynamic power)`],
  beamOff: () => ["M5 ; beam off"],
};
