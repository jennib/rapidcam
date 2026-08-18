/**
 * Form state definition and event coordination for the Add/Edit Toolpath dialog.
 * Replaces loose late-bound DialogHooks with typed event management and cohesive OpState.
 */
import type { CADDocument } from "../../../model/document";
import type {
  CAMOperation,
  ChamferSide,
  CoolantMode,
  LeadType,
  ToolType,
} from "../../../cam/types";
import { DEFAULTS } from "../../../cam/types";
import { FINISH_STEPOVER_FRACTION } from "../../../cam/scallop";
import type { DitherMode } from "../../../cam/dither";
import { type Entity, RasterImageEntity } from "../../../model/entities";
import { heightfieldMeta } from "../../../core/imageManager";
import type { Vec2 } from "../../../core/vec2";
import { findReliefPair } from "../../../cam/reliefOps";
import {
  type OpCombo,
  autoName,
  comboOf,
  defaultCombo,
  legacyPocketSeeds,
  seedsFromRegions,
} from "../../camBarHelpers";

export type CornerStyle = "none" | "dogbone" | "tbone";

/** The tool half of a dialog stage: the fields `buildToolSection` reads/writes. */
export interface ToolState {
  toolId?: string;
  toolType: ToolType;
  toolNumber: number;
  diameter: number;
  vAngle: number;
  tipDiameter: number;
  tipAngle: number;
  feedrate: number;
  plungeRate: number;
  spindleSpeed: number;
  safeZ: number;
  /** Parametric formulas keyed by field name (empty = plain numbers). */
  paramExprs: Record<string, string>;
}

/** The roughing half of a relief job: its own tool plus its own cut fields. */
export interface RoughStageState extends ToolState {
  stepdown: number;
  stepover: number;
  finishAllowance: number;
  rampAngle?: number;
}

export interface OpState {
  name: string;
  combo: OpCombo;
  toolId?: string;
  toolType: ToolType;
  toolNumber: number;
  diameter: number;
  vAngle: number;
  tipDiameter: number;
  tipAngle: number;
  feedrate: number;
  plungeRate: number;
  spindleSpeed: number;
  safeZ: number;
  depth: number;
  stepdown: number;
  peckDepth: number;
  pocketBoundaryMode: "regions" | "entities";
  finishPass: boolean;
  finishAllowance: number;
  /** Rest machining: diameter of the tool that already roughed this pocket. 0 = off. */
  restToolDiameter: number;
  /** Facing: what gets skimmed. */
  faceTarget: "stock" | "bed";
  /** Facing: extra travel past the target's edge, mm (on top of the tool radius). */
  faceOverhang: number;
  /** Facing: which way the rows run. */
  faceDirection: "x" | "y";
  chamferWidth: number;
  chamferSide: ChamferSide;
  sharpenCorners: boolean;
  vStep: number;
  vHopClearance: number;
  coolant: CoolantMode;
  entityIds: Set<string>;
  islandIds: Set<string>;
  followPattern: boolean;
  face: "top" | "bottom";
  regionSeeds: Vec2[];
  tabsEnabled: boolean;
  tabStrategy: "count" | "spacing";
  tabCount: number;
  tabSpacing: number;
  tabWidth: number;
  tabHeight: number;
  stepover: number;
  cornerStyle: CornerStyle;
  cutDirection: "climb" | "conventional";
  rampAngle?: number;
  pocketStrategy: "offset" | "adaptive" | "raster";
  leadInType: LeadType;
  leadInLen: number;
  leadOutType: LeadType;
  leadOutLen: number;
  // laser (machineKind === "laser")
  laserPower: number;
  laserPasses: number;
  kerfWidth: number;
  laserFill: boolean;
  laserFillSpacing: number;
  laserOverscan: number;
  airAssist: boolean;
  laserOverride: boolean;
  // raster engrave (engrave op targeting an image entity)
  rasterLineInterval: number;
  rasterDotPitch: number;
  rasterMinPower: number;
  rasterInvert: boolean;
  rasterDither: DitherMode;
  reliefGamma: number;
  // V-carve halftone (a relief finish pass with a V-bit): screen the photo as
  // grooves whose width carries the tone. Row pitch is derived, not typed.
  halftone: boolean;
  halftoneLand: number;
  reliefSteepPass: boolean;
  /** The roughing stage of a relief job (null unless combo === "relief"). */
  reliefRough: RoughStageState | null;
  /** Whether the relief job writes a roughing pass. */
  includeRough: boolean;
  paramExprs: Record<string, string>;
}

