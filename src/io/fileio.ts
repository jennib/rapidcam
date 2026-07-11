import type { Unit } from "../core/units";
import type { CADDocument, DocSnapshot } from "../model/document";
import { TextEntity, RasterImageEntity } from "../model/entities";
import { collectEmbeddedFonts, registerEmbeddedFont, type EmbeddedFont } from "../core/fontManager";
import {
  collectEmbeddedImages,
  registerEmbeddedImage,
  type EmbeddedImage,
} from "../core/imageManager";
import { StorageKeys } from "../core/storageKeys";
import { reconcileLoadedPatterns } from "../model/patternEngine";

export const RCAM_VERSION = 2 as const;

export interface RcamFile {
  version: typeof RCAM_VERSION;
  name: string;
  canvas: { width: number; height: number };
  displayUnit: string;
  stockThickness?: number;
  /** Optional positioned flat stock within the work area (canvas). Omitted = fills the work area. */
  stockRect?: { x: number; y: number; width: number; height: number } | null;
  hasToolChanger?: boolean;
  origin?: { x: string; y: string; z: string };
  postProcessor?: string;
  /** Machine kind ("mill" | "laser"). Omitted/absent in old files = "mill". */
  machineKind?: string;
  /** Optional end-of-program park position (work coords, mm). Omitted when off. */
  endPosition?: { x: number; y: number } | null;
  toolChangePosition?: { x: number; y: number } | null;
  /** Optional double-sided (flip) machining setup. Omitted when single-sided. */
  flip?: {
    axis: "h" | "v";
    registration: "pins" | "none";
    pinDiameter: number;
    pinDepth: number;
    pins: { x: number; y: number }[];
  } | null;
  /** Optional cylindrical/rotary wrap setup. Omitted for flat work. */
  rotary?: {
    axisWord: "A" | "B";
    diameter: number;
    wrapAxis: "x" | "y";
    zero?: "surface" | "center";
    arcTolerance?: number;
  } | null;
  /** Optional job metadata (job/revision/notes). Omitted when all fields empty. */
  metadata?: { job?: string; revision?: string; notes?: string };
  groups?: unknown[];
  layers?: unknown[];
  activeLayerId?: string;
  entities: unknown[];
  constraints: unknown[];
  dimensions: unknown[];
  variables?: unknown[];
  bindings?: unknown[];
  patterns?: unknown[];
  operations?: unknown[];
  tools?: unknown[];
  /** Non-bundled fonts referenced by text entities, embedded so the file cuts
   *  identically on any machine. Bundled fonts resolve by id and are omitted. */
  fonts?: EmbeddedFont[];
  /** Greyscale pixels for image entities, embedded so a raster engrave reproduces
   *  anywhere. Stripped from the localStorage caches (recents/draft) — they're big. */
  images?: EmbeddedImage[];
}

/**
 * Strip blank/whitespace-only fields from a metadata object; returns the
 * trimmed object, or `null` when nothing meaningful remains (so callers can
 * omit the field entirely rather than persisting an empty `{}`).
 */
