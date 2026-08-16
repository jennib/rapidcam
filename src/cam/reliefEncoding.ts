/**
 * What a relief op's image BYTES mean — the one place that decides it.
 *
 * Four consumers rasterise a relief: `reliefImage` and `reliefRoughImage` post the
 * G-code, `rasRelief` and `rasReliefRough` simulate it for the 3-D preview. Each
 * of them built its own `rasterField` parameter block, so one fact — how this
 * image converts to depth — was already written out four times before STL added
 * anything to it. That is this project's standing defect class, and the relief
 * path states the consequence in its own doc comment:
 *
 * > "The op's depth / gamma / invert / flip should MATCH the finish op or the left
 * > allowance won't be uniform; they're exposed on both ops for that reason."
 *
 * So the parameters are resolved HERE, from the entity and the op, and the four
 * consumers ask rather than restate. A rough pass and its finish pass cannot
 * disagree about the encoding, because neither of them owns it.
 *
 * ## A height map is not a photograph
 *
 * Every tone control in the raster path exists to make a picture read well, and
 * each is a geometry error on bytes that are already lengths:
 *
 * - **`gamma`** bends the depth curve. A dome becomes a different dome, silently.
 * - **`whiteThreshold`** defaults to 0.96, blanking bytes ≥ ~245 so a photo's
 *   background isn't scorched. On a height map it FLATTENS THE TOP 4% OF THE
 *   MODEL'S HEIGHT RANGE — 1 mm off a 25 mm model, with no error anywhere.
 * - **`tone: "linear"`** converts out of sRGB for halftone AREA COVERAGE. A
 *   height byte is a length; linear light is meaningless on it.
 * - **halftoning** reinterprets the field as a V-groove screen, and (via
 *   {@link isHalftone}) also switches off the tool-footprint gouge correction the
 *   model needs most.
 *
 * The last one is enforced by handing every consumer the op AS IT APPLIES to this
 * image, with `halftone` cleared. `reliefSpacing` and `toolContactField` then see
 * the truth through the predicate they already use, and neither needed changing.
 */

import { heightfieldMeta, type HeightfieldMeta } from "../core/imageManager";
import type { RasterImageEntity } from "../model/entities";
import type { RasterFieldParams } from "./rasterEngrave";
import type { CAMOperation } from "./types";

/**
 * The white threshold for a height map: above 1, so nothing is ever blanked.
 *
 * `rasterField` blanks a dot when `value >= whiteThreshold`, and values are
 * 0..1 — so any figure over 1 disables the test outright. It must be disabled
 * rather than merely raised, because the top of a model is exactly the byte 255
 * that the photo default throws away.
 */
export const HEIGHTFIELD_WHITE_THRESHOLD = 1.01;

/** How an image's bytes become cut depth, resolved once per (entity, op). */
export interface ReliefEncoding {
  /**
   * The op as it actually applies to this image. Pass THIS to `reliefSpacing`
   * and `toolContactField` — on a height map its `halftone` flag is cleared.
   */
  op: CAMOperation;
  /** Non-null when the bytes are heights rather than tones. */
  heightfield: HeightfieldMeta | null;
  /**
   * `rasterField` parameters at the given row/dot pitch. `tone` is what the
   * caller's spacing resolver chose; a height map overrides it back to
   * `"encoded"`, along with gamma and the white threshold.
   */
  field(
    lineIntervalMM: number,
    dotPitchMM?: number,
    tone?: "encoded" | "linear",
  ): RasterFieldParams;
}

/** Resolve how this entity's image converts to depth under this op. */
export function reliefEncodingFor(ent: RasterImageEntity, op: CAMOperation): ReliefEncoding {
  const heightfield = heightfieldMeta(ent.imageId);
  // Clearing the flag rather than special-casing downstream: `isHalftone` is the
  // predicate both `reliefSpacing` and `toolContactField` screen on, so an op
  // that says it isn't halftoning is treated as not halftoning by every one of
  // them — including the gouge correction, which a height map must keep.
  const resolved = heightfield && op.halftone ? { ...op, halftone: false } : op;

  return {
    op: resolved,
    heightfield,
    field(lineIntervalMM, dotPitchMM, tone) {
      const params: RasterFieldParams = {
        widthMM: ent.widthMM,
        heightMM: ent.heightMM,
        lineIntervalMM,
        dotPitchMM,
        tone,
        invert: resolved.rasterInvert,
        gamma: resolved.reliefGamma,
        flipX: ent.flipX,
        flipY: ent.flipY,
      };
      if (!heightfield) return params;
      return {
        ...params,
        gamma: 1,
        tone: "encoded",
        whiteThreshold: HEIGHTFIELD_WHITE_THRESHOLD,
      };
    },
  };
}