/**
 * Delegates to {@link autoName} rather than keeping its own copy of the
 * combo-to-prefix table. There were two, and adding a toolpath type updated one
 * of them: a facing op arrived in the dialog named "Drill 1".
 */
export function autoOpName(combo: OpCombo, doc: CADDocument): string {
  return autoName(combo, doc);
}

/**
 * The carve depth an imported 3-D model already determines, or null.
 *
 * An STL knows how tall it is, so making the user read that figure off a toast
 * and retype it is a transcription step whose failure mode is silent: a typo
 * carves the model squashed, and nothing downstream can tell that apart from a
 * deliberate scaling. The height range travels with the image (see
 * `registerHeightfield`), so the dialog reads it instead of asking.
 *
 * It is a DEFAULT, not a constraint — deliberately carving a 25 mm model 6 mm
 * deep into thin stock is ordinary practice, so the field stays editable. The
 * value being shared by the roughing and finishing passes is also what makes them
 * agree by construction rather than by the operator remembering to match them
 * (see the `relief-pass-mismatch` lint).
 */
function modelDepth(ents: Entity[]): number | null {
  for (const e of ents) {
    if (!(e instanceof RasterImageEntity)) continue;
    const meta = heightfieldMeta(e.imageId);
    if (meta && meta.zRangeMM > 0) return -meta.zRangeMM; // depth is negative
  }
  return null;
}