function cleanMetadata(
  m: { job?: string; revision?: string; notes?: string } | undefined,
): { job?: string; revision?: string; notes?: string } | null {
  if (!m) return null;
  const out: { job?: string; revision?: string; notes?: string } = {};
  for (const k of ["job", "revision", "notes"] as const) {
    const v = m[k]?.trim();
    if (v) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Upgrade a legacy v1 file (the old "serialized session snapshot" shape) to v2:
 * drop transient editor state (`isConstructionMode`, the `selected*` fields, and
 * each entity's `selected` flag). v1 had no embedded fonts, so none are added.
 */
export function migrateV1ToV2(old: Record<string, unknown>): RcamFile {
  const {
    isConstructionMode: _m,
    selectedPoints: _sp,
    selectedConstraintId: _sc,
    selectedDimensionId: _sd,
    version: _v,
    entities,
    ...rest
  } = old as Record<string, unknown> & { entities?: Record<string, unknown>[] };
  return {
    ...(rest as object),
    version: RCAM_VERSION,
    entities: (entities ?? []).map(({ selected: _s, ...keep }) => keep),
  } as RcamFile;
}

/** Parse raw .rcam text into a current-version file, migrating older versions. */
export function parseRcam(text: string): RcamFile {
  return normalizeRcam(JSON.parse(text));
}

/** Coerce a parsed object to the current version, migrating v1. Throws otherwise. */
export function normalizeRcam(raw: unknown): RcamFile {
  const v = (raw as { version?: unknown }).version;
  if (v === RCAM_VERSION) return raw as RcamFile;
  if (v === 1) return migrateV1ToV2(raw as Record<string, unknown>);
  throw new Error(`Unsupported .rcam version: ${String(v)}`);
}

export interface RecentEntry {
  name: string;
  savedAt: number;
  data: RcamFile;
}

const RECENTS_KEY = StorageKeys.recents;
const MAX_RECENTS = 5;

export function getRecents(): RecentEntry[] {
  try {
    return JSON.parse(localStorage.getItem(RECENTS_KEY) ?? "[]");
  } catch {
    return [];
  }
}

/**
 * localStorage.setItem that never throws — e.g. on QuotaExceededError. Returns
 * whether the write succeeded. localStorage is the wrong home for large blobs;
 * callers must treat a `false` as "cache skipped", never as a hard failure.
 */
export function trySetItem(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (e) {
    console.warn(`[storage] could not write "${key}" (quota exceeded?):`, e);
    return false;
  }
}

/**
 * Strip embedded font bytes from a file before it goes into a localStorage-backed
 * cache (recents, autosave draft). The font registry already holds them for the
 * current session, and the durable home for font bytes is the .rcam file on disk —
 * so caching MB-sized base64 here would only risk blowing the localStorage quota.
 * After a full browser restart a restored cache may reference an unloaded font;
 * that surfaces as the missing-font warning rather than silent breakage.
 */
export function stripEmbeddedFonts(file: RcamFile): RcamFile {
  if (!file.fonts && !file.images) return file;
  const { fonts: _drop, images: _drop2, ...rest } = file;
  return rest;
}

export function pushRecent(entry: RecentEntry): void {
  const light: RecentEntry = { ...entry, data: stripEmbeddedFonts(entry.data) };
  let list = getRecents().filter((r) => r.name !== light.name);
  list.unshift(light);
  list = list.slice(0, MAX_RECENTS);
  // Recents are a convenience cache: if the list still won't fit, drop the oldest
  // entries until it does — never throw out of a save/open.
  while (list.length > 0 && !trySetItem(RECENTS_KEY, JSON.stringify(list))) {
    list.pop();
  }
}

export function serializeDoc(doc: CADDocument, name: string): RcamFile {
  const snap = doc.snapshot();
  // Only persist tools actually referenced by an operation, so tools the user
  // forked away from don't linger in the saved file.
  const usedToolIds = new Set(doc.operations.map((op) => op.toolId).filter(Boolean));
  const tools = (snap.tools ?? []).filter((t) => usedToolIds.has(t.id));
  // Embed the (non-bundled) fonts any text entity references, so the file
  // reproduces its glyph outlines — and therefore its toolpaths — anywhere.
  const fontIds = doc.entities
    .filter((e): e is TextEntity => e instanceof TextEntity)
    .map((e) => e.fontId);
  const fonts = collectEmbeddedFonts(fontIds);
  // Embed the greyscale pixels of any image entity so a raster engrave reproduces
  // on another machine.
  const imageIds = doc.entities
    .filter((e): e is RasterImageEntity => e instanceof RasterImageEntity)
    .map((e) => e.imageId);
  const images = collectEmbeddedImages(imageIds);
  // The file describes a design, not an editor session: drop the transient
  // `selected` flag from every entity (selection/mode are not persisted).
  const entities = snap.entities.map(({ selected: _s, ...rest }) => rest);
  return {
    version: RCAM_VERSION,
    name,
    canvas: { ...doc.canvas },
    displayUnit: doc.displayUnit,
    stockThickness: doc.stockThickness,
    ...(doc.stockRect ? { stockRect: { ...doc.stockRect } } : {}),
    hasToolChanger: doc.hasToolChanger,
    origin: { x: doc.origin.x, y: doc.origin.y, z: doc.origin.z },
    postProcessor: doc.postProcessor,
    ...(doc.machineKind !== "mill" ? { machineKind: doc.machineKind } : {}),
    ...(doc.endPosition ? { endPosition: { ...doc.endPosition } } : {}),
    ...(doc.toolChangePosition ? { toolChangePosition: { ...doc.toolChangePosition } } : {}),
    ...(doc.flip ? { flip: { ...doc.flip, pins: doc.flip.pins.map((p) => ({ ...p })) } } : {}),
    ...(doc.rotary ? { rotary: { ...doc.rotary } } : {}),
    ...(cleanMetadata(doc.metadata) ? { metadata: cleanMetadata(doc.metadata)! } : {}),
    groups: snap.groups as unknown[],
    layers: snap.layers as unknown[],
    activeLayerId: snap.activeLayerId,
    entities: entities as unknown[],
    constraints: snap.constraints as unknown[],
    dimensions: snap.dimensions as unknown[],
    variables: snap.variables as unknown[],
    bindings: snap.bindings as unknown[],
    patterns: snap.patterns as unknown[],
    operations: snap.operations as unknown[],
    tools: tools as unknown[],
    ...(fonts.length ? { fonts } : {}),
    ...(images.length ? { images } : {}),
  };
}

export function saveFile(doc: CADDocument, name: string): void {
  const file = serializeDoc(doc, name);
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name.endsWith(".rcam") ? name : `${name}.rcam`;
  a.click();
  URL.revokeObjectURL(url);
  pushRecent({ name, savedAt: Date.now(), data: file });
}

export function applyFile(doc: CADDocument, fileIn: RcamFile): void {
  // Tolerate legacy v1 files arriving via recents/autosave drafts.
  const file = normalizeRcam(fileIn);
  // Register embedded fonts/images before restoring, so text & image entities
  // resolve their glyphs/pixels.
  for (const f of file.fonts ?? []) registerEmbeddedFont(f);
  for (const img of file.images ?? []) registerEmbeddedImage(img);
  doc.displayUnit = file.displayUnit as Unit;
  // Build a DocSnapshot from the file, injecting empty selection/mode state —
  // those are not persisted, but doc.restore() expects them present.
  const snap: DocSnapshot = {
    entities: (file.entities ?? []) as DocSnapshot["entities"],
    constraints: (file.constraints ?? []) as DocSnapshot["constraints"],
    dimensions: (file.dimensions ?? []) as DocSnapshot["dimensions"],
    variables: file.variables as DocSnapshot["variables"],
    bindings: file.bindings as DocSnapshot["bindings"],
    patterns: file.patterns as DocSnapshot["patterns"],
    operations: file.operations as DocSnapshot["operations"],
    tools: file.tools as DocSnapshot["tools"],
    groups: file.groups as DocSnapshot["groups"],
    layers: file.layers as DocSnapshot["layers"],
    activeLayerId: file.activeLayerId,
    canvas: file.canvas,
    stockThickness: file.stockThickness,
    stockRect: file.stockRect ?? null,
    hasToolChanger: file.hasToolChanger,
    origin: file.origin as DocSnapshot["origin"],
    postProcessor: file.postProcessor,
    machineKind: file.machineKind as DocSnapshot["machineKind"],
    endPosition: file.endPosition ?? null,
    toolChangePosition: file.toolChangePosition ?? null,
    flip: file.flip ?? null,
    rotary: file.rotary ?? null,
    metadata: cleanMetadata(file.metadata) ?? {},
    isConstructionMode: false,
    selectedPoints: [],
    selectedConstraintId: null,
    selectedDimensionId: null,
  };
  doc.restore(snap);
  // Reconcile any pattern whose stored instances don't match the count its
  // (expression-driven) params resolve to — so a hand- or AI-authored file with
  // mismatched instanceIds self-corrects on open. Resolution reads the loaded
  // variable values (no re-evaluation, so stored dimension values are preserved).
  reconcileLoadedPatterns(doc);
}

export async function openFile(): Promise<{
  name: string;
  file: RcamFile;
  handle?: FileSystemFileHandle;
} | null> {
  if ("showOpenFilePicker" in window) {
    try {
      const [handle] = await (window as any).showOpenFilePicker({
        types: [
          {
            description: "RapidCAM Project (.rcam)",
            accept: {
              "application/json": [".rcam"],
            },
          },
        ],
      });
      const fileObj = await handle.getFile();
      const text = await fileObj.text();
      const file = parseRcam(text);
      const name = fileObj.name.replace(/\.rcam$/i, "");
      pushRecent({ name, savedAt: Date.now(), data: file });
      return { name, file, handle };
    } catch (e) {
      if ((e as Error).name === "AbortError") return null;
    }
  }

  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".rcam,application/json";

    let settled = false;
    const settle = (v: { name: string; file: RcamFile } | null) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };

    // `cancel` fires when the picker is dismissed with no selection. Every
    // browser that lacks showOpenFilePicker — and therefore reaches this
    // fallback — supports it (Firefox 109+, Safari 16.4+). It replaces an older
    // focus+300ms-timeout heuristic that raced the file read: a real selection
    // whose read outran the timer was silently dropped, a risk that grew once
    // v2 files embed fonts and take longer to read.
    input.addEventListener("cancel", () => settle(null));

    input.addEventListener("change", () => {
      const f = input.files?.[0];
      if (!f) {
        settle(null);
        return;
      }
      const name = f.name.replace(/\.rcam$/i, "");
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const file = parseRcam(reader.result as string);
          pushRecent({ name, savedAt: Date.now(), data: file });
          settle({ name, file });
        } catch {
          alert("Could not open file — not a valid .rcam file.");
          settle(null);
        }
      };
      reader.onerror = () => {
        alert("Could not read the file.");
        settle(null);
      };
      reader.readAsText(f);
    });

    input.click();
  });
}
