/**
 * A "cutting head" is the fixed-Z, no-plunge end of the tool family: a beam or
 * jet that traces XY contours with the work held at a single focus/standoff
 * height. Milling lives in gcode.ts (spindle + Z); everything here is the other
 * branch — laser today, with waterjet/plasma designed to slot in as additional
 * profiles without touching the path generator (lasergcode.ts).
 *
 * The members capture only what differs between heads. The XY motion itself
 * (G0 travels, G1/G2/G3 cuts) is identical across heads and lives in the
 * generator, which calls these to wrap each operation.
 *
 * What a future waterjet/plasma head would add on top of laser:
 *   - `pierce()` returns a real pierce step (a `G4` dwell, optionally at reduced
 *     pressure) emitted at the start of each cut; laser pierces instantly so it
 *     returns nothing.
 *   - `beamOn`/`beamOff` map to `M3`/`M5` or digital outputs (`M64`/`M65`)
 *     instead of GRBL's dynamic-power `M4`.
 *   - `kerfCompensated` stays true (kerf matters even more), and lead-in/out
 *     (already in the op model) becomes mandatory so the pierce sits off the part.
 */
export interface CuttingHead {
  readonly name: string;
  /**
   * Whether closed profiles should be kerf-compensated (offset by half the op's
   * kerf width). True for every jet/beam; the actual offset is 0 when the op's
   * kerf width is 0, so "cut on the line" still works.
   */
  readonly kerfCompensated: boolean;
  /** Comment/setup lines emitted once at program start, after G21/G90/G17. */
  programStart(): string[];
  /**
   * Modal "beam on" command, emitted once per operation at the given `S` power.
   * In GRBL laser mode this also relies on motion mode for gating: `G0` travels
   * keep the beam off, `G1/G2/G3` cuts fire it at `S`.
   */
  beamOn(s: number): string;
  /** "Beam off" command, emitted at the end of each operation. */
  beamOff(): string;
  /**
   * Optional pierce step emitted before a cut begins (waterjet/plasma). Laser
   * pierces instantly, so it returns nothing.
   */
  pierce?(): string[];
}

/**
 * GRBL/FluidNC laser head. Uses `M4` dynamic power (the beam scales with actual
 * feed, so accel/decel and corners don't over-burn) and relies on GRBL laser
 * mode (`$32=1`) so `G0` rapids travel with the beam off.
 */
export const LASER_HEAD: CuttingHead = {
  name: "laser",
  kerfCompensated: true,
  programStart: () => [
    "; Laser output — enable GRBL laser mode ($32=1) on the controller",
    "; G0 rapids travel with the beam off; G1/G2/G3 cut at the programmed S power",
  ],
  beamOn: (s) => `M4 S${s} ; beam on (dynamic power)`,
  beamOff: () => "M5 ; beam off",
};
