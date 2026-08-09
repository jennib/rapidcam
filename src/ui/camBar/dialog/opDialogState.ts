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
import type { DitherMode } from "../../../cam/dither";
import { type Entity, RasterImageEntity } from "../../../model/entities";
import type { Vec2 } from "../../../core/vec2";
import {
  type OpCombo,
  autoName,
  comboOf,
  defaultCombo,
  legacyPocketSeeds,
  seedsFromRegions,
} from "../../camBarHelpers";

export type CornerStyle = "none" | "dogbone" | "tbone";

export interface OpState {
  name: string;
  combo: OpCombo;
  toolId?: string;
  toolType: ToolType;
  toolNumber: number;
  diameter: number;
  vAngle: number;
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

export function createInitialOpState(
  existing: CAMOperation | null,
  doc: CADDocument,
  preSelectedEnts: Entity[],
): OpState {
  const isLaser = doc.isLaser;
  const preSelected = new Set(preSelectedEnts.map((e) => e.id));
  // initialCombo picks the starting op type (and defaults an image selection to
  // Engrave so it isn't stripped as invalid-for-profile — see defaultCombo).
  const initialCombo: OpCombo = defaultCombo(existing, preSelectedEnts, isLaser);

  return {
    name: existing?.name ?? autoOpName(initialCombo, doc),
    combo: initialCombo,
    toolId: existing?.toolId,
    // A mill relief (engrave targeting an image) needs a depth-shaping bit, so a
    // new one defaults to a ball-nose rather than the flat end mill (which carves
    // nothing). Done here at state init so the tool selector reflects it on open.
    toolType: (existing?.toolType ??
      (!isLaser &&
      initialCombo === "engrave" &&
      preSelectedEnts.some((e) => e instanceof RasterImageEntity)
        ? "ball-nose"
        : DEFAULTS.toolType)) as ToolType,
    toolNumber: existing?.toolNumber ?? DEFAULTS.toolNumber,
    diameter: existing?.diameter ?? DEFAULTS.diameter,
    vAngle: existing?.vAngle ?? DEFAULTS.vAngle,
    tipAngle: existing?.tipAngle ?? DEFAULTS.tipAngle,
    feedrate: existing?.feedrate ?? DEFAULTS.feedrate,
    plungeRate: existing?.plungeRate ?? DEFAULTS.plungeRate,
    spindleSpeed: existing?.spindleSpeed ?? DEFAULTS.spindleSpeed,
    safeZ: existing?.safeZ ?? DEFAULTS.safeZ,
    depth: existing?.depth ?? DEFAULTS.depth,
    stepdown: existing?.stepdown ?? DEFAULTS.stepdown,
    peckDepth: existing?.peckDepth ?? DEFAULTS.peckDepth,
    pocketBoundaryMode: (existing?.regions?.length ? "regions" : "entities") as
      | "regions"
      | "entities",
    finishPass: existing?.finishPass ?? false,
    finishAllowance: existing?.finishAllowance ?? DEFAULTS.finishAllowance,
    restToolDiameter: existing?.restToolDiameter ?? 0,
    faceTarget: existing?.faceTarget ?? "stock",
    faceOverhang: existing?.faceOverhang ?? 0,
    faceDirection: existing?.faceDirection ?? "x",
    chamferWidth: existing?.chamferWidth ?? DEFAULTS.chamferWidth,
    chamferSide: (existing?.chamferSide ?? DEFAULTS.chamferSide) as ChamferSide,
    sharpenCorners: existing?.sharpenCorners ?? false,
    vStep: existing?.vStep ?? DEFAULTS.vStep,
    vHopClearance: existing?.vHopClearance ?? 0,
    coolant: (existing?.coolant ?? DEFAULTS.coolant) as CoolantMode,
    entityIds: new Set<string>(existing?.entityIds ?? [...preSelected]),
    islandIds: new Set<string>(existing?.islandIds ?? []),
    followPattern: existing?.followPattern ?? true,
    face: (existing?.face === "bottom" ? "bottom" : "top") as "top" | "bottom",
    regionSeeds: existing?.regions?.length
      ? seedsFromRegions(doc, existing.regions)
      : existing && comboOf(existing) === "pocket"
        ? legacyPocketSeeds(existing, doc)
        : ([] as Vec2[]),
    tabsEnabled: existing?.tabs?.enabled ?? false,
    tabStrategy: (existing?.tabs?.strategy ?? "count") as "count" | "spacing",
    tabCount: existing?.tabs?.count ?? 4,
    tabSpacing: existing?.tabs?.spacing ?? 40,
    tabWidth: existing?.tabs?.width ?? 4,
    tabHeight: existing?.tabs?.height ?? 2,
    stepover: existing?.stepover ?? DEFAULTS.stepover,
    cornerStyle: (existing?.cornerStyle ?? "none") as CornerStyle,
    // New profiles default to climb (best on rigid CNC); an existing profile
    // without the field defaults to whatever its raw winding already cuts, so
    // re-applying an old op doesn't silently flip its direction.
    cutDirection:
      existing?.cutDirection ?? (existing?.side === "outside" ? "conventional" : "climb"),
    rampAngle: existing?.rampAngle,
    pocketStrategy: (existing?.pocketStrategy ?? "offset") as "offset" | "adaptive" | "raster",
    leadInType: (existing?.leadIn?.type ?? "none") as LeadType,
    leadInLen: existing?.leadIn?.length ?? 2,
    leadOutType: (existing?.leadOut?.type ?? "none") as LeadType,
    leadOutLen: existing?.leadOut?.length ?? 2,
    // A score/fold marks the surface, not through it — seed a low default power
    // for a new one (a full-power score would burn through the fold line).
    laserPower: existing?.laserPower ?? (initialCombo === "score" ? 15 : DEFAULTS.laserPower),
    laserPasses: existing?.laserPasses ?? DEFAULTS.laserPasses,
    kerfWidth: existing?.kerfWidth ?? DEFAULTS.kerfWidth,
    laserFill: existing?.laserFill ?? false,
    laserFillSpacing: existing?.laserFillSpacing ?? DEFAULTS.laserFillSpacing,
    laserOverscan: existing?.laserOverscan ?? DEFAULTS.laserOverscan,
    airAssist: existing?.airAssist ?? false,
    laserOverride: existing?.laserOverride ?? false,
    // Laser wants a fine line interval (≈ beam width); a mill relief's stepover
    // scales with the bit — ~10% of the cutter diameter is a good scallop/speed
    // balance (a fixed fine value is a needlessly long cut with a wide bit).
    rasterLineInterval:
      existing?.rasterLineInterval ??
      (isLaser
        ? DEFAULTS.rasterLineInterval
        : Math.max(0.05, (existing?.diameter ?? DEFAULTS.diameter) * 0.1)),
    rasterDotPitch: existing?.rasterDotPitch ?? 0,
    rasterMinPower: existing?.rasterMinPower ?? DEFAULTS.rasterMinPower,
    rasterInvert: existing?.rasterInvert ?? false,
    rasterDither: existing?.rasterDither ?? "none",
    reliefGamma: existing?.reliefGamma ?? 1,
    paramExprs: existing?.paramExprs ? { ...existing.paramExprs } : {},
  };
}

export class OpDialogEvents {
  private updateVBitHintListeners: Array<() => void> = [];
  private setToolTypeListeners: Array<(t: ToolType) => void> = [];
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
