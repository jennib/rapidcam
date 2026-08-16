/**
 * A height map is not a photograph.
 *
 * Each tone control below produces a WRONG DEPTH with no error message, which is
 * why every one of them gets a positive control showing the picture path still
 * behaves as it always did.
 */
import { describe, expect, test } from "vitest";
import { rasterField } from "../src/cam/rasterEngrave";
import { HEIGHTFIELD_WHITE_THRESHOLD, reliefEncodingFor } from "../src/cam/reliefEncoding";
import { DEFAULTS, type CAMOperation } from "../src/cam/types";
import { createInitialOpState } from "../src/ui/camBar/dialog/opDialogState";
import {
  getImageGrid,
  heightfieldMeta,
  registerEmbeddedImage,
  registerGrey,
  registerHeightfield,
} from "../src/core/imageManager";
import { applyFile, serializeDoc } from "../src/io/fileio";
import { CADDocument } from "../src/model/document";
import { RasterImageEntity } from "../src/model/entities";

const op = (over: Partial<CAMOperation> = {}): CAMOperation => ({
  id: "o",
  name: "relief",
  type: "engrave",
  entityIds: [],
  side: "outside",
  toolType: "ball-nose",
  toolNumber: 1,
  diameter: 3,
  feedrate: 1500,
  plungeRate: 300,
  spindleSpeed: 18000,
  safeZ: 5,
  depth: -3,
  stepdown: 3,
  stepover: 0.4,
  ...over,
});

const ent = (imageId: string) => new RasterImageEntity(imageId, { x: 0, y: 0 }, 10, 10, 0);

/** Bytes near white — the band the photo white-threshold throws away. */
const NEAR_WHITE = new Uint8Array([255, 252, 249, 246, 243, 240, 237, 234, 231, 228, 225, 222]);

describe("the identity of a height map", () => {
  test("the depth range is part of the id — identical pixels, different depths", () => {
    // A heightfield encodes RELATIVE to its own Z range, so the same STL imported
    // at 1x and at 2x is byte-identical. Content-hashing the pixels alone would
    // dedup them together and hand the second import the first one's carve depth.
    const px = new Uint8Array([0, 128, 255, 64]);
    const a = registerHeightfield("dome", 2, 2, px, { zRangeMM: 10 });
    const b = registerHeightfield("dome", 2, 2, px, { zRangeMM: 20 });
    expect(a).not.toBe(b);
    expect(heightfieldMeta(a)?.zRangeMM).toBe(10);
    expect(heightfieldMeta(b)?.zRangeMM).toBe(20);
    // Positive control: dedup still works when the depth matches too.
    expect(registerHeightfield("dome", 2, 2, px, { zRangeMM: 10 })).toBe(a);
  });

  test("a picture registered from the same bytes is not a height map", () => {
    const px = new Uint8Array([3, 9, 27, 81]);
    expect(heightfieldMeta(registerGrey("photo", 2, 2, px))).toBeNull();
    expect(heightfieldMeta(registerHeightfield("hf", 2, 2, px, { zRangeMM: 5 }))).not.toBeNull();
  });
});

describe("the encoding flags, which are silent when wrong", () => {
  const hfId = registerHeightfield("hf", 4, 3, NEAR_WHITE, { zRangeMM: 25 });
  const photoId = registerGrey("photo", 4, 3, NEAR_WHITE);

  test("a height map forces gamma 1, encoded tone and no white threshold", () => {
    const f = reliefEncodingFor(ent(hfId), op({ reliefGamma: 2.2 })).field(1, 1, "linear");
    expect(f.gamma).toBe(1);
    expect(f.tone).toBe("encoded");
    expect(f.whiteThreshold).toBe(HEIGHTFIELD_WHITE_THRESHOLD);
    expect(HEIGHTFIELD_WHITE_THRESHOLD).toBeGreaterThan(1); // i.e. disabled outright
  });

  test("a photograph keeps every one of them — the controls still work", () => {
    const f = reliefEncodingFor(ent(photoId), op({ reliefGamma: 2.2 })).field(1, 1, "linear");
    expect(f.gamma).toBe(2.2);
    expect(f.tone).toBe("linear");
    expect(f.whiteThreshold).toBeUndefined(); // rasterField's 0.96 default applies
  });

  test("the white threshold is the one that eats the top of the model", () => {
    // The whole point, measured: on a 25mm model the 0.96 default treats every
    // byte >= ~245 as blank, so the top 1mm of the height range carves flat.
    const hf = rasterField(getImageGrid(hfId)!, reliefEncodingFor(ent(hfId), op()).field(1, 1));
    const photo = rasterField(
      getImageGrid(photoId)!,
      reliefEncodingFor(ent(photoId), op()).field(1, 1),
    );
    const levels = (f: typeof hf) => f.rows.flatMap((r) => Array.from(r.levels));
    const depthMM = (lv: number) => lv * 25;

    // The height map grades all the way to the top byte.
    const hfLevels = levels(hf).filter((v) => v > 0);
    expect(hfLevels.length).toBeGreaterThan(8);

    // The photograph blanks the near-white band outright: those cells read level
    // 0 = "no cut", so a model top and a surface 1mm below it carve identically.
    const flattened = levels(photo).filter((v) => v === 0).length;
    expect(flattened).toBeGreaterThan(0);
    expect(levels(photo).filter((v) => v > 0).length).toBeLessThan(hfLevels.length);

    // And name the number the plan quotes, so it cannot drift unnoticed.
    const lostMM = depthMM(1 - 0.96);
    expect(lostMM).toBeCloseTo(1, 6);
  });

  test("halftoning is cleared on a height map, kept on a photograph", () => {
    const ht = op({ toolType: "v-bit", vAngle: 60, halftone: true });
    expect(reliefEncodingFor(ent(hfId), ht).op.halftone).toBe(false);
    expect(reliefEncodingFor(ent(photoId), ht).op.halftone).toBe(true);
    // The op object is only copied when something actually changes.
    expect(reliefEncodingFor(ent(photoId), ht).op).toBe(ht);
  });
});

