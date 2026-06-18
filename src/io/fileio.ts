import type { Unit } from "../core/units";
import type { CADDocument, DocSnapshot } from "../model/document";
import { TextEntity } from "../model/entities";
import {
  collectEmbeddedFonts,
  registerEmbeddedFont,
  type EmbeddedFont,
} from "../core/fontManager";

export const RCAM_VERSION = 2 as const;

export interface RcamFile {
  version: typeof RCAM_VERSION;
  name: string;
  canvas: { width: number; height: number };
  displayUnit: string;
  stockThickness?: number;
  hasToolChanger?: boolean;
  origin?: { x: string; y: string; z: string };
  postProcessor?: string;
  groups?: unknown[];
  layers?: unknown[];
  activeLayerId?: string;
  entities: unknown[];
  constraints: unknown[];
  dimensions: unknown[];
  variables?: unknown[];
  patterns?: unknown[];
  operations?: unknown[];
  tools?: unknown[];
  /** Non-bundled fonts referenced by text entities, embedded so the file cuts
   *  identically on any machine. Bundled fonts resolve by id and are omitted. */
  fonts?: EmbeddedFont[];
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

const RECENTS_KEY = "rcam-recents";
const MAX_RECENTS = 5;

export function getRecents(): RecentEntry[] {
  try {
    return JSON.parse(localStorage.getItem(RECENTS_KEY) ?? "[]");
  } catch {
    return [];
  }
}

export function pushRecent(entry: RecentEntry): void {
  const list = getRecents().filter((r) => r.name !== entry.name);
  list.unshift(entry);
  localStorage.setItem(RECENTS_KEY, JSON.stringify(list.slice(0, MAX_RECENTS)));
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
  // The file describes a design, not an editor session: drop the transient
  // `selected` flag from every entity (selection/mode are not persisted).
  const entities = snap.entities.map(({ selected: _s, ...rest }) => rest);
  return {
    version: RCAM_VERSION,
    name,
    canvas: { ...doc.canvas },
    displayUnit: doc.displayUnit,
    stockThickness: doc.stockThickness,
    hasToolChanger: doc.hasToolChanger,
    origin: { x: doc.origin.x, y: doc.origin.y, z: doc.origin.z },
    postProcessor: doc.postProcessor,
    groups: snap.groups as unknown[],
    layers: snap.layers as unknown[],
    activeLayerId: snap.activeLayerId,
    entities: entities as unknown[],
    constraints: snap.constraints as unknown[],
    dimensions: snap.dimensions as unknown[],
    variables: snap.variables as unknown[],
    patterns: snap.patterns as unknown[],
    operations: snap.operations as unknown[],
    tools: tools as unknown[],
    ...(fonts.length ? { fonts } : {}),
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
  // Register embedded fonts before restoring, so text entities resolve them.
  for (const f of file.fonts ?? []) registerEmbeddedFont(f);
  doc.displayUnit = file.displayUnit as Unit;
  // Build a DocSnapshot from the file, injecting empty selection/mode state —
  // those are not persisted, but doc.restore() expects them present.
  const snap: DocSnapshot = {
    entities: (file.entities ?? []) as DocSnapshot["entities"],
    constraints: (file.constraints ?? []) as DocSnapshot["constraints"],
    dimensions: (file.dimensions ?? []) as DocSnapshot["dimensions"],
    variables: file.variables as DocSnapshot["variables"],
    patterns: file.patterns as DocSnapshot["patterns"],
    operations: file.operations as DocSnapshot["operations"],
    tools: file.tools as DocSnapshot["tools"],
    groups: file.groups as DocSnapshot["groups"],
    layers: file.layers as DocSnapshot["layers"],
    activeLayerId: file.activeLayerId,
    canvas: file.canvas,
    stockThickness: file.stockThickness,
    hasToolChanger: file.hasToolChanger,
    origin: file.origin as DocSnapshot["origin"],
    postProcessor: file.postProcessor,
    isConstructionMode: false,
    selectedPoints: [],
    selectedConstraintId: null,
    selectedDimensionId: null,
  };
  doc.restore(snap);
}

export async function openFile(): Promise<{ name: string; file: RcamFile; handle?: FileSystemFileHandle } | null> {
  if ('showOpenFilePicker' in window) {
    try {
      const [handle] = await (window as any).showOpenFilePicker({
        types: [{
          description: 'RapidCAM Project (.rcam)',
          accept: {
            'application/json': ['.rcam'],
          }
        }]
      });
      const fileObj = await handle.getFile();
      const text = await fileObj.text();
      const file = parseRcam(text);
      const name = fileObj.name.replace(/\.rcam$/i, "");
      pushRecent({ name, savedAt: Date.now(), data: file });
      return { name, file, handle };
    } catch (e) {
      if ((e as Error).name === 'AbortError') return null;
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

    input.addEventListener("change", () => {
      const f = input.files?.[0];
      if (!f) { settle(null); return; }
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
      reader.readAsText(f);
    });

    // Detect picker cancellation via window focus regained
    window.addEventListener(
      "focus",
      () => setTimeout(() => settle(null), 300),
      { once: true },
    );

    input.click();
  });
}
