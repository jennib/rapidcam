import type { Unit } from "../core/units";
import type { CADDocument, DocSnapshot } from "../model/document";

export interface RcamFile {
  version: 1;
  name: string;
  canvas: { width: number; height: number };
  displayUnit: string;
  stockThickness?: number;
  hasToolChanger?: boolean;
  origin?: { x: string; y: string; z: string };
  entities: unknown[];
  constraints: unknown[];
  dimensions: unknown[];
  isConstructionMode: boolean;
  selectedPoints: unknown[];
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
  return {
    version: 1,
    name,
    canvas: { ...doc.canvas },
    displayUnit: doc.displayUnit,
    stockThickness: doc.stockThickness,
    hasToolChanger: doc.hasToolChanger,
    origin: { x: doc.origin.x, y: doc.origin.y, z: doc.origin.z },
    entities: snap.entities as unknown[],
    constraints: snap.constraints as unknown[],
    dimensions: snap.dimensions as unknown[],
    isConstructionMode: snap.isConstructionMode,
    selectedPoints: snap.selectedPoints as unknown[],
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

export function applyFile(doc: CADDocument, file: RcamFile): void {
  doc.canvas = { ...file.canvas };
  doc.displayUnit = file.displayUnit as Unit;
  if (file.stockThickness !== undefined) doc.stockThickness = file.stockThickness;
  if (file.hasToolChanger !== undefined) doc.hasToolChanger = file.hasToolChanger;
  if (file.origin !== undefined) {
    doc.origin = {
      x: (file.origin.x as import("../model/document").OriginX) ?? "left",
      y: (file.origin.y as import("../model/document").OriginY) ?? "front",
      z: (file.origin.z as import("../model/document").OriginZ) ?? "top",
    };
  }
  doc.restore(file as unknown as DocSnapshot);
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
      const file = JSON.parse(text) as RcamFile;
      if (file.version !== 1) throw new Error("Unsupported file version");
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
          const file = JSON.parse(reader.result as string) as RcamFile;
          if (file.version !== 1) throw new Error("Unsupported file version");
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