export function createInitialOpState(
  existing: CAMOperation | null,
  doc: CADDocument,
  preSelectedEnts: Entity[],
): OpState {
  const isLaser = doc.isLaser;
  const preSelected = new Set(preSelectedEnts.map((e) => e.id));
  // initialCombo picks the starting op type (and defaults an image selection to
  // Engrave so it isn't stripped as invalid-for-profile — see defaultCombo).
  const initialCombo: OpCombo = defaultCombo(existing, preSelectedEnts, isLaser, doc);

  // Editing a relief edits BOTH its ops. The top-level fields below carry the
  // FINISH (the engrave); `reliefRough` carries the roughing stage. When a relief
  // is clicked via its roughing row, `existing` is the rough and the finish is
  // its pair (and vice versa).
  const isRelief = initialCombo === "relief";
  const finish: CAMOperation | null =
    isRelief && existing ? (existing.type === "engrave" ? existing : findReliefPair(existing, doc)) : existing;
  const rough: CAMOperation | null =
    isRelief && existing ? (existing.type === "relief-rough" ? existing : findReliefPair(existing, doc)) : null;

  return {
    name: finish?.name ?? autoOpName(initialCombo, doc),
    combo: initialCombo,
    toolId: finish?.toolId,
    // A relief finish needs a depth-shaping bit, so a new one defaults to a
    // ball-nose rather than the flat end mill (which carves nothing). Done here
    // so the tool selector reflects it on open.
    toolType: (finish?.toolType ??
      (!isLaser &&
      (initialCombo === "engrave" || initialCombo === "relief") &&
      preSelectedEnts.some((e) => e instanceof RasterImageEntity)
        ? "ball-nose"
        : DEFAULTS.toolType)) as ToolType,
    toolNumber: finish?.toolNumber ?? DEFAULTS.toolNumber,
    diameter: finish?.diameter ?? DEFAULTS.diameter,
    vAngle: finish?.vAngle ?? DEFAULTS.vAngle,
    tipDiameter: finish?.tipDiameter ?? DEFAULTS.tipDiameter,
    tipAngle: finish?.tipAngle ?? DEFAULTS.tipAngle,
    feedrate: finish?.feedrate ?? DEFAULTS.feedrate,
    plungeRate: finish?.plungeRate ?? DEFAULTS.plungeRate,
    spindleSpeed: finish?.spindleSpeed ?? DEFAULTS.spindleSpeed,
    safeZ: finish?.safeZ ?? DEFAULTS.safeZ,
    depth: finish?.depth ?? modelDepth(preSelectedEnts) ?? DEFAULTS.depth,
    stepdown: finish?.stepdown ?? DEFAULTS.stepdown,
    peckDepth: finish?.peckDepth ?? DEFAULTS.peckDepth,
    pocketBoundaryMode: (finish?.regions?.length ? "regions" : "entities") as
      | "regions"
      | "entities",
    finishPass: finish?.finishPass ?? false,
    finishAllowance: finish?.finishAllowance ?? DEFAULTS.finishAllowance,
    restToolDiameter: finish?.restToolDiameter ?? 0,
    faceTarget: finish?.faceTarget ?? "stock",
    faceOverhang: finish?.faceOverhang ?? 0,
    faceDirection: finish?.faceDirection ?? "x",
    chamferWidth: finish?.chamferWidth ?? DEFAULTS.chamferWidth,
    chamferSide: (finish?.chamferSide ?? DEFAULTS.chamferSide) as ChamferSide,
    sharpenCorners: finish?.sharpenCorners ?? false,
    vStep: finish?.vStep ?? DEFAULTS.vStep,
    vHopClearance: finish?.vHopClearance ?? 0,
    coolant: (finish?.coolant ?? DEFAULTS.coolant) as CoolantMode,
    entityIds: new Set<string>(finish?.entityIds ?? [...preSelected]),
    islandIds: new Set<string>(finish?.islandIds ?? []),
    followPattern: finish?.followPattern ?? true,
    face: (finish?.face === "bottom" ? "bottom" : "top") as "top" | "bottom",
    regionSeeds: finish?.regions?.length
      ? seedsFromRegions(doc, finish.regions)
      : finish && comboOf(finish, doc) === "pocket"
        ? legacyPocketSeeds(finish, doc)
        : ([] as Vec2[]),
    tabsEnabled: finish?.tabs?.enabled ?? false,
    tabStrategy: (finish?.tabs?.strategy ?? "count") as "count" | "spacing",
    tabCount: finish?.tabs?.count ?? 4,
    tabSpacing: finish?.tabs?.spacing ?? 40,
    tabWidth: finish?.tabs?.width ?? 4,
    tabHeight: finish?.tabs?.height ?? 2,
    stepover: finish?.stepover ?? DEFAULTS.stepover,
    cornerStyle: (finish?.cornerStyle ?? "none") as CornerStyle,
    // New profiles default to climb (best on rigid CNC); an existing profile
    // without the field defaults to whatever its raw winding already cuts, so
    // re-applying an old op doesn't silently flip its direction.
    cutDirection:
      finish?.cutDirection ?? (finish?.side === "outside" ? "conventional" : "climb"),
    rampAngle: finish?.rampAngle,
    pocketStrategy: (finish?.pocketStrategy ?? "offset") as "offset" | "adaptive" | "raster",
    leadInType: (finish?.leadIn?.type ?? "none") as LeadType,
    leadInLen: finish?.leadIn?.length ?? 2,
    leadOutType: (finish?.leadOut?.type ?? "none") as LeadType,
    leadOutLen: finish?.leadOut?.length ?? 2,
    // A score/fold marks the surface, not through it — seed a low default power
    // for a new one (a full-power score would burn through the fold line).
    laserPower: finish?.laserPower ?? (initialCombo === "score" ? 15 : DEFAULTS.laserPower),
    laserPasses: finish?.laserPasses ?? DEFAULTS.laserPasses,
    kerfWidth: finish?.kerfWidth ?? DEFAULTS.kerfWidth,
    laserFill: finish?.laserFill ?? false,
    laserFillSpacing: finish?.laserFillSpacing ?? DEFAULTS.laserFillSpacing,
    laserOverscan: finish?.laserOverscan ?? DEFAULTS.laserOverscan,
    airAssist: finish?.airAssist ?? false,
    laserOverride: finish?.laserOverride ?? false,
    // Laser wants a fine line interval (≈ beam width); a mill relief's stepover
    // scales with the bit — Vectric's 8–12% of cutter diameter is the scallop/
    // speed balance (a fixed fine value is a needlessly long cut with a wide
    // bit). The fraction lives with the cusp calculator that reports on it.
    rasterLineInterval:
      finish?.rasterLineInterval ??
      (isLaser
        ? DEFAULTS.rasterLineInterval
        : Math.max(0.05, (finish?.diameter ?? DEFAULTS.diameter) * FINISH_STEPOVER_FRACTION)),
    rasterDotPitch: finish?.rasterDotPitch ?? 0,
    rasterMinPower: finish?.rasterMinPower ?? DEFAULTS.rasterMinPower,
    rasterInvert: finish?.rasterInvert ?? false,
    rasterDither: finish?.rasterDither ?? "none",
    reliefGamma: finish?.reliefGamma ?? 1,
    halftone: finish?.halftone ?? false,
    halftoneLand: finish?.halftoneLand ?? DEFAULTS.halftoneLand,
    reliefSteepPass: finish?.reliefSteepPass ?? false,
    // Always populate the rough stage: the type dropdown can switch TO relief
    // from any other type, and the section is built once against this object
    // (it is hidden for non-relief by `reliefRoughSection.update`). Opening as
    // relief carries the existing rough op's values; otherwise these are the
    // default rough tool's.
    reliefRough: {
      toolId: rough?.toolId,
      toolType: (rough?.toolType ?? "end-mill") as ToolType,
      // Derived from the FINISH tool, never from DEFAULTS, because both stages
      // defaulting to DEFAULTS is what made them collide. A relief job is two
      // physical tools, and `gcode.ts` emits a tool change only where
      // `toolNumber` differs — so two stages sharing T1 post a program that runs
      // the roughing pass with an end mill and continues straight into the
      // ball-nose finish with no pause and no warning. `checkMissingToolChange`
      // cannot catch it either: with one number there is no manual-change marker
      // to find.
      toolNumber: rough?.toolNumber ?? (finish?.toolNumber ?? DEFAULTS.toolNumber) + 1,
      // Twice the finisher. Roughing exists to move bulk, and a rougher the same
      // size as the finish tool also makes the stock model degenerate — the
      // opening it leaves is the one the finish would have cut anyway, so there
      // is nothing for the finish to skip. 2x matches the tier's own advice
      // (Easel pairs a 1/4in or 1/8in rougher with a 1/8in ball nose).
      diameter: rough?.diameter ?? (finish?.diameter ?? DEFAULTS.diameter) * 2,
      vAngle: rough?.vAngle ?? DEFAULTS.vAngle,
      tipDiameter: rough?.tipDiameter ?? DEFAULTS.tipDiameter,
      tipAngle: rough?.tipAngle ?? DEFAULTS.tipAngle,
      feedrate: rough?.feedrate ?? DEFAULTS.feedrate,
      plungeRate: rough?.plungeRate ?? DEFAULTS.plungeRate,
      spindleSpeed: rough?.spindleSpeed ?? DEFAULTS.spindleSpeed,
      safeZ: rough?.safeZ ?? DEFAULTS.safeZ,
      stepdown: rough?.stepdown ?? DEFAULTS.stepdown,
      stepover: rough?.stepover ?? DEFAULTS.stepover,
      finishAllowance: rough?.finishAllowance ?? DEFAULTS.finishAllowance,
      rampAngle: rough?.rampAngle,
      paramExprs: rough?.paramExprs ? { ...rough.paramExprs } : {},
    },
    // A new relief defaults to including the roughing pass; editing one reflects
    // whether a roughing op actually exists.
    includeRough: isRelief && (existing === null ? true : rough !== null),
    paramExprs: finish?.paramExprs ? { ...finish.paramExprs } : {},
  };
}