describe("a rough pass and its finish pass cannot disagree", () => {
  test("both read the encoding from the image they share, not from their own fields", () => {
    const id = registerHeightfield("hf2", 4, 3, NEAR_WHITE, { zRangeMM: 25 });
    const e = ent(id);
    // Deliberately mismatched gamma on the two ops — the drift the relief path's
    // own doc comment warns about. On a height map neither is allowed to apply.
    const finish = reliefEncodingFor(e, op({ reliefGamma: 2.2 })).field(0.2, 0.2);
    const rough = reliefEncodingFor(e, op({ type: "engrave", reliefGamma: 0.5 })).field(1.2, 1.2);
    expect(finish.gamma).toBe(rough.gamma);
    expect(finish.whiteThreshold).toBe(rough.whiteThreshold);
    expect(finish.tone).toBe(rough.tone);
    expect(finish.flipX).toBe(rough.flipX);
  });
});

describe("the marker survives a save and reopen", () => {
  test("zRangeMM round-trips through .rcam", () => {
    const id = registerHeightfield("dome", 2, 2, new Uint8Array([0, 90, 180, 255]), {
      zRangeMM: 12.5,
    });
    const doc = new CADDocument({ width: 100, height: 100 });
    doc.add(new RasterImageEntity(id, { x: 5, y: 5 }, 40, 40, 0));

    const file = JSON.parse(JSON.stringify(serializeDoc(doc, "hf"))) as {
      images: { id: string; zRangeMM?: number }[];
    };
    expect(file.images[0].zRangeMM).toBe(12.5);

    // Reopen into a clean registry entry and confirm the meaning came back.
    const reopened = { ...file.images[0], id: `${file.images[0].id}-copy` } as never;
    registerEmbeddedImage(reopened);
    expect(heightfieldMeta(`${file.images[0].id}-copy`)?.zRangeMM).toBe(12.5);

    const fresh = new CADDocument({ width: 100, height: 100 });
    applyFile(fresh, file as never);
    expect(fresh.entities.some((e) => e instanceof RasterImageEntity)).toBe(true);
  });

  test("a photograph gains no zRangeMM field at all", () => {
    // Otherwise every existing file picks up a diff on its next save.
    const id = registerGrey("pic", 2, 2, new Uint8Array([1, 2, 3, 4]));
    const doc = new CADDocument({ width: 100, height: 100 });
    doc.add(new RasterImageEntity(id, { x: 5, y: 5 }, 40, 40, 0));
    const file = serializeDoc(doc, "pic");
    expect(Object.keys(file.images![0])).not.toContain("zRangeMM");
  });
});

describe("the model's own height becomes the toolpath's default depth", () => {
  test("a relief op on an imported model is pre-filled with its true height", () => {
    // Removes the transcription step: an STL knows how tall it is, and a typo
    // when copying that figure carves the model squashed, silently.
    const id = registerHeightfield("dome", 2, 2, new Uint8Array([0, 90, 180, 255]), {
      zRangeMM: 17.25,
    });
    const doc = new CADDocument({ width: 100, height: 100 });
    const img = doc.add(new RasterImageEntity(id, { x: 0, y: 0 }, 40, 40, 0));
    expect(createInitialOpState(null, doc, [img]).depth).toBeCloseTo(-17.25, 6);
  });

  test("a roughing and a finishing pass therefore start in agreement", () => {
    const id = registerHeightfield("dome2", 2, 2, new Uint8Array([0, 90, 180, 255]), {
      zRangeMM: 9.5,
    });
    const doc = new CADDocument({ width: 100, height: 100 });
    const img = doc.add(new RasterImageEntity(id, { x: 0, y: 0 }, 40, 40, 0));
    const a = createInitialOpState(null, doc, [img]).depth;
    const b = createInitialOpState(null, doc, [img]).depth;
    expect(a).toBe(b); // the same figure, read from the image both times
    expect(a).toBeCloseTo(-9.5, 6);
  });

  test("an ordinary photograph keeps the generic default (positive control)", () => {
    const id = registerGrey("photo2", 2, 2, new Uint8Array([11, 22, 33, 44]));
    const doc = new CADDocument({ width: 100, height: 100 });
    const img = doc.add(new RasterImageEntity(id, { x: 0, y: 0 }, 40, 40, 0));
    expect(createInitialOpState(null, doc, [img]).depth).toBe(DEFAULTS.depth);
  });

  test("an existing op's depth is never overwritten", () => {
    // Editing a toolpath must not silently reset a depth the user chose.
    const id = registerHeightfield("dome3", 2, 2, new Uint8Array([0, 90, 180, 255]), {
      zRangeMM: 12,
    });
    const doc = new CADDocument({ width: 100, height: 100 });
    const img = doc.add(new RasterImageEntity(id, { x: 0, y: 0 }, 40, 40, 0));
    const existing = op({ entityIds: [img.id], depth: -4 });
    expect(createInitialOpState(existing, doc, [img]).depth).toBe(-4);
  });
});