export class OpDialogEvents {
  private updateVBitHintListeners: Array<() => void> = [];
  private setToolTypeListeners: Array<(t: ToolType) => void> = [];
  private toolTypeChangedListeners: Array<(t: ToolType) => void> = [];
  private refreshBeamLayerListeners: Array<() => void> = [];

  public onUpdateVBitHint(fn: () => void): () => void {
    this.updateVBitHintListeners.push(fn);
    return () => {
      this.updateVBitHintListeners = this.updateVBitHintListeners.filter((l) => l !== fn);
    };
  }

  public emitUpdateVBitHint(): void {
    for (const fn of this.updateVBitHintListeners) fn();
  }

  public onSetToolType(fn: (t: ToolType) => void): () => void {
    this.setToolTypeListeners.push(fn);
    return () => {
      this.setToolTypeListeners = this.setToolTypeListeners.filter((l) => l !== fn);
    };
  }

  public emitSetToolType(t: ToolType): void {
    for (const fn of this.setToolTypeListeners) fn(t);
  }

  /**
   * The tool type HAS changed — the opposite direction to {@link onSetToolType},
   * which is a command asking for a change. Sections whose controls depend on the
   * loaded tool subscribe here: until this existed, a section could force a tool
   * (chamfer and v-carve both do) but nothing could react to the user picking one,
   * so a control gated on "is a V-bit loaded" stayed hidden forever.
   */
  public onToolTypeChanged(fn: (t: ToolType) => void): () => void {
    this.toolTypeChangedListeners.push(fn);
    return () => {
      this.toolTypeChangedListeners = this.toolTypeChangedListeners.filter((l) => l !== fn);
    };
  }

  public emitToolTypeChanged(t: ToolType): void {
    for (const fn of this.toolTypeChangedListeners) fn(t);
  }

  public onRefreshBeamLayer(fn: () => void): () => void {
    this.refreshBeamLayerListeners.push(fn);
    return () => {
      this.refreshBeamLayerListeners = this.refreshBeamLayerListeners.filter((l) => l !== fn);
    };
  }

  public emitRefreshBeamLayer(): void {
    for (const fn of this.refreshBeamLayerListeners) fn();
  }
}
